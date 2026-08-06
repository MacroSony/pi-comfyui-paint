/**
 * Configuration helpers for pi-comfyui-paint.
 *
 * Reads optional JSON config files and environment variables. Environment
 * variables always win; project config wins over global config.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComfyBackend, PaintConfig, PaintJobIdStyle } from "./types.js";
import { normalizeCapabilityList } from "./capabilities.js";

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
const DEFAULT_RECONCILE_INTERVAL_SECONDS = 30;
const DEFAULT_JOB_ID_STYLE: PaintJobIdStyle = "timestamp";
const BACKEND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONFIG_FILENAME = "comfyui-paint.json";

interface ConfigLayer {
  path: string;
  values: Record<string, unknown>;
}

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

function assertBackendId(id: string): void {
  if (!BACKEND_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid ComfyUI backend ID '${id}'. Use letters, numbers, '.', '_' or '-'.`,
    );
  }
}

/** Parse named backend configuration, falling back to COMFYUI_URL/url. */
export function parseComfyBackends(
  rawBackends: string | ComfyBackend[] | undefined,
  fallbackUrl: string | undefined,
): ComfyBackend[] {
  if (Array.isArray(rawBackends)) {
    if (rawBackends.length === 0) {
      throw new Error("ComfyUI backends array must not be empty.");
    }
    const seen = new Set<string>();
    return rawBackends.map((backend, index) => {
      if (
        !backend || typeof backend !== "object" ||
        typeof backend.id !== "string" || typeof backend.url !== "string"
      ) {
        throw new Error(`Invalid ComfyUI backend entry at index ${index}. Expected {id,url}.`);
      }
      const id = backend.id.trim();
      assertBackendId(id);
      if (seen.has(id)) throw new Error(`Duplicate ComfyUI backend ID '${id}'.`);
      seen.add(id);
      const capabilities = backend.capabilities;
      if (capabilities !== undefined && !Array.isArray(capabilities)) {
        throw new Error(
          `Invalid capabilities for backend '${id}': expected an array of tag strings.`,
        );
      }
      if (capabilities && capabilities.some((tag) => typeof tag !== "string")) {
        throw new Error(
          `Invalid capabilities for backend '${id}': expected an array of tag strings.`,
        );
      }
      const result: ComfyBackend = { id, url: normalizeComfyUrl(backend.url) };
      if (capabilities !== undefined) {
        result.capabilities = normalizeCapabilityList(capabilities as string[]);
      }
      return result;
    });
  }

  if (!rawBackends?.trim()) {
    return [{ id: "default", url: normalizeComfyUrl(fallbackUrl) }];
  }

  // The flat COMFYUI_BACKENDS=id=url,id=url form cannot carry capability
  // lists; capabilities are declared through JSON config backends entries.
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
    assertBackendId(id);
    if (seen.has(id)) {
      throw new Error(`Duplicate ComfyUI backend ID '${id}'.`);
    }
    seen.add(id);
    return { id, url: normalizeComfyUrl(rawUrl) };
  });
}

export function paintConfigPaths(cwd: string): { global: string; project: string } {
  return {
    global: path.join(os.homedir(), ".pi", "agent", CONFIG_FILENAME),
    project: path.join(cwd, ".pi", CONFIG_FILENAME),
  };
}

function readConfigLayer(filePath: string, baseDir: string): ConfigLayer | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ComfyUI Paint config ${filePath}: expected a JSON object.`);
  }

  const values = { ...(parsed as Record<string, unknown>) };
  for (const key of ["workflowDir", "outputDir"] ) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) {
      values[key] = path.resolve(baseDir, value);
    }
  }
  const outputDirs = values.backendOutputDirs;
  if (outputDirs && typeof outputDirs === "object" && !Array.isArray(outputDirs)) {
    values.backendOutputDirs = Object.fromEntries(
      Object.entries(outputDirs as Record<string, unknown>).map(([id, value]) => [
        id,
        typeof value === "string" && value.trim() ? path.resolve(baseDir, value) : value,
      ]),
    );
  }
  return { path: filePath, values };
}

function loadConfig(cwd: string): { values: Record<string, unknown>; files: string[]; paths: ReturnType<typeof paintConfigPaths> } {
  const paths = paintConfigPaths(cwd);
  const layers = [
    readConfigLayer(paths.global, os.homedir()),
    readConfigLayer(paths.project, cwd),
  ].filter((layer): layer is ConfigLayer => Boolean(layer));
  return {
    values: Object.assign({}, ...layers.map((layer) => layer.values)),
    files: layers.map((layer) => layer.path),
    paths,
  };
}

function configString(
  values: Record<string, unknown>,
  key: string,
  envName?: string,
): string | undefined {
  if (envName && process.env[envName] !== undefined) return process.env[envName];
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ComfyUI Paint config key '${key}': expected a string.`);
  }
  return value;
}

function configFlag(values: Record<string, unknown>, key: string, envName: string): boolean {
  if (process.env[envName] !== undefined) return envFlag(envName);
  const value = values[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ComfyUI Paint config key '${key}': expected a boolean.`);
  }
  return value;
}

function configInt(
  values: Record<string, unknown>,
  key: string,
  envName: string,
  fallback: number,
  min: number,
  max?: number,
): number {
  const raw = process.env[envName];
  let parsed: number;
  if (raw !== undefined && raw !== "") {
    parsed = intFromEnv(envName, fallback);
  } else {
    const value = values[key];
    if (value === undefined) {
      parsed = fallback;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Invalid ComfyUI Paint config key '${key}': expected a number.`);
      }
      parsed = Math.trunc(value);
    }
  }
  return max === undefined ? Math.max(parsed, min) : Math.min(Math.max(parsed, min), max);
}

