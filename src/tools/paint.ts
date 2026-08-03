/**
 * paint tool — main image/video generation via ComfyUI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
import { createGenerationOutputDir, writeGeneratedFile } from "../output-storage.js";
import type {
  DownloadedOutput,
  GenerationResult,
  InlineImagePreview,
  PaintConfig,
  UploadedInput,
} from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

/**
 * Build a warning when [FILE:type:order] slots are left uncovered by input_files.
 * Uncovered slots silently fall back to their node defaults, which often surprises
 * users into thinking their prompt was used as text-to-image.
 * Returns undefined when there is nothing to warn about.
 */
export function collectFileSlotWarnings(
  wfRaw: Record<string, unknown>,
  inputFiles: unknown,
  fileSlots: Array<{ order: number; nodeId: string; keys: string[]; expectedType: string; optional?: boolean }>,
): string | undefined {
  if (fileSlots.length === 0) return undefined;
  const providedCount = Array.isArray(inputFiles) ? inputFiles.length : 0;
  if (providedCount >= fileSlots.length) return undefined;
  // Uncovered OPTIONAL slots are disconnected from the graph on purpose — no warning.
  const uncovered = fileSlots.slice(providedCount).filter((slot) => !slot.optional);
  if (uncovered.length === 0) return undefined;
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
    async execute(
      params,
      signal,
      onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
    ) {
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

        const rawVariables = params?.variables;
        if (
          rawVariables != null &&
          (typeof rawVariables !== "object" || Array.isArray(rawVariables))
        ) {
          throw new Error("variables must be a JSON object keyed by workflow variable name.");
        }
        const variables = rawVariables as Record<string, unknown> | undefined;
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
        const rawLoras = params?.loras;
        if (rawLoras != null && typeof rawLoras !== "object") {
          throw new Error(
            "loras must be a JSON object keyed by LoRA slot name or a legacy override array.",
          );
        }
        const loraOverrides = normalizeLoraOverrides(rawLoras);
        if (loraOverrides.length > 0) {
          const installedLoras = await getInstalledLoras(config.serverAddress, signal);
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

        // 6.5 Remove uncovered OPTIONAL [FILE] slot nodes entirely: delete the node
        //     and strip every downstream input link pointing at it, so optional image
        //     inputs (e.g. MiniMaxH3 first_frame/last_frame, ref_image_N) simply stay
        //     unconnected and the model runs in its no-input mode (t2v).
        const coveredOrders = new Set(uploadedInputs.map((u) => u.slot));
        const uncoveredOptional = fileSlots.filter(
          (slot) => slot.optional && !coveredOrders.has(slot.order),
        );
        if (uncoveredOptional.length > 0) {
          const removedIds = new Set(uncoveredOptional.map((slot) => slot.nodeId));
          for (const id of removedIds) delete promptWf[id];
          for (const node of Object.values(promptWf)) {
            const inputs = (node as Record<string, unknown>).inputs as
              | Record<string, unknown>
              | undefined;
            if (!inputs) continue;
            for (const [key, value] of Object.entries(inputs)) {
              if (Array.isArray(value) && typeof value[0] === "string" && removedIds.has(value[0])) {
                delete inputs[key];
              }
            }
          }
        }

        // 7. Queue and wait (with progress streaming)
        onUpdate?.({
          content: [{ type: "text", text: "Queuing prompt on ComfyUI…" }],
          details: {},
        });
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
              details: { promptId, elapsedMs },
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

        // 8. Download outputs into a private, collision-free generation directory.
        const outputStorage = createGenerationOutputDir(
          config.outputDir,
          config.outputRetentionHours,
          config.outputDirIsDefault,
        );
        const outputDir = outputStorage.outputDir;
        const genTimestamp = Date.now();

        const results: GenerationResult[] = [];
        const inlinePreviews: InlineImagePreview[] = [];
        const previewFailures: Array<{ path: string; error: string }> = [];
        const previewCandidates: Array<{ path: string; data: Buffer }> = [];
        let totalPreviewBytes = 0;
        let generatedImageCount = 0;
        let counter = 0;

        const saveDownloadedFile = (file: DownloadedOutput): void => {
          const outName = `paint_${genTimestamp}_${counter}.${file.ext}`;
          const outPath = path.join(outputDir, outName);
          writeGeneratedFile(outPath, file.data);
          results.push({
            path: outPath,
            filename: outName,
            mimeType: file.mimeType,
          });
          counter++;

          if (!file.mimeType.startsWith("image/")) return;
          generatedImageCount++;
          if (previewCandidates.length < config.inlineImageLimit) {
            previewCandidates.push({ path: outPath, data: file.data });
          }
        };

        // Prefer tagged output nodes, fallback to all
        const outputNodeIds =
          Object.keys(details.outputTypes).length > 0
            ? Object.keys(details.outputTypes).filter((id) => promptHistory.outputs[id])
            : Object.keys(promptHistory.outputs);

        for (const nodeId of outputNodeIds) {
          const nodeOutput = promptHistory.outputs[nodeId];
          if (!nodeOutput) continue;

          const files = await downloadOutput(config.serverAddress, nodeOutput, signal);
          for (const file of files) {
            saveDownloadedFile(file);
          }
        }

        if (results.length === 0) {
          // Fallback: scan all outputs
          for (const nodeOutput of Object.values(promptHistory.outputs)) {
            const files = await downloadOutput(config.serverAddress, nodeOutput, signal);
            for (const file of files) {
              saveDownloadedFile(file);
            }
          }
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No output files were available. Check the prompt or workflow variables.",
              },
            ],
            details: {
              promptId,
              workflow: path.basename(wfPath),
              ...(warnings.length > 0 ? { warnings } : {}),
            },
          };
        }

        // Generation wall time includes output download and private disk writes,
        // but excludes the bounded inline-preview processing below.
        const generationElapsedMs = Date.now() - startTime;

        for (const candidate of previewCandidates) {
          const remainingTotalBytes = config.imageTotalMaxBytes - totalPreviewBytes;
          if (remainingTotalBytes < 1024) break;

          try {
            const preview = await compressImageForLLM(
              candidate.data,
              config.imageQuality,
              config.imageMaxDimension,
              Math.min(config.imageMaxBytes, remainingTotalBytes),
            );
            totalPreviewBytes += preview.encodedBytes;
            inlinePreviews.push({ path: candidate.path, ...preview });
          } catch (error) {
            previewFailures.push({
              path: candidate.path,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const fileList = results.map((r) => r.path).join("\n");
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
        if (generatedImageCount > 0) {
          textParts.push(
            `Inline previews: ${inlinePreviews.length} of ${generatedImageCount} image(s); originals are available at the paths above.`,
          );
        }
        if (previewFailures.length > 0) {
          textParts.push(
            `⚠️ ${previewFailures.length} image preview(s) could not be prepared; originals are still available by path.`,
          );
        }
        const textContent = textParts.join("\n");

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [
          { type: "text", text: textContent },
          ...inlinePreviews.map((preview) => ({
            type: "image" as const,
            data: preview.data,
            mimeType: preview.mimeType,
          })),
        ];

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
            outputDir,
            removedExpiredOutputDirs: outputStorage.removedExpired,
            inlinePreviews: inlinePreviews.map(({ data: _data, ...preview }) => preview),
            ...(previewFailures.length > 0 ? { previewFailures } : {}),
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
