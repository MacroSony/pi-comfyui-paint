/**
 * ComfyUI HTTP API helpers.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeComfyUrl } from "./config.js";
import type {
  ComfyUIQueueResult,
  ComfyUIQueueStatus,
  ComfyUIHistoryOutput,
  ComfyUIOutputItem,
  ComfyUIUploadResult,
  GenerationResult,
} from "./types.js";

// ─── Generic fetch ───────────────────────────────────────────────────────────

export function buildComfyUrl(server: string, endpoint: string): string {
  const base = normalizeComfyUrl(server);
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${suffix}`;
}

export class ComfyHttpError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`ComfyUI ${endpoint} returned ${status}: ${responseBody}`);
    this.name = "ComfyHttpError";
  }
}

export async function comfyFetch(
  server: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = buildComfyUrl(server, endpoint);
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new ComfyHttpError(endpoint, res.status, await res.text());
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
  if (typeof result.prompt_id !== "string" || result.prompt_id.length === 0) {
    throw new Error("ComfyUI /prompt returned no prompt_id");
  }
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
  throw new PollTimeoutError(promptId, maxWaitMs);
}

export class PollTimeoutError extends Error {
  constructor(
    public readonly promptId: string,
    public readonly maxWaitMs: number,
  ) {
    super(`Timeout waiting for ComfyUI prompt ${promptId} after ${maxWaitMs}ms`);
    this.name = "PollTimeoutError";
  }
}

// ─── Interrupt ───────────────────────────────────────────────────────────────

export async function interruptComfy(server: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(buildComfyUrl(server, "/interrupt"), { method: "POST", signal });
  if (!res.ok) {
    throw new Error(`ComfyUI /interrupt returned ${res.status}: ${await res.text()}`);
  }
}

/**
 * Cancel one exact prompt using ComfyUI's atomic jobs API.
 *
 * Returns undefined when the backend predates this API so callers can choose a
 * safe legacy fallback. A false result means the API exists but the exact job
 * was no longer cancellable.
 */
export async function cancelPromptAtomically(
  server: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const endpoint = `/api/jobs/${encodeURIComponent(promptId)}/cancel`;
  const res = await fetch(buildComfyUrl(server, endpoint), { method: "POST", signal });
  if (res.status === 404 || res.status === 405) return undefined;
  if (!res.ok) {
    throw new Error(`ComfyUI ${endpoint} returned ${res.status}: ${await res.text()}`);
  }
  const result = (await res.json()) as { cancelled?: unknown };
  if (typeof result.cancelled !== "boolean") {
    throw new Error(`ComfyUI ${endpoint} returned an invalid response`);
  }
  return result.cancelled;
}

export async function getQueueStatus(
  server: string,
  signal?: AbortSignal,
): Promise<ComfyUIQueueStatus> {
  return (await comfyFetch(server, "/queue", { signal })) as ComfyUIQueueStatus;
}

export async function deleteQueuedPrompt(
  server: string,
  promptId: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(buildComfyUrl(server, "/queue"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [promptId] }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`ComfyUI /queue returned ${res.status}: ${await res.text()}`);
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

/**
 * Upload one local file to ComfyUI's /upload/image endpoint.
 *
 * The multipart body is streamed directly from disk instead of buffering the
 * whole file in memory, so large video inputs (hundreds of MB) upload with
 * constant memory usage. The field name stays "image" — that endpoint accepts
 * any file type (videos, audio) with a filename.
 */
export async function uploadInputFile(
  server: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<ComfyUIUploadResult> {
  const filename = path.basename(filePath);
  const boundary = `----pi-paint-${crypto.randomBytes(12).toString("hex")}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const epilogue = Buffer.from(
    `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="type"\r\n\r\ninput\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n` +
      `--${boundary}--\r\n`,
  );

  const fileStream = createReadStream(filePath);
  const body = Readable.from(async function* () {
    yield preamble;
    yield* fileStream;
    yield epilogue;
  }());
  const destroyBody = () => body.destroy();
  signal?.addEventListener("abort", destroyBody, { once: true });

  try {
    // undici accepts a Node stream body with duplex: "half"; the DOM RequestInit
    // type predates it, so widen the option object explicitly.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body as unknown as BodyInit,
      duplex: "half",
      signal,
    };
    const res = await fetch(buildComfyUrl(server, "/upload/image"), init);
    if (!res.ok) {
      throw new Error(`ComfyUI /upload/image returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as ComfyUIUploadResult;
  } finally {
    signal?.removeEventListener("abort", destroyBody);
  }
}

// ─── Download ────────────────────────────────────────────────────────────────

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

export function outputFileMetadata(filename: string): { ext: string; mimeType: string } {
  const ext = path.extname(filename).replace(".", "").toLowerCase() || "bin";
  return { ext, mimeType: MIME_BY_EXTENSION[ext] || "application/octet-stream" };
}

export function collectOutputItems(
  nodeOutput: Record<string, Array<ComfyUIOutputItem>>,
): ComfyUIOutputItem[] {
  const items: ComfyUIOutputItem[] = [];
  for (const value of Object.values(nodeOutput)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item.filename || item.subfolder == null || !item.type) continue;
      items.push(item);
    }
  }
  return items;
}

/** Stream one ComfyUI output directly to a private local file. */
export async function downloadOutputToFile(
  server: string,
  item: ComfyUIOutputItem,
  filePath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  }
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
  if (!res.body) throw new Error(`ComfyUI /view returned an empty body for ${item.filename}`);

  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
  try {
    await pipeline(
      Readable.fromWeb(
        res.body as unknown as import("node:stream/web").ReadableStream,
      ),
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    fs.chmodSync(temporaryPath, 0o600);
    if (fs.existsSync(filePath)) {
      fs.rmSync(temporaryPath, { force: true });
    } else {
      fs.renameSync(temporaryPath, filePath);
    }
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the download error.
    }
    throw error;
  }
}

/** Stream every output item into a job output directory. */
export async function downloadOutputsToDirectory(
  server: string,
  nodeOutputs: Array<Record<string, Array<ComfyUIOutputItem>>>,
  outputDir: string,
  signal?: AbortSignal,
): Promise<GenerationResult[]> {
  const results: GenerationResult[] = [];
  let counter = 0;
  for (const nodeOutput of nodeOutputs) {
    for (const item of collectOutputItems(nodeOutput)) {
      const { ext, mimeType } = outputFileMetadata(item.filename);
      const filename = `paint_${counter}.${ext}`;
      const filePath = path.join(outputDir, filename);
      if (!fs.existsSync(filePath)) {
        await downloadOutputToFile(server, item, filePath, signal);
      }
      results.push({ path: filePath, filename, mimeType });
      counter++;
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
