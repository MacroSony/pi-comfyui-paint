/**
 * Configuration helpers for pi-comfyui-paint.
 *
 * Reads env vars and builds a PaintConfig object.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaintConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_COMFYUI_URL = "http://127.0.0.1:8188";

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

  return {
    serverAddress: normalizeComfyUrl(process.env.COMFYUI_URL),
    workflowDir,
    projectWorkflowDir,
    bundledWorkflowDir,
    clientId: `pi-paint-${Math.random().toString(36).slice(2, 10)}`,
    interruptOnAbort: envFlag("COMFYUI_INTERRUPT_ON_ABORT"),
    imageQuality: intFromEnv("COMFYUI_IMAGE_QUALITY", 85),
    imageMaxDimension: intFromEnv("COMFYUI_IMAGE_MAX_DIMENSION", 2048),
  };
}
