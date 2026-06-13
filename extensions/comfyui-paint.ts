/**
 * pi-comfyui-paint
 *
 * Connects to a ComfyUI server for image/video generation.
 *
 * Configuration (env vars or defaults):
 *   COMFYUI_URL                 - ComfyUI server address (default: 127.0.0.1:8188)
 *   COMFYUI_WORKFLOW_DIR        - Workflow JSON folder
 *                                 (default: project's comfyui_workflows/, falls back to package's workflows/)
 *   COMFYUI_INTERRUPT_ON_ABORT  - Interrupt ComfyUI when a pi paint tool call is cancelled
 *                                 (default: off; set to 1/true/yes/on to enable)
 *   COMFYUI_IMAGE_QUALITY       - JPEG quality for images sent to the LLM provider (1-100, default: 85).
 *                                 Set to 0 to send raw PNG with no compression.
 *   COMFYUI_IMAGE_MAX_DIMENSION - Resize images so the longest side ≤ this many pixels (default: 2048).
 *                                 Set to 0 to skip resizing. Original files on disk are never modified.
 *
 * Registers 9 tools:
 *   paint_list_workflows          - List available workflow JSON files
 *   paint_get_details             - Inspect workflow variables, notes, etc.
 *   paint_validate_workflow       - Validate workflow annotations and structure
 *   paint_copy_workflow_to_project - Copy bundled workflows into ./comfyui_workflows/
 *   paint_server_status           - Check ComfyUI connectivity and extension configuration
 *   paint_get_models              - Query ComfyUI server for available models
 *   paint_queue_status            - Check current generation queue
 *   paint_interrupt               - Cancel running generation
 *   paint                         - Generate images/videos
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import sharp from "sharp";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Callback for streaming progress updates during tool execution. */
type OnUpdate = (update: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown }) => void;

// ─── Configuration ───────────────────────────────────────────────────────────

interface PaintConfig {
  serverAddress: string;
  workflowDir: string;
  projectWorkflowDir: string;
  bundledWorkflowDir: string;
  clientId: string;
  interruptOnAbort: boolean;
  /** JPEG quality 1-100 for images sent to the LLM. 0 = no compression (raw PNG). */
  imageQuality: number;
  /** Max pixels on the longest side when resizing images for the LLM. 0 = no resize. */
  imageMaxDimension: number;
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").toLowerCase());
}

function getConfig(cwd: string): PaintConfig {
  // Package's own workflows dir as fallback
  const bundledWorkflowDir = path.join(__dirname, "..", "workflows");
  const projectWorkflowDir = path.join(cwd, "comfyui_workflows");

  let workflowDir: string;
  if (process.env.COMFYUI_WORKFLOW_DIR) {
    workflowDir = process.env.COMFYUI_WORKFLOW_DIR;
  } else {
    workflowDir = fs.existsSync(projectWorkflowDir) ? projectWorkflowDir : bundledWorkflowDir;
  }

  return {
    serverAddress: process.env.COMFYUI_URL || "127.0.0.1:8188",
    workflowDir,
    projectWorkflowDir,
    bundledWorkflowDir,
    clientId: `pi-paint-${Math.random().toString(36).slice(2, 10)}`,
    interruptOnAbort: envFlag("COMFYUI_INTERRUPT_ON_ABORT"),
    imageQuality: parseInt(process.env.COMFYUI_IMAGE_QUALITY ?? "85", 10) || 85,
    imageMaxDimension: parseInt(process.env.COMFYUI_IMAGE_MAX_DIMENSION ?? "2048", 10) || 2048,
  };
}

// ─── Workflow JSON helpers ───────────────────────────────────────────────────

interface WorkflowVariables {
  [name: string]: { nodeId: string; keys: string[]; defaults: unknown[] };
}

/** Internal parsed workflow details (includes raw data used at generation time). */
interface ParsedWorkflow {
  notes: string;
  variables: Record<string, unknown>;
  outputTypes: Record<string, string>;
  inputSlots: Record<number, { keys: string[]; expectedType: string }>;
  fileNodes: Record<number, { nodeId: string; keys: string[]; expectedType: string }>;
  rawVars: WorkflowVariables;
}

