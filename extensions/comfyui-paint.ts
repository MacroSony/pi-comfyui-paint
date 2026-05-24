/**
 * pi-comfyui-paint
 *
 * Connects to a ComfyUI server for image/video generation.
 *
 * Configuration (env vars or defaults):
 *   COMFYUI_URL          - ComfyUI server address (default: 127.0.0.1:8188)
 *   COMFYUI_WORKFLOW_DIR - Workflow JSON folder
 *                          (default: project's comfyui_workflows/, falls back to package's workflows/)
 *
 * Registers 6 tools:
 *   paint_list_workflows - List available workflow JSON files
 *   paint_get_details    - Inspect workflow variables, notes, etc.
 *   paint_get_models     - Query ComfyUI server for available models
 *   paint_queue_status   - Check current generation queue
 *   paint_interrupt      - Cancel running generation
 *   paint               - Generate images/videos
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Image } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Configuration ───────────────────────────────────────────────────────────

interface PaintConfig {
  serverAddress: string;
  workflowDir: string;
  clientId: string;
}

function getConfig(cwd: string): PaintConfig {
  // Package's own workflows dir as fallback
  const packageWorkflowDir = path.join(__dirname, "..", "workflows");

  let workflowDir: string;
  if (process.env.COMFYUI_WORKFLOW_DIR) {
    workflowDir = process.env.COMFYUI_WORKFLOW_DIR;
  } else {
    const projectDir = path.join(cwd, "comfyui_workflows");
    workflowDir = fs.existsSync(projectDir) ? projectDir : packageWorkflowDir;
  }

  return {
    serverAddress: process.env.COMFYUI_URL || "127.0.0.1:8188",
    workflowDir,
    clientId: `pi-paint-${Math.random().toString(36).slice(2, 10)}`,
  };
}

// ─── Workflow JSON helpers ───────────────────────────────────────────────────

interface WorkflowVariables {
  [name: string]: { nodeId: string; keys: string[]; defaults: unknown[] };
}

interface WorkflowDetails {
  notes: string;
  variables: Record<string, unknown>;
  outputTypes: Record<string, string>;
  inputSlots: Record<number, { keys: string[]; expectedType: string }>;
  fileNodes: Record<number, { nodeId: string; keys: string[]; expectedType: string }>;
}

function loadWorkflowJson(workflowPath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(workflowPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseWorkflowDetails(wf: Record<string, unknown>): WorkflowDetails {
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
  } as WorkflowDetails & { rawVars: typeof rawVars };
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
): Promise<string> {
  const body = JSON.stringify({ prompt: workflow, client_id: clientId });
  const result = (await comfyFetch(server, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })) as ComfyUIQueueResult;
  return result.prompt_id;
}

async function pollHistory(
  server: string,
  promptId: string,
  maxWaitMs = 600_000,
  pollIntervalMs = 1000,
): Promise<ComfyUIHistoryOutput> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const history = (await comfyFetch(server, `/history/${promptId}`)) as ComfyUIHistoryOutput;
    // Check if the prompt_id is present (meaning execution completed)
    if (history[promptId]) {
      return history;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Timeout waiting for ComfyUI prompt ${promptId} after ${maxWaitMs}ms`);
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
    parameters: Type.Object({}),
    async execute() {
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
    parameters: Type.Object({
      workflow: Type.Optional(
        Type.String({
          description:
            "The name of the workflow file to inspect (e.g., 'SDXL_example.json'). If omitted, uses the first available workflow.",
        }),
      ),
    }),
    async execute(_id, params) {
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

  // ── paint ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "paint",
    label: "Paint",
    description:
      "Generates an image or video using ComfyUI with a prompt and optional workflow variables. " +
      "Returns the generated file paths. " +
      "You can specify a 'workflow' to change the style, and pass 'variables' to customize the generation process. " +
      "Call paint_list_workflows to browse available workflows, then paint_get_details for any workflow's variables and notes.",
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
    }),
    async execute(_id, params, signal) {
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
            const varInfo = (details as WorkflowDetails & { rawVars: Record<string, { nodeId: string; keys: string[] }> }).rawVars?.[key];
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
        const rawVars = (details as WorkflowDetails & { rawVars: Record<string, { nodeId: string; keys: string[] }> }).rawVars ?? {};
        if (rawVars["PositivePrompt"]) {
          const node = promptWf[rawVars["PositivePrompt"].nodeId] as Record<string, unknown>;
          const inputs = (node.inputs ?? {}) as Record<string, unknown>;
          if (rawVars["PositivePrompt"].keys.length > 0) {
            inputs[rawVars["PositivePrompt"].keys[0]] = params.prompt;
          }
        }
        if (params.negative_prompt && rawVars["NegativePrompt"]) {
          const node = promptWf[rawVars["NegativePrompt"].nodeId] as Record<string, unknown>;
          const inputs = (node.inputs ?? {}) as Record<string, unknown>;
          if (rawVars["NegativePrompt"].keys.length > 0) {
            inputs[rawVars["NegativePrompt"].keys[0]] = params.negative_prompt;
          }
        }

        // 5. Queue and wait
        const promptId = await queuePrompt(config.serverAddress, promptWf, config.clientId);

        const history = await pollHistory(config.serverAddress, promptId);
        const promptHistory = history[promptId];
        if (!promptHistory || !promptHistory.outputs) {
          return {
            content: [{ type: "text", text: "Generation completed but no outputs found." }],
            details: {},
          };
        }

        // 6. Download outputs
        const outputDir = path.join(os.tmpdir(), "pi-paint-outputs");
        fs.mkdirSync(outputDir, { recursive: true });

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
            const outPath = path.join(outputDir, `generation_${counter}.${file.ext}`);
            fs.writeFileSync(outPath, file.data);
            results.push({
              path: outPath,
              filename: `generation_${counter}.${file.ext}`,
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
              const outPath = path.join(outputDir, `generation_${counter}.${file.ext}`);
              fs.writeFileSync(outPath, file.data);
              results.push({
                path: outPath,
                filename: `generation_${counter}.${file.ext}`,
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

        return {
          content: [{ type: "text", text: textContent }],
          details: {
            files: results.map((r) => ({
              path: r.path,
              filename: r.filename,
              mimeType: r.mimeType,
              data: r.data.toString("base64"),
            })),
            promptId,
          },
        };
      } catch (e) {
        throw new Error(`Paint error: ${(e as Error).message}`);
      }
    },

    renderResult(result, _options, theme, _context) {
      const files = result.details?.files as Array<{
        path: string;
        filename: string;
        mimeType: string;
        data: string;
      }> | undefined;
      if (!files || files.length === 0 || !files.some((f) => f.mimeType?.startsWith("image/"))) {
        return null; // fallback to default text rendering
      }

      const container = new Container();
      for (const file of files) {
        if (file.mimeType?.startsWith("image/") && file.data) {
          container.addChild(
            new Image(
              file.data,
              file.mimeType,
              { fallbackColor: (s: string) => theme.fg("muted", s) },
              { maxWidthCells: 60, filename: file.filename },
            ),
          );
        }
      }
      return container;
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
    parameters: Type.Object({}),
    async execute() {
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
    parameters: Type.Object({}),
    async execute() {
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
    parameters: Type.Object({}),
    async execute() {
      try {
        await comfyFetch(config.serverAddress, "/interrupt", { method: "POST" });
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
