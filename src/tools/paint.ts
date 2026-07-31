/**
 * paint tool — main image/video generation via ComfyUI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveWorkflowPath, loadWorkflowJson, parseWorkflowDetails } from "../workflow.js";
import {
  applyPowerLoraOverrides,
  getInstalledLoras,
  loadLoraMetadata,
  normalizeLoraOverrides,
  validateLoraOverridesInstalled,
} from "../lora.js";
import {
  queuePrompt,
  pollHistory,
  uploadInputFile,
  downloadOutput,
  resolveInputFilePath,
  pickFileInputKey,
  interruptComfy,
  extractExecutionError,
} from "../comfyui-client.js";
import { compressImageForLLM } from "../image-compression.js";
import type { PaintConfig, GenerationResult, UploadedInput } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";
import type { OnUpdate } from "../types.js";

/**
 * Build a warning when [FILE:type:order] slots are left uncovered by input_files.
 * Uncovered slots silently fall back to their node defaults, which often surprises
 * users into thinking their prompt was used as text-to-image.
 * Returns undefined when there is nothing to warn about.
 */
export function collectFileSlotWarnings(
  wfRaw: Record<string, unknown>,
  inputFiles: unknown,
  fileSlots: Array<{ order: number; nodeId: string; keys: string[]; expectedType: string }>,
): string | undefined {
  if (fileSlots.length === 0) return undefined;
  const providedCount = Array.isArray(inputFiles) ? inputFiles.length : 0;
  if (providedCount >= fileSlots.length) return undefined;
  const uncovered = fileSlots.slice(providedCount);
  const defaults = uncovered
    .map((slot) => {
      const node = wfRaw[slot.nodeId] as Record<string, unknown> | undefined;
      const inputs = (node?.inputs ?? {}) as Record<string, unknown>;
      let nonString = false;
      for (const key of slot.keys) {
        // Skip the LoadImage "upload" widget key — its literal default is not a file.
        if (key === "upload") continue;
        const v = inputs[key];
        if (typeof v === "string" && v.trim() !== "") {
          return `slot ${slot.order} → ${v}`;
        }
        if (v !== null && v !== undefined && typeof v !== "string") {
          nonString = true;
        }
      }
      return nonString
        ? `slot ${slot.order} → (default present, non-string)`
        : `slot ${slot.order} → (no default)`;
    })
    .join("; ");
  const missing = uncovered.map((s) => s.order).join(", ");
  return (
    `workflow has ${fileSlots.length} [FILE] input slot(s) but only ${providedCount} of ` +
    `${fileSlots.length} input file(s) provided; the file input node(s) for slot(s) ${missing} ` +
    `will fall back to their default inputs (${defaults})`
  );
}

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
      "Use paint_server_status before paint to check the ComfyUI queue and avoid piling up redundant requests if it is busy.",
      "Use paint_interrupt to cancel a running generation if the user changes their mind.",
      "If paint_get_details reports LoRA slots or usable LoRA metadata, pass `loras` overrides using those slot names, copy any activationPrompt into `prompt`, and use `paint_get_models` to confirm valid `file` names. Use forward slashes in paths.",
      "Custom workflows: write your own ComfyUI API-format workflow JSON into .pi/comfyui_workflows/ and reference it by name. [VAR]/[OUTPUT]/[FILE]/[LORA] annotations are optional — an unannotated workflow runs as-is (prompt/variables ignored, all output nodes downloaded). See the pi-comfyui-paint-custom-workflow skill for the full guide.",
    ],
    prepareArguments(args) {
      // Some models (Opus 4.6, GLM-5.1) send object/array params as JSON strings instead
      // of parsed JSON. Parse them back so the execute() body receives real objects.
      if (!args || typeof args !== "object") return args as Record<string, unknown>;
      const a = args as Record<string, unknown>;
      for (const key of ["variables", "loras", "input_files"]) {
        const v = a[key];
        if (typeof v === "string" && v.trim().length > 0) {
          try {
            a[key] = JSON.parse(v);
          } catch {
            // leave as-is; execute() will surface a clear error if shape is wrong
          }
        }
      }
      // A single plain file path string (not JSON) counts as one input file.
      if (typeof a.input_files === "string" && a.input_files.trim().length > 0) {
        a.input_files = [a.input_files];
      }
      return a;
    },
    parameters: {
      prompt: { type: "string", description: "The positive prompt describing what you want to see." },
      negative_prompt: { type: "optional", valueType: "string", description: "What you want to avoid in the generation." },
      workflow: { type: "optional", valueType: "string", description: "The workflow file to use (e.g., 'Anime.json'). Call paint_list_workflows to browse, then paint_get_details for that workflow's variables and notes." },
      variables: { type: "optional", description: "Custom variables for the workflow (e.g., {'Width': 1024, 'Height': 1024, 'Seed': 12345}). See paint_get_details for available keys." },
      input_files: { type: "optional", description: "Local image file paths to upload into [FILE:type:order] workflow slots, in slot order. Relative paths are resolved from the current project directory." },
      loras: { type: "optional", description: "Optional LoRA overrides for [LORA:slot] Power Lora Loader slots. Preferred shape: {'base_style': {file:'...', strength:0.7}} or {'base_style': [{file:'...', strength:0.7}, ...]}. Overrides replace the contents of that slot. Slot names come from paint_get_details (LoRA slots); valid 'file' values come from paint_get_models (LoRA category) or the 'Usable LoRA metadata' in paint_get_details. Use POSIX path separators (forward slash '/'). If a LoRA has an activationPrompt in its metadata, add it to 'prompt' yourself — it is not added automatically. Omitted strength defaults to the sidecar's defaultStrength, else 0.7." },
    },
    async execute(params, signal, onUpdate?: OnUpdate) {
      let promptId: string | undefined;
      try {
        const startTime = Date.now();
        // 1. Resolve workflow
        const wfPath = resolveWorkflowPath(
          config.workflowDir,
          params?.workflow as string | undefined,
          config.bundledWorkflowDir,
        );
        const wfRaw = loadWorkflowJson(wfPath);
        if (!wfRaw) {
          throw new Error(`Failed to load workflow: ${wfPath}`);
        }

        // 2. Parse workflow details
        const details = parseWorkflowDetails(wfRaw);
        const loraMetadata = loadLoraMetadata(wfPath);

        // 2.5 Warn when the workflow has [FILE:type:order] slots but fewer input_files
        //     were provided than slots exist. Uncovered slots silently fall back to
        //     their node defaults, which often surprises users into thinking their
        //     prompt was used as text-to-image.
        const warnings: string[] = [];
        const fileSlots = Object.entries(details.fileNodes)
          .map(([order, info]) => ({ order: Number(order), ...info }))
          .sort((a, b) => a.order - b.order);
        const fileSlotWarning = collectFileSlotWarnings(wfRaw, params?.input_files, fileSlots);
        if (fileSlotWarning) warnings.push(fileSlotWarning);

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

        // 5. Apply LoRA overrides into annotated/auto-detected Power Lora Loader slots.
        const loraOverrides = normalizeLoraOverrides(params?.loras);
        if (loraOverrides.length > 0) {
          const installedLoras = await getInstalledLoras(config.serverAddress);
          validateLoraOverridesInstalled(loraOverrides, installedLoras);
        }
        const appliedLoras = loraOverrides.length > 0
          ? applyPowerLoraOverrides(promptWf, details.loraSlots, loraOverrides, loraMetadata)
          : { applied: [] };

        // 6. Upload and map input files into [FILE:type:order] slots
        const uploadedInputs: UploadedInput[] = [];
        const rawInputFiles = params?.input_files;
        if (
          rawInputFiles != null &&
          (!Array.isArray(rawInputFiles) ||
            rawInputFiles.some((file) => typeof file !== "string"))
        ) {
          throw new Error("input_files must be an array of local file path strings.");
        }
        const inputFiles = rawInputFiles as string[] | undefined;
        if (inputFiles?.length) {
          const slots = fileSlots;

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

        // 7. Queue and wait (with progress streaming)
        onUpdate?.({ content: [{ type: "text", text: "Queuing prompt on ComfyUI…" }] });
        promptId = await queuePrompt(config.serverAddress, promptWf, config.clientId, signal);

        const history = await pollHistory(
          config.serverAddress,
          promptId,
          signal,
          600_000,
          1000,
          (elapsedMs) => {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Waiting for ComfyUI… ${Math.round(elapsedMs / 1000)}s elapsed`,
                },
              ],
            });
          },
        );
        const promptHistory = history[promptId];

        // Surface ComfyUI execution failures instead of reporting "no outputs".
        const executionError = extractExecutionError(history, promptId);
        if (executionError) {
          return {
            content: [
              { type: "text", text: `ComfyUI generation failed: ${executionError}` },
            ],
            details: {
              promptId,
              error: executionError,
              ...(warnings.length > 0 ? { warnings } : {}),
            },
          };
        }

        if (!promptHistory || !promptHistory.outputs) {
          return {
            content: [{ type: "text", text: "Generation completed but no outputs found." }],
            details: {
              promptId,
              ...(warnings.length > 0 ? { warnings } : {}),
            },
          };
        }

        // 8. Download outputs
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
            details: {
              promptId,
              workflow: path.basename(wfPath),
              ...(warnings.length > 0 ? { warnings } : {}),
            },
          };
        }

        const fileList = results.map((r) => r.path).join("\n");
        // Generation wall time — stops before image compression / writing to disk.
        const generationElapsedMs = Date.now() - startTime;
        const elapsedText =
          generationElapsedMs >= 1000
            ? `${(generationElapsedMs / 1000).toFixed(1)}s`
            : `${generationElapsedMs}ms`;
        // Mark bundled-sourced workflows so a same-named project/bundled pair is
        // distinguishable in the output.
        const wfName = path.basename(wfPath);
        const bundledMarker =
          config.bundledWorkflowDir &&
          path.resolve(path.dirname(wfPath)) === path.resolve(config.bundledWorkflowDir)
            ? " (bundled)"
            : "";
        const textParts: string[] = [];
        for (const warning of warnings) {
          textParts.push(`⚠️ ${warning}`);
        }
        textParts.push(
          `Generated ${results.length} file(s):`,
          fileList,
          `Workflow: ${wfName}${bundledMarker}`,
          `⏱️ Generation time: ${elapsedText}`,
        );
        const textContent = textParts.join("\n");

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
            workflow: path.basename(wfPath),
            workflowPath: wfPath,
            generationElapsedMs,
            ...(warnings.length > 0 ? { warnings } : {}),
            uploadedInputs,
            appliedLoras: appliedLoras.applied,
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