function loadWorkflowJson(workflowPath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(workflowPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseWorkflowDetails(wf: Record<string, unknown>): ParsedWorkflow {
  const rawVars: Record<string, { nodeId: string; keys: string[]; defaults: unknown[] }> = {};
  const outputTypes: Record<string, string> = {};
  const fileNodes: Record<number, { nodeId: string; keys: string[]; expectedType: string }> = {};
  const notesParts: string[] = [];

  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const meta = (n._meta as Record<string, unknown>) ?? {};
    const title = (meta.title as string) ?? "";

    if (title.startsWith("[VAR]")) {
      const varName = title.replace("[VAR]", "").trim();
      const inputs = (n.inputs as Record<string, unknown>) ?? {};
      const keys = Object.keys(inputs);
      const defaults = Object.values(inputs);
      rawVars[varName] = { nodeId, keys, defaults };
    } else if (title.startsWith("[NOTE]")) {
      const inputs = (n.inputs as Record<string, unknown>) ?? {};
      const noteText = ((inputs.value ?? inputs.text ?? "") as string).trim();
      if (noteText) notesParts.push(noteText);
    } else {
      const outMatch = title.match(/^\[OUTPUT:([^\]]+)\]/i);
      const fileMatch = title.match(/^\[FILE:([^:]+):(\d+)\]/i);
      if (outMatch) {
        outputTypes[nodeId] = outMatch[1].trim().toLowerCase() || "any";
      } else if (fileMatch) {
        const expectedType = fileMatch[1].trim().toLowerCase();
        const order = parseInt(fileMatch[2], 10);
        const inputs = (n.inputs as Record<string, unknown>) ?? {};
        fileNodes[order] = {
          nodeId,
          keys: Object.keys(inputs),
          expectedType,
        };
      }
    }
  }

  // Build simplified variables view (defaults only)
  const variables: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(rawVars)) {
    variables[name] = v.defaults.length === 1 ? v.defaults[0] : v.defaults;
  }

  // Build inputSlots view (same as Python's input_slots)
  const inputSlots: Record<number, { keys: string[]; expectedType: string }> = {};
  for (const [order, info] of Object.entries(fileNodes)) {
    inputSlots[parseInt(order)] = { keys: info.keys, expectedType: info.expectedType };
  }

  return {
    notes: notesParts.join("\n\n"),
    variables,
    outputTypes,
    inputSlots,
    fileNodes,
    rawVars,
  };
}

// ─── ComfyUI HTTP helpers ────────────────────────────────────────────────────

interface ComfyUIQueueResult {
  prompt_id: string;
}

interface ComfyUIHistoryOutput {
  [promptId: string]: {
    outputs: Record<
      string,
      Record<
        string,
        Array<{
          filename: string;
          subfolder: string;
          type: string;
        }>
      >
    >;
  };
}

async function comfyFetch(
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

async function queuePrompt(
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

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

async function pollHistory(
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
    // Check if the prompt_id is present (meaning execution completed)
    if (history[promptId]) {
      return history;
    }
    await abortableSleep(pollIntervalMs, signal);
  }
  throw new Error(`Timeout waiting for ComfyUI prompt ${promptId} after ${maxWaitMs}ms`);
}

async function interruptComfy(server: string): Promise<void> {
  const res = await fetch(`http://${server}/interrupt`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`ComfyUI /interrupt returned ${res.status}: ${await res.text()}`);
  }
}

interface ComfyUploadResult {
  name: string;
  subfolder?: string;
  type?: string;
}

function resolveInputFilePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function pickFileInputKey(keys: string[], expectedType: string): string | undefined {
  const preferred = [expectedType, "image", "video", "file", "filename", "path"];
  return preferred.find((key) => keys.includes(key)) ?? keys[0];
}

