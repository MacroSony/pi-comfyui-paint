/**
 * ComfyUI HTTP API helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeComfyUrl } from "./config.js";
import type {
  ComfyUIQueueResult,
  ComfyUIHistoryOutput,
  ComfyUIUploadResult,
  DownloadedOutput,
} from "./types.js";

// ─── Generic fetch ───────────────────────────────────────────────────────────

export function buildComfyUrl(server: string, endpoint: string): string {
  const base = normalizeComfyUrl(server);
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${suffix}`;
}

export async function comfyFetch(
  server: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = buildComfyUrl(server, endpoint);
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`ComfyUI ${endpoint} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ─── Queue & Poll ────────────────────────────────────────────────────────────

export async function queuePrompt(
  server: string,
  workflow: Record<string, unknown>,
  clientId: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = JSON.stringify({ prompt: workflow, client_id: clientId });
  const result = (await comfyFetch(server, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  })) as ComfyUIQueueResult;
  return result.prompt_id;
}

export async function pollHistory(
  server: string,
  promptId: string,
  signal?: AbortSignal,
  maxWaitMs = 600_000,
  pollIntervalMs = 1000,
  onProgress?: (elapsedMs: number) => void,
  progressIntervalMs = 10_000,
): Promise<ComfyUIHistoryOutput> {
  const start = Date.now();
  let lastProgress = 0;
  while (Date.now() - start < maxWaitMs) {
    if (signal?.aborted) {
      throw new Error("Paint cancelled");
    }

    const history = (await comfyFetch(server, `/history/${promptId}`, { signal })) as ComfyUIHistoryOutput;
    if (history[promptId]) {
      return history;
    }

    const elapsed = Date.now() - start;
    if (onProgress && elapsed - lastProgress >= progressIntervalMs) {
      lastProgress = elapsed;
      onProgress(elapsed);
    }

    await abortableSleep(pollIntervalMs, signal);
  }
  throw new Error(`Timeout waiting for ComfyUI prompt ${promptId} after ${maxWaitMs}ms`);
}

// ─── Interrupt ───────────────────────────────────────────────────────────────

export async function interruptComfy(server: string): Promise<void> {
  const res = await fetch(buildComfyUrl(server, "/interrupt"), { method: "POST" });
  if (!res.ok) {
    throw new Error(`ComfyUI /interrupt returned ${res.status}: ${await res.text()}`);
  }
}

// ─── Execution errors ────────────────────────────────────────────────────────

/**
 * Extract the execution error from a finished history entry, if the prompt failed.
 * ComfyUI marks failed prompts with status.status_str === "error" and stores an
 * "execution_error" message carrying exception details.
 */
export function extractExecutionError(
  history: ComfyUIHistoryOutput,
  promptId: string,
): string | undefined {
  const entry = history[promptId];
  const status = entry?.status;
  if (!status || status.status_str !== "error") return undefined;

  const messages = Array.isArray(status.messages) ? status.messages : [];
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== "execution_error") continue;
    const data = (message[1] ?? {}) as Record<string, unknown>;
    const exceptionType =
      typeof data.exception_type === "string" ? data.exception_type : undefined;
    const exceptionMessage =
      typeof data.exception_message === "string" ? data.exception_message : undefined;
    const nodeType = typeof data.node_type === "string" ? data.node_type : undefined;

    const detail = [exceptionType, exceptionMessage].filter(Boolean).join(": ");
    const base = detail.length > 0 ? detail : "Unknown execution error";
    return nodeType ? `${base} (in node ${nodeType})` : base;
  }

  return "Unknown execution error";
}

// ─── Object info (cached) ────────────────────────────────────────────────────

let objectInfoCache:
  | { server: string; at: number; data: Record<string, unknown> }
  | undefined;
const OBJECT_INFO_TTL_MS = 60_000;

/**
 * Fetch ComfyUI /object_info with a short-lived per-server cache.
 * Multiple tools query it; avoid re-fetching a potentially large response
 * when several are called in the same flow.
 */
export async function getObjectInfo(
  server: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  }
  if (
    objectInfoCache &&
    objectInfoCache.server === server &&
    Date.now() - objectInfoCache.at < OBJECT_INFO_TTL_MS
  ) {
    return objectInfoCache.data;
  }
  const data = (await comfyFetch(server, "/object_info", { signal })) as Record<string, unknown>;
  objectInfoCache = { server, at: Date.now(), data };
  return data;
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export function resolveInputFilePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export function pickFileInputKey(keys: string[], expectedType: string): string | undefined {
  const preferred = [expectedType, "image", "video", "file", "filename", "path"];
  return preferred.find((key) => keys.includes(key)) ?? keys[0];
}

export async function uploadInputFile(
  server: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<ComfyUIUploadResult> {
  const data = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("image", new Blob([data]), path.basename(filePath));
  form.append("type", "input");
  form.append("overwrite", "true");

  const res = await fetch(buildComfyUrl(server, "/upload/image"), {
    method: "POST",
    body: form,
    signal,
  });
  if (!res.ok) {
    throw new Error(`ComfyUI /upload/image returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ComfyUIUploadResult;
}

// ─── Download ────────────────────────────────────────────────────────────────

export async function downloadOutput(
  server: string,
  nodeOutput: Record<string, Array<{ filename: string; subfolder: string; type: string }>>,
  signal?: AbortSignal,
): Promise<DownloadedOutput[]> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  }
  const results: DownloadedOutput[] = [];

  for (const value of Object.values(nodeOutput)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item.filename || item.subfolder == null || !item.type) continue;

      const params = new URLSearchParams({
        filename: item.filename,
        subfolder: item.subfolder,
        type: item.type,
      });
      const res = await fetch(buildComfyUrl(server, `/view?${params}`), { signal });
      if (!res.ok) {
        throw new Error(
          `ComfyUI /view failed for ${item.filename} with ${res.status}: ${await res.text()}`,
        );
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(item.filename).replace(".", "").toLowerCase() || "png";
      const mimeMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime",
      };
      results.push({
        data: buf,
        filename: item.filename,
        ext,
        mimeType: mimeMap[ext] || "application/octet-stream",
      });
    }
  }

  return results;
}

// ─── Sleep ───────────────────────────────────────────────────────────────────

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Paint cancelled"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Paint cancelled"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