function configJobIdStyle(values: Record<string, unknown>): PaintJobIdStyle {
  const raw = process.env.COMFYUI_JOB_ID_STYLE ?? values.jobIdStyle;
  if (raw === undefined) return DEFAULT_JOB_ID_STYLE;
  if (raw !== "timestamp" && raw !== "uuid") {
    throw new Error("COMFYUI_JOB_ID_STYLE/jobIdStyle must be 'timestamp' or 'uuid'.");
  }
  return raw;
}

function parseBackendOutputDirs(raw: string | undefined, cwd: string): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  const result: Record<string, string> = {};
  for (const rawEntry of raw.split(",")) {
    const entry = rawEntry.trim();
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(
        `Invalid COMFYUI_BACKEND_OUTPUT_DIRS entry '${entry}'. Expected id=/path/to/ComfyUI/output.`,
      );
    }
    const id = entry.slice(0, separator).trim();
    assertBackendId(id);
    result[id] = path.resolve(cwd, entry.slice(separator + 1).trim());
  }
  return result;
}

function configBackendOutputDirs(values: Record<string, unknown>, cwd: string): Record<string, string> | undefined {
  if (process.env.COMFYUI_BACKEND_OUTPUT_DIRS !== undefined) {
    return parseBackendOutputDirs(process.env.COMFYUI_BACKEND_OUTPUT_DIRS, cwd);
  }
  const raw = values.backendOutputDirs;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid ComfyUI Paint config key 'backendOutputDirs': expected an object.");
  }
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    assertBackendId(id);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid backendOutputDirs entry '${id}': expected a path string.`);
    }
    result[id] = value;
  }
  return result;
}

function configBackends(values: Record<string, unknown>): ComfyBackend[] {
  const rawBackends = process.env.COMFYUI_BACKENDS ?? values.backends;
  if (rawBackends !== undefined && typeof rawBackends !== "string" && !Array.isArray(rawBackends)) {
    throw new Error("Invalid ComfyUI Paint config key 'backends': expected a string or {id,url} array.");
  }
  return parseComfyBackends(
    rawBackends as string | ComfyBackend[] | undefined,
    configString(values, "url", "COMFYUI_URL"),
  );
}

/** Build the PaintConfig for a given working directory. */
export function getConfig(cwd: string): PaintConfig {
  const { values, files, paths } = loadConfig(cwd);
  const bundledWorkflowDir = path.join(__dirname, "..", "workflows");
  const projectWorkflowDir = path.join(cwd, ".pi", "comfyui_workflows");

  const configuredWorkflowDir = configString(values, "workflowDir", "COMFYUI_WORKFLOW_DIR");
  const workflowDir = configuredWorkflowDir
    ? path.resolve(cwd, configuredWorkflowDir)
    : fs.existsSync(projectWorkflowDir)
      ? projectWorkflowDir
      : bundledWorkflowDir;

  const configuredOutputDir = configString(values, "outputDir", "COMFYUI_OUTPUT_DIR");
  const outputDirIsDefault = !configuredOutputDir;
  const outputDir = configuredOutputDir
    ? path.resolve(cwd, configuredOutputDir)
    : path.join(
        os.tmpdir(),
        `pi-comfyui-paint-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
      );

  const backends = configBackends(values);

  return {
    backends,
    serverAddress: backends[0].url,
    workflowDir,
    projectWorkflowDir,
    bundledWorkflowDir,
    outputDir,
    outputDirIsDefault,
    outputRetentionHours: configInt(
      values,
      "outputRetentionHours",
      "COMFYUI_OUTPUT_RETENTION_HOURS",
      DEFAULT_OUTPUT_RETENTION_HOURS,
      0,
    ),
    syncTimeoutMs:
      configInt(
        values,
        "syncTimeoutSeconds",
        "COMFYUI_SYNC_TIMEOUT_SECONDS",
        DEFAULT_SYNC_TIMEOUT_SECONDS,
        1,
      ) * 1000,
    clientId: `pi-paint-${Math.random().toString(36).slice(2, 10)}`,
    interruptOnAbort: configFlag(values, "interruptOnAbort", "COMFYUI_INTERRUPT_ON_ABORT"),
    inlineImageLimit: configInt(
      values,
      "inlineImageLimit",
      "COMFYUI_INLINE_IMAGE_LIMIT",
      DEFAULT_INLINE_IMAGE_LIMIT,
      0,
      MAX_INLINE_IMAGE_LIMIT,
    ),
    imageQuality: configInt(values, "imageQuality", "COMFYUI_IMAGE_QUALITY", DEFAULT_IMAGE_QUALITY, 1, 100),
    imageMaxDimension: configInt(
      values,
      "imageMaxDimension",
      "COMFYUI_IMAGE_MAX_DIMENSION",
      DEFAULT_IMAGE_MAX_DIMENSION,
      1,
    ),
    imageMaxBytes: configInt(
      values,
      "imageMaxBytes",
      "COMFYUI_IMAGE_MAX_BYTES",
      DEFAULT_IMAGE_MAX_BYTES,
      1024,
    ),
    imageTotalMaxBytes: configInt(
      values,
      "imageTotalMaxBytes",
      "COMFYUI_IMAGE_TOTAL_MAX_BYTES",
      DEFAULT_IMAGE_TOTAL_MAX_BYTES,
      1024,
    ),
    jobIdStyle: configJobIdStyle(values),
    backendOutputDirs: configBackendOutputDirs(values, cwd),
    reconcileIntervalMs:
      configInt(
        values,
        "reconcileIntervalSeconds",
        "COMFYUI_RECONCILE_INTERVAL_SECONDS",
        DEFAULT_RECONCILE_INTERVAL_SECONDS,
        0,
      ) * 1000,
    configFiles: files,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
  };
}
