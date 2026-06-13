/**
 * paint tool — main image/video generation via ComfyUI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveWorkflowPath, loadWorkflowJson, parseWorkflowDetails } from "../workflow.js";
import {
  queuePrompt,
  pollHistory,
  uploadInputFile,
  downloadOutput,
  resolveInputFilePath,
  pickFileInputKey,
  interruptComfy,
} from "../comfyui-client.js";
import { compressImageForLLM } from "../image-compression.js";
import type { PaintConfig, GenerationResult, UploadedInput } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";
import type { OnUpdate } from "../types.js";

export function createPaintTool(config: PaintConfig, cwd: string): ToolRegistration {
  return {
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
    parameters: {
      prompt: { type: "string", description: "The positive prompt describing what you want to see." },
      negative_prompt: { type: "optional", description: "What you want to avoid in the generation." },
      workflow: { type: "optional", description: "The workflow file to use (e.g., 'Anime.json'). Call paint_list_workflows to browse, then paint_get_details for that workflow's variables and notes." },
      variables: { type: "optional", description: "Custom variables for the workflow (e.g., {'Width': 1024, 'Height': 1024, 'Seed': 12345}). See paint_get_details for available keys." },
      input_files: { type: "optional", description: "Local image file paths to upload into [FILE:type:order] workflow slots, in slot order. Relative paths are resolved from the current project directory." },
    },
    async execute(params, signal, onUpdate?: OnUpdate) {
      let promptId: string | undefined;
      try {
        // 1. Resolve workflow
        const wfPath = resolveWorkflowPath(
          config.workflowDir,
          params?.workflow as string | undefined,
        );
        const wfRaw = loadWorkflowJson(wfPath);
        if (!wfRaw) {
          throw new Error(`Failed to load workflow: ${wfPath}`);
        }

        // 2. Parse workflow details
        const details = parseWorkflowDetails(wfRaw);

        // 3. Deep clone the workflow and apply variables
        const promptWf = JSON.parse(JSON.stringify(wfRaw)) as Record<string, unknown>;

        const variables = params?.variables as Record<string, unknown> | undefined;
        if (variables) {
          for (const [key, value] of Object.entries(variables)) {
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
            inputs[details.rawVars["PositivePrompt"].keys[0]] = params?.prompt;
          }
        }
        const negPrompt = params?.negative_prompt as string | undefined;
        if (negPrompt && details.rawVars["NegativePrompt"]) {
          const node = promptWf[details.rawVars["NegativePrompt"].nodeId] as Record<string, unknown>;
          const inputs = (node.inputs ?? {}) as Record<string, unknown>;
          if (details.rawVars["NegativePrompt"].keys.length > 0) {
            inputs[details.rawVars["NegativePrompt"].keys[0]] = negPrompt;
          }
        }

        // 5. Upload and map input files into [FILE:type:order] slots
        const uploadedInputs: UploadedInput[] = [];
        const inputFiles = params?.input_files as string[] | undefined;
        if (inputFiles?.length) {
          const slots = Object.entries(details.fileNodes)
            .map(([order, info]) => ({ order: Number(order), ...info }))
            .sort((a, b) => a.order - b.order);

          if (slots.length === 0) {
            throw new Error(
              "input_files were provided, but this workflow has no [FILE:type:order] input slots.",
            );
          }
          if (inputFiles.length > slots.length) {
            throw new Error(
              `Received ${inputFiles.length} input file(s), but workflow only has ${slots.length} file slot(s).`,
            );
          }

          for (let i = 0; i < inputFiles.length; i++) {
            const slot = slots[i];
            const inputPath = resolveInputFilePath(cwd, inputFiles[i]);
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

        const history = await pollHistory(config.serverAddress, promptId, signal);
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

        const results: GenerationResult[] = [];
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
            content: [
              {
                type: "text",
                text: "No images were generated. Check the prompt or workflow variables.",
              },
            ],
            details: {},
          };
        }

        const fileList = results.map((r) => r.path).join("\n");
        const textContent = `Generated ${results.length} file(s):\n${fileList}`;

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
          { type: "text", text: textContent },
        ];

        // Inline TUI display logic
        const noInline =
          process.env.PI_PAINT_INLINE === "0" ||
          (process.platform === "win32" && process.env.PI_PAINT_INLINE !== "1");

        for (const r of results) {
          if (r.mimeType.startsWith("image/")) {
            const compressed = await compressImageForLLM(
              r.data,
              r.mimeType,
              config.imageQuality,
              config.imageMaxDimension,
            );
            content.push({
              type: "image",
              data: compressed.data,
              mimeType: compressed.mimeType,
            });
          } else if (r.mimeType.startsWith("video/")) {
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
              interruptMessage =
                " ComfyUI was interrupted because COMFYUI_INTERRUPT_ON_ABORT is enabled.";
            } catch (interruptError) {
              interruptMessage = ` Tried to interrupt ComfyUI, but that failed: ${(interruptError as Error).message}`;
            }
          } else if (promptId) {
            interruptMessage =
              " ComfyUI may still be running; set COMFYUI_INTERRUPT_ON_ABORT=1 to interrupt it on cancellation.";
          }
          throw new Error(`Paint cancelled.${interruptMessage}`);
        }
        throw new Error(`Paint error: ${(e as Error).message}`);
      }
    },
  };
}
