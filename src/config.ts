/**
 * Configuration helpers for pi-comfyui-paint.
 *
 * Reads env vars and builds a PaintConfig object.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComfyBackend, PaintConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";
const DEFAULT_INLINE_IMAGE_LIMIT = 1;
const MAX_INLINE_IMAGE_LIMIT = 4;
const DEFAULT_IMAGE_QUALITY = 80;
const DEFAULT_IMAGE_MAX_DIMENSION = 2000;
const DEFAULT_IMAGE_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);
const DEFAULT_IMAGE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTPUT_RETENTION_HOURS = 7 * 24;
const DEFAULT_SYNC_TIMEOUT_SECONDS = 10 * 60;
const BACKEND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse a boolean env flag (accepts 1/true/yes/on). */
export function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").toLowerCase());
}

/** Parse int from env var, falling back to default if unset or NaN. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

/** intFromEnv with a lower bound (and optional upper bound). */
function clampedIntFromEnv(name: string, fallback: number, min: number, max?: number): number {
  const parsed = intFromEnv(name, fallback);
  return max === undefined ? Math.max(parsed, min) : Math.min(Math.max(parsed, min), max);
}

/** Normalize COMFYUI_URL to a base URL. Bare host:port values keep working as http://host:port. */
export function normalizeComfyUrl(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_COMFYUI_URL).trim();
  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(value)
    ? value
    : value
      ? `http://${value}`
      : DEFAULT_COMFYUI_URL;

  const url = new URL(withProtocol);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

/** Parse `id=url,id=url` backend configuration, falling back to COMFYUI_URL. */
export function parseComfyBackends(
  rawBackends: string | undefined,
  fallbackUrl: string | undefined,
): ComfyBackend[] {
  if (!rawBackends?.trim()) {
    return [{ id: "default", url: normalizeComfyUrl(fallbackUrl) }];
  }

  const seen = new Set<string>();
  return rawBackends.split(",").map((rawEntry) => {
    const entry = rawEntry.trim();
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(
        `Invalid COMFYUI_BACKENDS entry '${entry}'. Expected id=http://host:port.`,
      );
    }
    const id = entry.slice(0, separator).trim();
    const rawUrl = entry.slice(separator + 1).trim();
    if (!BACKEND_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid ComfyUI backend ID '${id}'. Use letters, numbers, '.', '_' or '-'.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate ComfyUI backend ID '${id}'.`);
    }
    seen.add(id);
    return { id, url: normalizeComfyUrl(rawUrl) };
  });
}

/** Build the PaintConfig for a given working directory. */
export function getConfig(cwd: string): PaintConfig {
  // Package's own workflows dir as fallback
  const bundledWorkflowDir = path.join(__dirname, "..", "workflows");
  const projectWorkflowDir = path.join(cwd, ".pi", "comfyui_workflows");

  let workflowDir: string;
  if (process.env.COMFYUI_WORKFLOW_DIR) {
    workflowDir = process.env.COMFYUI_WORKFLOW_DIR;
  } else {
    workflowDir = fs.existsSync(projectWorkflowDir) ? projectWorkflowDir : bundledWorkflowDir;
  }

  const outputDirIsDefault = !process.env.COMFYUI_OUTPUT_DIR;
  const outputDir = process.env.COMFYUI_OUTPUT_DIR
    ? path.resolve(cwd, process.env.COMFYUI_OUTPUT_DIR)
    : path.join(
        os.tmpdir(),
        `pi-comfyui-paint-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
      );

  const backends = parseComfyBackends(
    process.env.COMFYUI_BACKENDS,
    process.env.COMFYUI_URL,
  );

  return {
    backends,
    serverAddress: backends[0].url,
    workflowDir,
    projectWorkflowDir,
    bundledWorkflowDir,
    outputDir,
    outputDirIsDefault,
    outputRetentionHours: clampedIntFromEnv(
      "COMFYUI_OUTPUT_RETENTION_HOURS",
      DEFAULT_OUTPUT_RETENTION_HOURS,
      0,
    ),
    syncTimeoutMs:
      clampedIntFromEnv(
        "COMFYUI_SYNC_TIMEOUT_SECONDS",
        DEFAULT_SYNC_TIMEOUT_SECONDS,
        1,
      ) * 1000,
    clientId: `pi-paint-${Math.random().toString(36).slice(2, 10)}`,
    interruptOnAbort: envFlag("COMFYUI_INTERRUPT_ON_ABORT"),
    inlineImageLimit: clampedIntFromEnv(
      "COMFYUI_INLINE_IMAGE_LIMIT",
      DEFAULT_INLINE_IMAGE_LIMIT,
      0,
      MAX_INLINE_IMAGE_LIMIT,
    ),
    imageQuality: clampedIntFromEnv("COMFYUI_IMAGE_QUALITY", DEFAULT_IMAGE_QUALITY, 1, 100),
    imageMaxDimension: clampedIntFromEnv(
      "COMFYUI_IMAGE_MAX_DIMENSION",
      DEFAULT_IMAGE_MAX_DIMENSION,
      1,
    ),
    imageMaxBytes: clampedIntFromEnv(
      "COMFYUI_IMAGE_MAX_BYTES",
      DEFAULT_IMAGE_MAX_BYTES,
      1024,
    ),
    imageTotalMaxBytes: clampedIntFromEnv(
      "COMFYUI_IMAGE_TOTAL_MAX_BYTES",
      DEFAULT_IMAGE_TOTAL_MAX_BYTES,
      1024,
    ),
  };
}