async function uploadInputFile(
  server: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<ComfyUploadResult> {
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
  return (await res.json()) as ComfyUploadResult;
}

async function downloadOutput(
  server: string,
  nodeOutput: Record<
    string,
    Array<{ filename: string; subfolder: string; type: string }>
  >,
): Promise<Array<{ data: Buffer; filename: string; ext: string; mimeType: string }>> {
  const results: Array<{ data: Buffer; filename: string; ext: string; mimeType: string }> = [];

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

// ─── Workflow path resolution ────────────────────────────────────────────────

function resolveWorkflowPath(workflowDir: string, workflowName?: string): string {
  if (!workflowName) {
    // Try default: first .json in workflowDir
    if (fs.existsSync(workflowDir)) {
      const files = fs.readdirSync(workflowDir).filter((f) => f.endsWith(".json"));
      if (files.length > 0) return path.join(workflowDir, files[0]);
    }
    throw new Error("No default workflow found and no workflow specified.");
  }

  const name = workflowName.endsWith(".json") ? workflowName : `${workflowName}.json`;
  const direct = path.join(workflowDir, name);
  if (fs.existsSync(direct)) return direct;
  // Try as absolute path
  if (fs.existsSync(name)) return name;
  throw new Error(`Workflow not found: ${name} (looked in ${workflowDir})`);
}

function validateWorkflow(wf: Record<string, unknown>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details = parseWorkflowDetails(wf);

  if (Object.keys(wf).length === 0) {
    errors.push("Workflow JSON is empty.");
  }

  const nodeEntries = Object.entries(wf).filter(([, node]) => node && typeof node === "object");
  const classlessNodes = nodeEntries
    .filter(([, node]) => !("class_type" in (node as Record<string, unknown>)))
    .map(([nodeId]) => nodeId);
  if (classlessNodes.length > 0) {
    warnings.push(`Node(s) without class_type: ${classlessNodes.slice(0, 10).join(", ")}${classlessNodes.length > 10 ? "..." : ""}`);
  }

  const rawVars = details.rawVars ?? {};
  if (!rawVars.PositivePrompt) {
    warnings.push("No [VAR] PositivePrompt node found; paint.prompt will not be injected automatically.");
  }
  for (const [name, info] of Object.entries(rawVars)) {
    if (info.keys.length === 0) {
      warnings.push(`[VAR] ${name} has no inputs to set.`);
    }
  }

  if (Object.keys(details.outputTypes).length === 0) {
    warnings.push("No [OUTPUT:type] nodes found; paint will fall back to scanning all ComfyUI outputs.");
  }

  const fileOrders = Object.keys(details.fileNodes).map(Number).sort((a, b) => a - b);
  for (const order of fileOrders) {
    const slot = details.fileNodes[order];
    if (!slot.keys.length) {
      errors.push(`[FILE:${slot.expectedType}:${order}] has no inputs to set.`);
    }
  }

  return { errors, warnings };
}

// ─── Image compression for LLM provider ──────────────────────────────────────

/**
 * Compress an image buffer for sending to the LLM provider.
 * - If quality is 0, returns the raw PNG data unchanged.
 * - Otherwise resizes (if maxDimension > 0) and converts to JPEG at the given quality.
 * Returns { data: base64 string, mimeType: string }.
 */
async function compressImageForLLM(
  buf: Buffer,
  mimeType: string,
  quality: number,
  maxDimension: number,
): Promise<{ data: string; mimeType: string }> {
  // No compression requested — pass through as-is
  if (quality === 0) {
    return { data: buf.toString("base64"), mimeType };
  }

  let pipeline = sharp(buf);
  const metadata = await pipeline.metadata();

  // Resize if the image exceeds maxDimension on its longest side
  if (maxDimension > 0 && metadata.width && metadata.height) {
    const longest = Math.max(metadata.width, metadata.height);
    if (longest > maxDimension) {
      pipeline = pipeline.resize({
        width: maxDimension,
        height: maxDimension,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
  }

  // Convert to JPEG at the configured quality
  const compressed = await pipeline.jpeg({ quality }).toBuffer();
  return { data: compressed.toString("base64"), mimeType: "image/jpeg" };
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const config = getConfig(cwd);

  // ── paint_list_workflows ─────────────────────────────────────────────────

  pi.registerTool({
    name: "paint_list_workflows",
    label: "Paint List Workflows",
    description:
      "Lists all available image generation workflows (JSON files) in the ComfyUI workflow folder. " +
      "Use this to browse what's available, then call paint_get_details for any workflow you want to use.",
    promptSnippet: "List available ComfyUI workflow JSON files",
    promptGuidelines: [
      "Use paint_list_workflows to discover what workflows are available before calling paint or paint_get_details.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const dir = config.workflowDir;
      if (!fs.existsSync(dir)) {
        return {
          content: [{ type: "text", text: `Workflow directory not found: ${dir}` }],
          details: {},
        };
      }
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "No workflows found in the comfyui_workflows folder." }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `Available workflows: ${files.join(", ")}` }],
        details: { workflows: files },
      };
    },
  });

  // ── paint_get_details ────────────────────────────────────────────────────

  pi.registerTool({
    name: "paint_get_details",
    label: "Paint Get Details",
    description:
      "Inspect a specific generation workflow in detail. Returns: the workflow's notes/instructions " +
      "(model recommendations, prompt style guidance), customizable variables with their default values, " +
      "output media types, and input file slots. " +
      "Call this before using 'paint' with a workflow you haven't inspected yet.",
    promptSnippet: "Inspect a workflow's variables, notes, output types, and input file slots",
    promptGuidelines: [
      "Use paint_get_details before calling paint with an unfamiliar workflow to learn its variables, prompt style, and input requirements.",
    ],
    parameters: Type.Object({
      workflow: Type.Optional(
        Type.String({
          description:
            "The name of the workflow file to inspect (e.g., 'SDXL_example.json'). If omitted, uses the first available workflow.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const wfPath = resolveWorkflowPath(config.workflowDir, params.workflow);
        const wf = loadWorkflowJson(wfPath);
        if (!wf) {
          return {
            content: [{ type: "text", text: `Failed to load workflow: ${wfPath}` }],
            details: {},
          };
        }
        const details = parseWorkflowDetails(wf);
        const workflowName = path.basename(wfPath);

        const lines: string[] = [`**Workflow details for '${workflowName}':**`];

        if (details.notes) {
          lines.push(`\n📝 **Notes:**\n${details.notes}`);
        }

        const varKeys = Object.keys(details.variables);
        if (varKeys.length > 0) {
          lines.push(
            `\n🎛️ **Variables:**\n\`\`\`json\n${JSON.stringify(details.variables, null, 2)}\n\`\`\``,
          );
        } else {
          lines.push("\n🎛️ **Variables:** (none — this workflow has no [VAR] nodes)");
        }

        const outKeys = Object.keys(details.outputTypes);
        if (outKeys.length > 0) {
          lines.push(
            `\n📤 **Output types:**\n\`\`\`json\n${JSON.stringify(details.outputTypes, null, 2)}\n\`\`\``,
          );
        }

        const slotKeys = Object.keys(details.inputSlots);
        if (slotKeys.length > 0) {
          lines.push(
            `\n📥 **Input file slots:**\n\`\`\`json\n${JSON.stringify(details.inputSlots, null, 2)}\n\`\`\``,
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            workflow: workflowName,
            notes: details.notes,
            variables: details.variables,
            outputTypes: details.outputTypes,
            inputSlots: details.inputSlots,
          },
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error getting workflow details: ${(e as Error).message}` },
          ],
          details: {},
        };
      }
    },
  });

  // ── paint_validate_workflow ────────────────────────────────────────────

  pi.registerTool({
    name: "paint_validate_workflow",
    label: "Paint Validate Workflow",
    description:
      "Validate a ComfyUI workflow JSON before generation. Checks parseability, [VAR] annotations, " +
      "[OUTPUT:type] annotations, and [FILE:type:order] input slots. Use this when a workflow fails or before using a custom workflow.",
    promptSnippet: "Validate a workflow JSON's structure and pi-comfyui-paint annotations",
    promptGuidelines: [
      "Use paint_validate_workflow when a paint generation fails or before using a custom workflow to check for annotation errors.",
    ],
    parameters: Type.Object({
      workflow: Type.Optional(
        Type.String({
          description:
            "The workflow file to validate. If omitted, validates the first available workflow.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const wfPath = resolveWorkflowPath(config.workflowDir, params.workflow);
        const wf = loadWorkflowJson(wfPath);
        if (!wf) {
          return {
            content: [{ type: "text", text: `Workflow is invalid JSON or unreadable: ${wfPath}` }],
            details: { valid: false, workflow: path.basename(wfPath), errors: ["Invalid or unreadable JSON"], warnings: [] },
          };
        }

        const details = parseWorkflowDetails(wf);
        const validation = validateWorkflow(wf);
        const valid = validation.errors.length === 0;
        const lines = [
          `**Workflow validation for '${path.basename(wfPath)}': ${valid ? "passed" : "failed"}**`,
          `Nodes: ${Object.keys(wf).length}`,
          `Variables: ${Object.keys(details.variables).length}`,
          `Tagged outputs: ${Object.keys(details.outputTypes).length}`,
          `Input file slots: ${Object.keys(details.inputSlots).length}`,
        ];

        if (validation.errors.length > 0) {
          lines.push("\n❌ **Errors:**");
          lines.push(...validation.errors.map((err) => `- ${err}`));
        }
        if (validation.warnings.length > 0) {
          lines.push("\n⚠️ **Warnings:**");
          lines.push(...validation.warnings.map((warning) => `- ${warning}`));
        }
        if (valid && validation.warnings.length === 0) {
          lines.push("\nNo issues found.");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            valid,
            workflow: path.basename(wfPath),
            errors: validation.errors,
            warnings: validation.warnings,
            variables: details.variables,
            outputTypes: details.outputTypes,
            inputSlots: details.inputSlots,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error validating workflow: ${(e as Error).message}` }],
          details: { valid: false },
        };
      }
    },
  });

  // ── paint_copy_workflow_to_project ──────────────────────────────────────

  pi.registerTool({
    name: "paint_copy_workflow_to_project",
    label: "Paint Copy Workflow To Project",
    description:
      "Copy a bundled workflow into ./comfyui_workflows/ so it can be edited for the current project. " +
      "Use this before customizing a bundled workflow instead of modifying package files.",
    promptSnippet: "Copy bundled workflows into ./comfyui_workflows/ for project customization",
    promptGuidelines: [
      "Use paint_copy_workflow_to_project before editing a bundled workflow so changes stay in the project and don't affect the package.",
    ],
    parameters: Type.Object({
      workflow: Type.Optional(
        Type.String({
          description:
            "Bundled workflow file to copy. If omitted, copies all bundled workflow JSON files.",
        }),
      ),
      overwrite: Type.Optional(
        Type.Boolean({
          description: "Overwrite an existing project workflow file. Defaults to false.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        if (!fs.existsSync(config.bundledWorkflowDir)) {
          throw new Error(`Bundled workflow directory not found: ${config.bundledWorkflowDir}`);
        }

        const bundledFiles = fs.readdirSync(config.bundledWorkflowDir)
          .filter((file) => file.endsWith(".json"))
          .sort();
        const selectedFiles = params.workflow
          ? [path.basename(params.workflow.endsWith(".json") ? params.workflow : `${params.workflow}.json`)]
          : bundledFiles;

        if (selectedFiles.length === 0) {
          throw new Error("No bundled workflows found to copy.");
        }

        fs.mkdirSync(config.projectWorkflowDir, { recursive: true });
        const copied: string[] = [];
        const skipped: string[] = [];

        for (const file of selectedFiles) {
          if (!bundledFiles.includes(file)) {
            throw new Error(`Bundled workflow not found: ${file}`);
          }
          const src = path.join(config.bundledWorkflowDir, file);
          const dest = path.join(config.projectWorkflowDir, file);
          if (fs.existsSync(dest) && !params.overwrite) {
            skipped.push(dest);
            continue;
          }
          fs.copyFileSync(src, dest);
          copied.push(dest);
        }

        const lines = [
          `Project workflow directory: ${config.projectWorkflowDir}`,
          `Copied ${copied.length} workflow(s).`,
        ];
        if (copied.length > 0) lines.push(...copied.map((file) => `- copied: ${file}`));
        if (skipped.length > 0) {
          lines.push(`Skipped ${skipped.length} existing workflow(s); pass overwrite=true to replace them.`);
          lines.push(...skipped.map((file) => `- skipped: ${file}`));
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { projectWorkflowDir: config.projectWorkflowDir, copied, skipped },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error copying workflow: ${(e as Error).message}` }],
          details: {},
        };
      }
    },
  });

  // ── paint_server_status ────────────────────────────────────────────────

  pi.registerTool({
    name: "paint_server_status",
    label: "Paint Server Status",
    description:
      "Check ComfyUI connectivity and show the effective pi-comfyui-paint configuration. " +
      "Use this to debug COMFYUI_URL, workflow discovery, queue state, and cancellation behavior before generating.",
    promptSnippet: "Check ComfyUI server connectivity and extension configuration",
    promptGuidelines: [
      "Use paint_server_status to debug connectivity issues before generating images — it reports whether ComfyUI is reachable, which workflow directory is active, and the current queue state.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const workflowDirExists = fs.existsSync(config.workflowDir);
      const workflows = workflowDirExists
        ? fs.readdirSync(config.workflowDir).filter((f) => f.endsWith(".json")).sort()
        : [];

      const queueResult = await Promise.allSettled([
        comfyFetch(config.serverAddress, "/queue"),
        comfyFetch(config.serverAddress, "/system_stats"),
      ]);

      const queueEntry = queueResult[0];
      const statsEntry = queueResult[1];
      const queueOk = queueEntry.status === "fulfilled";
      const queue = queueEntry.status === "fulfilled"
        ? (queueEntry.value as { queue_running?: unknown[]; queue_pending?: unknown[] })
        : undefined;

      const lines = [
        "**ComfyUI Paint Status**",
        `Server: http://${config.serverAddress}`,
        `Reachable: ${queueOk ? "yes" : "no"}`,
        `Active workflow directory: ${config.workflowDir}`,
        `Project workflow directory: ${config.projectWorkflowDir}`,
        `Bundled workflow directory: ${config.bundledWorkflowDir}`,
        `Active workflow directory exists: ${workflowDirExists ? "yes" : "no"}`,
        `Workflow count: ${workflows.length}`,
        `Interrupt on abort: ${config.interruptOnAbort ? "enabled" : "disabled"}`,
        `Image quality (LLM): ${config.imageQuality === 0 ? "raw PNG (no compression)" : `JPEG q${config.imageQuality}`}`,
        `Image max dimension (LLM): ${config.imageMaxDimension === 0 ? "no resize" : `${config.imageMaxDimension}px`}`,
      ];

      if (queue) {
        lines.push(`Queue running: ${queue.queue_running?.length ?? 0}`);
        lines.push(`Queue pending: ${queue.queue_pending?.length ?? 0}`);
      }
      if (queueEntry.status === "rejected") {
        lines.push(`Queue error: ${(queueEntry.reason as Error).message}`);
      }
      if (statsEntry.status === "rejected") {
        lines.push(`System stats error: ${(statsEntry.reason as Error).message}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          serverAddress: config.serverAddress,
          reachable: queueOk,
          workflowDir: config.workflowDir,
          projectWorkflowDir: config.projectWorkflowDir,
          bundledWorkflowDir: config.bundledWorkflowDir,
          workflowDirExists,
          workflows,
          interruptOnAbort: config.interruptOnAbort,
          imageQuality: config.imageQuality,
          imageMaxDimension: config.imageMaxDimension,
          queue,
          systemStats: statsEntry.status === "fulfilled" ? statsEntry.value : undefined,
        },
      };
    },
  });

  // ── paint ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "paint",
    label: "Paint",
    description:
      "Generates an image or video using ComfyUI with a prompt and optional workflow variables. " +
      "Returns the generated file paths. " +
      "You can specify a 'workflow' to change the style, and pass 'variables' to customize the generation process. " +
      "Call paint_list_workflows to browse available workflows, then paint_get_details for any workflow's variables and notes.",
    promptSnippet: "Generate images/videos via ComfyUI with a prompt, optional workflow, variables, and input files",
    promptGuidelines: [
      "Use paint to generate images or videos. Always call paint_list_workflows first to see available workflows, then paint_get_details to learn a workflow's variables and prompt style before generating.",
      "Use paint_queue_status before paint to avoid piling up redundant requests if the ComfyUI queue is busy.",
      "Use paint_interrupt to cancel a running generation if the user changes their mind.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The positive prompt describing what you want to see." }),
      negative_prompt: Type.Optional(
        Type.String({ description: "What you want to avoid in the generation." }),
      ),
      workflow: Type.Optional(
        Type.String({
          description:
            "The workflow file to use (e.g., 'Anime.json'). Call paint_list_workflows to browse, then paint_get_details for that workflow's variables and notes.",
        }),
      ),
      variables: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Custom variables for the workflow (e.g., {'Width': 1024, 'Height': 1024, 'Seed': 12345}). See paint_get_details for available keys.",
        }),
      ),
      input_files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Local image file paths to upload into [FILE:type:order] workflow slots, in slot order. Relative paths are resolved from the current project directory.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      let promptId: string | undefined;
      try {
        // 1. Resolve workflow
        const wfPath = resolveWorkflowPath(config.workflowDir, params.workflow);
        const wfRaw = loadWorkflowJson(wfPath);
        if (!wfRaw) {
          throw new Error(`Failed to load workflow: ${wfPath}`);
        }

        // 2. Parse workflow details
        const details = parseWorkflowDetails(wfRaw);

        // 3. Deep clone the workflow and apply variables
        const promptWf = JSON.parse(JSON.stringify(wfRaw)) as Record<string, unknown>;

        if (params.variables) {
          for (const [key, value] of Object.entries(params.variables)) {
            const varInfo = details.rawVars[key];
            if (varInfo && promptWf[varInfo.nodeId]) {
              const node = promptWf[varInfo.nodeId] as Record<string, unknown>;
              const inputs = (node.inputs ?? {}) as Record<string, unknown>;
              const vals = Array.isArray(value) ? value : [value];
              for (let i = 0; i < vals.length && i < varInfo.keys.length; i++) {
                inputs[varInfo.keys[i]] = vals[i];
              }
            }
          }
        }

        // 4. Map standard prompt variables if they exist
        if (details.rawVars["PositivePrompt"]) {
          const node = promptWf[details.rawVars["PositivePrompt"].nodeId] as Record<string, unknown>;
          const inputs = (node.inputs ?? {}) as Record<string, unknown>;
          if (details.rawVars["PositivePrompt"].keys.length > 0) {
            inputs[details.rawVars["PositivePrompt"].keys[0]] = params.prompt;
          }
        }
        if (params.negative_prompt && details.rawVars["NegativePrompt"]) {
          const node = promptWf[details.rawVars["NegativePrompt"].nodeId] as Record<string, unknown>;
          const inputs = (node.inputs ?? {}) as Record<string, unknown>;
          if (details.rawVars["NegativePrompt"].keys.length > 0) {
            inputs[details.rawVars["NegativePrompt"].keys[0]] = params.negative_prompt;
          }
        }

        // 5. Upload and map input files into [FILE:type:order] slots
        const uploadedInputs: Array<{ slot: number; path: string; uploaded: ComfyUploadResult; key: string }> = [];
        if (params.input_files?.length) {
          const slots = Object.entries(details.fileNodes)
            .map(([order, info]) => ({ order: Number(order), ...info }))
            .sort((a, b) => a.order - b.order);

          if (slots.length === 0) {
            throw new Error("input_files were provided, but this workflow has no [FILE:type:order] input slots.");
          }
          if (params.input_files.length > slots.length) {
            throw new Error(`Received ${params.input_files.length} input file(s), but workflow only has ${slots.length} file slot(s).`);
          }

          for (let i = 0; i < params.input_files.length; i++) {
            const slot = slots[i];
            const inputPath = resolveInputFilePath(cwd, params.input_files[i]);
            if (!fs.existsSync(inputPath)) {
              throw new Error(`Input file not found: ${inputPath}`);
            }

            const key = pickFileInputKey(slot.keys, slot.expectedType);
            if (!key) {
              throw new Error(`File slot ${slot.order} has no inputs to set.`);
            }

            const uploaded = await uploadInputFile(config.serverAddress, inputPath, signal);
            const node = promptWf[slot.nodeId] as Record<string, unknown>;
            const inputs = (node.inputs ?? {}) as Record<string, unknown>;
            inputs[key] = uploaded.name;
            node.inputs = inputs;
            uploadedInputs.push({ slot: slot.order, path: inputPath, uploaded, key });
          }
        }

        // 6. Queue and wait (with progress streaming)
        onUpdate?.({ content: [{ type: "text", text: "Queuing prompt on ComfyUI…" }] });
        promptId = await queuePrompt(config.serverAddress, promptWf, config.clientId, signal);

        const history = await pollHistory(config.serverAddress, promptId, signal, onUpdate);
        const promptHistory = history[promptId];
        if (!promptHistory || !promptHistory.outputs) {
          return {
            content: [{ type: "text", text: "Generation completed but no outputs found." }],
            details: {},
          };
        }

        // 7. Download outputs
        const outputDir = path.join(os.tmpdir(), "pi-paint-outputs");
        fs.mkdirSync(outputDir, { recursive: true });
        const genTimestamp = Date.now();

        const results: Array<{ path: string; filename: string; mimeType: string; data: Buffer }> = [];
        let counter = 0;

        // Prefer tagged output nodes, fallback to all
        const outputNodeIds =
          Object.keys(details.outputTypes).length > 0
            ? Object.keys(details.outputTypes).filter((id) => promptHistory.outputs[id])
            : Object.keys(promptHistory.outputs);

        for (const nodeId of outputNodeIds) {
          const nodeOutput = promptHistory.outputs[nodeId];
          if (!nodeOutput) continue;

          const files = await downloadOutput(config.serverAddress, nodeOutput);
          for (const file of files) {
            const outName = `paint_${genTimestamp}_${counter}.${file.ext}`;
            const outPath = path.join(outputDir, outName);
            fs.writeFileSync(outPath, file.data);
            results.push({
              path: outPath,
              filename: outName,
              mimeType: file.mimeType,
              data: file.data,
            });
            counter++;
          }
        }

        if (results.length === 0) {
          // Fallback: scan all outputs
          for (const nodeOutput of Object.values(promptHistory.outputs)) {
            const files = await downloadOutput(config.serverAddress, nodeOutput);
            for (const file of files) {
              const outName = `paint_${genTimestamp}_${counter}.${file.ext}`;
              const outPath = path.join(outputDir, outName);
              fs.writeFileSync(outPath, file.data);
              results.push({
                path: outPath,
                filename: outName,
                mimeType: file.mimeType,
                data: file.data,
              });
              counter++;
            }
          }
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No images were generated. Check the prompt or workflow variables." }],
            details: {},
          };
        }

        const fileList = results.map((r) => r.path).join("\n");
        const textContent = `Generated ${results.length} file(s):\n${fileList}`;

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
          { type: "text", text: textContent },
        ];
        // Build content blocks for the LLM provider.
        // Images are always compressed (JPEG at COMFYUI_IMAGE_QUALITY, resized
        // to COMFYUI_IMAGE_MAX_DIMENSION) before being sent to the LLM.
        // Original files on disk are never modified.
        //
        // Inline TUI display of image blocks is skipped on native Windows
        // (ConPTY doesn't understand Kitty/iTerm2 protocols) and when
        // PI_PAINT_INLINE=0. The LLM still receives the compressed images
        // regardless — only the terminal rendering is affected.
        const noInline = process.env.PI_PAINT_INLINE === "0"
          || (process.platform === "win32" && process.env.PI_PAINT_INLINE !== "1");

        for (const r of results) {
          if (r.mimeType.startsWith("image/")) {
            const compressed = await compressImageForLLM(
              r.data,
              r.mimeType,
              config.imageQuality,
              config.imageMaxDimension,
            );
            // Always include the compressed image in content so the LLM can see it.
            // The TUI renderer respects PI_PAINT_INLINE / platform to decide
            // whether to emit Kitty/iTerm2 inline display protocols.
            content.push({
              type: "image",
              data: compressed.data,
              mimeType: compressed.mimeType,
            });
          } else if (r.mimeType.startsWith("video/")) {
            // Videos are passed through as-is (too complex to compress inline).
            // Only include if inline display is supported — video frames are
            // large and the LLM can't meaningfully view raw video data anyway.
            if (!noInline) {
              content.push({
                type: "image",
                data: r.data.toString("base64"),
                mimeType: r.mimeType,
              });
            }
          }
        }

        return {
          content,
          details: {
            files: results.map((r) => ({
              path: r.path,
              filename: r.filename,
              mimeType: r.mimeType,
            })),
            promptId,
            uploadedInputs,
          },
        };
      } catch (e) {
        if (signal?.aborted) {
          let interruptMessage = "";
          if (config.interruptOnAbort && promptId) {
            try {
              await interruptComfy(config.serverAddress);
              interruptMessage = " ComfyUI was interrupted because COMFYUI_INTERRUPT_ON_ABORT is enabled.";
            } catch (interruptError) {
              interruptMessage = ` Tried to interrupt ComfyUI, but that failed: ${(interruptError as Error).message}`;
            }
          } else if (promptId) {
            interruptMessage = " ComfyUI may still be running; set COMFYUI_INTERRUPT_ON_ABORT=1 to interrupt it on cancellation.";
          }
          throw new Error(`Paint cancelled.${interruptMessage}`);
        }
        throw new Error(`Paint error: ${(e as Error).message}`);
      }
    },
  });

  // ── paint_get_models ────────────────────────────────────────────────────

  /** Known ComfyUI node classes that expose model lists */
  const MODEL_NODES: Record<string, { key: string; label: string }> = {
    CheckpointLoaderSimple: { key: "ckpt_name", label: "Checkpoints" },
    CheckpointLoader: { key: "ckpt_name", label: "Checkpoints (legacy)" },
    UNETLoader: { key: "unet_name", label: "Diffusion Models" },
    CLIPLoader: { key: "clip_name", label: "CLIP" },
    DualCLIPLoader: { key: "clip_name1", label: "Dual CLIP" },
    VAELoader: { key: "vae_name", label: "VAE" },
    LoraLoader: { key: "lora_name", label: "LoRA" },
    LoraLoaderModelOnly: { key: "lora_name", label: "LoRA (model only)" },
    ControlNetLoader: { key: "control_net_name", label: "ControlNet" },
    UpscaleModelLoader: { key: "model_name", label: "Upscale Models" },
    StyleModelLoader: { key: "style_model_name", label: "Style Models" },
    GLIGENLoader: { key: "gligen_name", label: "GLIGEN" },
    PhotoMakerLoader: { key: "photomaker_model_name", label: "PhotoMaker" },
    InstantIDModelLoader: { key: "instantid_file", label: "InstantID" },
  };

  pi.registerTool({
    name: "paint_get_models",
    label: "Paint Get Models",
    description:
      "Query the ComfyUI server for available models. " +
      "Returns models grouped by category (Checkpoints, LoRAs, VAEs, ControlNets, etc.). " +
      "Use this to discover what models are installed before generating images, " +
      "so you can reference specific model names in prompts or recommend workflows.",
    promptSnippet: "Query ComfyUI for available models (checkpoints, LoRAs, VAEs, etc.)",
    promptGuidelines: [
      "Use paint_get_models to discover installed models before recommending a workflow or selecting a model name for paint variables.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const info = (await comfyFetch(config.serverAddress, "/object_info")) as Record<
          string,
          {
            input?: {
              required?: Record<
                string,
                [Array<unknown>, Record<string, unknown>?]
              >;
            };
          }
        >;

        const models: Record<string, string[]> = {};

        for (const [nodeClass, mapping] of Object.entries(MODEL_NODES)) {
          const nodeInfo = info[nodeClass];
          if (!nodeInfo?.input?.required) continue;

          const param = nodeInfo.input.required[mapping.key];
          if (!param || !Array.isArray(param) || !Array.isArray(param[0])) continue;

          const modelList = param[0] as string[];
          if (modelList.length === 0) continue;

          const label = mapping.label;
          if (!models[label]) {
            models[label] = [];
          }
          models[label].push(...modelList);
        }

        if (Object.keys(models).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No models found. Is ComfyUI running? Check COMFYUI_URL.",
              },
            ],
            details: {},
          };
        }

        const lines: string[] = ["**Available ComfyUI Models:**"];
        for (const [category, names] of Object.entries(models)) {
          const sorted = [...new Set(names)].sort();
          lines.push(`\n**${category}:** ${sorted.join(", ")}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { models },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch models from ComfyUI: ${(e as Error).message}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "paint_queue_status",
    label: "Paint Queue Status",
    description:
      "Check the ComfyUI generation queue. " +
      "Returns the currently running prompt and any pending prompts in the queue. " +
      "Use this before submitting a new generation to avoid piling up redundant requests.",
    promptSnippet: "Check the ComfyUI generation queue (running + pending)",
    promptGuidelines: [
      "Use paint_queue_status before calling paint to check if the ComfyUI queue is busy — avoid submitting redundant generations.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        const queue = (await comfyFetch(config.serverAddress, "/queue")) as {
          queue_running: Array<unknown>;
          queue_pending: Array<unknown>;
        };

        const running = queue.queue_running?.length ?? 0;
        const pending = queue.queue_pending?.length ?? 0;

        if (running === 0 && pending === 0) {
          return {
            content: [{ type: "text", text: "Queue is empty — no generations running or pending." }],
            details: { running: 0, pending: 0 },
          };
        }

        const lines: string[] = [];
        if (running > 0) lines.push(`🔄 **Running:** ${running} prompt(s)`);
        if (pending > 0) lines.push(`⏳ **Pending:** ${pending} prompt(s)`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { running, pending },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to query queue: ${(e as Error).message}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // ── paint_interrupt ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "paint_interrupt",
    label: "Paint Interrupt",
    description:
      "Interrupt the currently running ComfyUI generation. " +
      "Use this when the user wants to cancel an in-progress image generation. " +
      "After interrupting, the queue is cleared and you can submit a new prompt.",
    promptSnippet: "Cancel the currently running ComfyUI generation and clear the queue",
    promptGuidelines: [
      "Use paint_interrupt when the user wants to cancel an in-progress generation. After interrupting, a new paint call can be submitted.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        await interruptComfy(config.serverAddress);
        return {
          content: [{ type: "text", text: "Interrupted. Current generation cancelled and queue cleared." }],
          details: { interrupted: true },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to interrupt: ${(e as Error).message}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // ── Startup notification ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `ComfyUI Paint: ${config.serverAddress} (${config.workflowDir})`,
        "info",
      );
    }
  });
}
