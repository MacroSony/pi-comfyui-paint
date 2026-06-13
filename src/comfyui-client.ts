/**
 * ComfyUI HTTP API helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ComfyUIQueueResult,
  ComfyUIHistoryOutput,
  ComfyUIUploadResult,
  DownloadedOutput,
} from "./types.js";

// ─── Generic fetch ───────────────────────────────────────────────────────────

export async function comfyFetch(
  server: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<unknown> {
  const url = `http://${server}${endpoint}`;
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
): Promise<ComfyUIHistoryOutput> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (signal?.aborted) {
      throw new Error("Paint cancelled");
    }

    const history = (await comfyFetch(server, `/history/${promptId}`, { signal })) as ComfyUIHistoryOutput;
    if (history[promptId]) {
      return history;
    }
    await abortableSleep(pollIntervalMs, signal);
  }
  throw new Error(`Timeout waiting for ComfyUI prompt ${promptId} after ${maxWaitMs}ms`);
}

// ─── Interrupt ───────────────────────────────────────────────────────────────

export async function interruptComfy(server: string): Promise<void> {
  const res = await fetch(`http://${server}/interrupt`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`ComfyUI /interrupt returned ${res.status}: ${await res.text()}`);
  }
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

  const res = await fetch(`http://${server}/upload/image`, {
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
): Promise<DownloadedOutput[]> {
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
      const res = await fetch(`http://${server}/view?${params}`);
      if (!res.ok) continue;

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

    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Paint cancelled"));
      },
      { once: true },
    );
  });
}
