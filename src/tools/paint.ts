/** Main image/video generation tool with durable background jobs. */

import * as fs from "node:fs";
import * as path from "node:path";
import { reserveBackend } from "../backends.js";
import {
  ComfyHttpError,
  PollTimeoutError,
  extractExecutionError,
  pickFileInputKey,
  pollHistory,
  queuePrompt,
  resolveInputFilePath,
  uploadInputFile,
} from "../comfyui-client.js";
import {
  createJob,
  generatePaintJobId,
  rewriteWorkflowSnapshot,
  updateJob,
} from "../job-store.js";
import {
  cancelJob,
  finalizeJob,
  formatJobResult,
  reconcileJob,
} from "../job-runner.js";
import {
  applyPowerLoraOverrides,
  getInstalledLoras,
  loadLoraMetadata,
  normalizeLoraOverrides,
  validateLoraOverridesInstalled,
} from "../lora.js";
import { loadWorkflowJson, parseWorkflowDetails, resolveWorkflowPath } from "../workflow.js";
import type { PaintConfig, PaintJobRecord, UploadedInput } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

interface FileSlot {
  order: number;
  nodeId: string;
  keys: string[];
  expectedType: string;
  optional?: boolean;
}

/** Warn when required [FILE] slots are not covered by input_files. */
export function collectFileSlotWarnings(
  wfRaw: Record<string, unknown>,
  inputFiles: unknown,
  fileSlots: FileSlot[],
): string | undefined {
  if (fileSlots.length === 0) return undefined;
  const providedCount = Array.isArray(inputFiles) ? inputFiles.length : 0;
  if (providedCount >= fileSlots.length) return undefined;
  const uncovered = fileSlots.slice(providedCount).filter((slot) => !slot.optional);
  if (uncovered.length === 0) return undefined;
  const defaults = uncovered
    .map((slot) => {
      const node = wfRaw[slot.nodeId] as Record<string, unknown> | undefined;
      const inputs = (node?.inputs ?? {}) as Record<string, unknown>;
      let nonString = false;
      for (const key of slot.keys) {
        if (key === "upload") continue;
        const value = inputs[key];
        if (typeof value === "string" && value.trim() !== "") {
          return `slot ${slot.order} → ${value}`;
        }
        if (value !== null && value !== undefined && typeof value !== "string") {
          nonString = true;
        }
      }
      return nonString
        ? `slot ${slot.order} → (default present, non-string)`
        : `slot ${slot.order} → (no default)`;
    })
    .join("; ");
  const missing = uncovered.map((slot) => slot.order).join(", ");
  return (
    `workflow has ${fileSlots.length} [FILE] input slot(s) but only ${providedCount} of ` +
    `${fileSlots.length} input file(s) provided; the file input node(s) for slot(s) ${missing} ` +
    `will fall back to their default inputs (${defaults})`
  );
}

/** Disconnect uncovered optional file nodes and their direct downstream links. */
export function removeUncoveredOptionalFileSlots(
  workflow: Record<string, unknown>,
  fileSlots: FileSlot[],
  coveredOrders: Set<number>,
): void {
  const removedIds = new Set(
    fileSlots
      .filter((slot) => slot.optional && !coveredOrders.has(slot.order))
      .map((slot) => slot.nodeId),
  );
  if (removedIds.size === 0) return;
  for (const id of removedIds) delete workflow[id];
  for (const node of Object.values(workflow)) {
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

/** Scope Save-node filename prefixes by job ID so outputs remain attributable after history loss. */
export function applyJobOutputPrefixes(
  workflow: Record<string, unknown>,
  outputNodeIds: string[],
  jobId: string,
): string | undefined {
  const outputPrefix = `paint/${jobId}`;
  let applied = false;
  for (const nodeId of outputNodeIds) {
    const node = workflow[nodeId] as Record<string, unknown> | undefined;
    if (!node) continue;
    const inputs = (node.inputs ?? {}) as Record<string, unknown>;
    const current = inputs.filename_prefix;
    if (typeof current !== "string" || !current.trim() || current.startsWith(`${outputPrefix}/`)) continue;
    inputs.filename_prefix = `${outputPrefix}/${current.replace(/^\/+/, "")}`;
    node.inputs = inputs;
    applied = true;
  }
  return applied ? outputPrefix : undefined;
}

function backgroundResult(job: PaintJobRecord) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Queued background paint job ${job.id}.\n` +
          `Backend: ${job.backend.id} (${job.backend.url})\n` +
          `ComfyUI prompt: ${job.promptId}\n` +
          `Workflow: ${job.workflow}\n` +
          "Use paint_job_status with this job ID to check progress and retrieve outputs.",
      },
    ],
    details: {
      jobId: job.id,
      state: job.state,
      backend: job.backend,
      promptId: job.promptId,
      workflow: job.workflow,
      workflowPath: job.workflowPath,
    },
  };
}

export function createPaintTool(config: PaintConfig, cwd: string): ToolRegistration {
  return {
    name: "paint",
    label: "Paint",
    description:
      "Generate an image or video using ComfyUI. Returns generated paths and bounded image previews. " +
      "Set background=true for long jobs; the returned job continues in ComfyUI after Pi exits. " +
      "An optional backend ID can force a particular configured ComfyUI server.",
    promptSnippet:
      "Generate images/videos via ComfyUI, optionally as a durable background job",
    promptGuidelines: [
      "Call paint_list_workflows and paint_get_details before generating with an unfamiliar workflow.",
      "Use background=true for long video workflows, then use paint_job_status to retrieve the result later.",
      "Use paint_server_status before generating to inspect backend health and queues.",
      "Use paint_job_cancel for a specific durable job; paint_interrupt is a backend-wide escape hatch.",
      "If paint_get_details reports LoRA slots, pass loras by slot and use paint_get_models to confirm installed file names.",
      "Custom workflows may use optional [VAR]/[OUTPUT]/[FILE]/[LORA] annotations; see the pi-comfyui-paint-custom-workflow skill.",
    ],
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args as Record<string, unknown>;
      const prepared = args as Record<string, unknown>;
      for (const key of ["variables", "loras", "input_files"]) {
        const value = prepared[key];
        if (typeof value === "string" && value.trim().length > 0) {
          try {
            prepared[key] = JSON.parse(value);
          } catch {
            // execute() reports malformed shapes clearly.
          }
        }
      }
      if (typeof prepared.input_files === "string" && prepared.input_files.trim()) {
        prepared.input_files = [prepared.input_files];
      }
      return prepared;
    },
    parameters: {
      prompt: { type: "string", description: "The positive prompt describing what you want to see." },
      negative_prompt: { type: "optional", valueType: "string", description: "What you want to avoid." },
      workflow: { type: "optional", valueType: "string", description: "Workflow name or absolute workflow path." },
      variables: { type: "optional", description: "Workflow variables from paint_get_details." },
      input_files: { type: "optional", description: "Local files for [FILE:type:order] slots, in order." },
      loras: { type: "optional", description: "LoRA overrides keyed by [LORA:slot] name." },
      background: { type: "optional", valueType: "boolean", description: "Return after ComfyUI accepts the prompt instead of waiting for completion." },
      backend: { type: "optional", valueType: "string", description: "Configured ComfyUI backend ID. Omit for least-queued automatic selection." },
    },
    async execute(
      params,
      signal,
      onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
    ) {
      let job: PaintJobRecord | undefined;
      let reservation: Awaited<ReturnType<typeof reserveBackend>> | undefined;
      let submitting = false;
      try {
        const wfPath = resolveWorkflowPath(
          config.workflowDir,
          params?.workflow as string | undefined,
          config.bundledWorkflowDir,
        );
        const wfRaw = loadWorkflowJson(wfPath);
        if (!wfRaw) throw new Error(`Failed to load workflow: ${wfPath}`);

        const details = parseWorkflowDetails(wfRaw);
        const fileSlots = Object.entries(details.fileNodes)
          .map(([order, info]) => ({ order: Number(order), ...info }))
          .sort((a, b) => a.order - b.order);
        const warnings: string[] = [];
        const slotWarning = collectFileSlotWarnings(wfRaw, params?.input_files, fileSlots);
        if (slotWarning) warnings.push(slotWarning);

        const rawVariables = params?.variables;
        if (rawVariables != null && (typeof rawVariables !== "object" || Array.isArray(rawVariables))) {
          throw new Error("variables must be a JSON object keyed by workflow variable name.");
        }
        const variables = rawVariables as Record<string, unknown> | undefined;

        const rawLoras = params?.loras;
        if (rawLoras != null && typeof rawLoras !== "object") {
          throw new Error("loras must be a JSON object keyed by LoRA slot name or a legacy override array.");
        }
        const loraOverrides = normalizeLoraOverrides(rawLoras);

        const rawInputFiles = params?.input_files;
        if (
          rawInputFiles != null &&
          (!Array.isArray(rawInputFiles) || rawInputFiles.some((file) => typeof file !== "string"))
        ) {
          throw new Error("input_files must be an array of local file path strings.");
        }
        const inputFiles = (rawInputFiles as string[] | undefined) ?? [];
        if (inputFiles.length > fileSlots.length) {
          throw new Error(
            fileSlots.length === 0
              ? "input_files were provided, but this workflow has no [FILE:type:order] input slots."
              : `Received ${inputFiles.length} input file(s), but workflow only has ${fileSlots.length} file slot(s).`,
          );
        }
        const resolvedInputPaths = inputFiles.map((input) => resolveInputFilePath(cwd, input));
        for (const inputPath of resolvedInputPaths) {
          if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
        }

        const promptWorkflow = JSON.parse(JSON.stringify(wfRaw)) as Record<string, unknown>;
        if (variables) {
          for (const [key, value] of Object.entries(variables)) {
            const info = details.rawVars[key];
            if (!info || !promptWorkflow[info.nodeId]) continue;
            const node = promptWorkflow[info.nodeId] as Record<string, unknown>;
            const inputs = (node.inputs ?? {}) as Record<string, unknown>;
            const values = Array.isArray(value) ? value : [value];
            for (let index = 0; index < values.length && index < info.keys.length; index++) {
              inputs[info.keys[index]] = values[index];
            }
          }
        }
        const positiveInfo = details.rawVars.PositivePrompt;
        if (positiveInfo?.keys.length && promptWorkflow[positiveInfo.nodeId]) {
          const node = promptWorkflow[positiveInfo.nodeId] as Record<string, unknown>;
          ((node.inputs ?? {}) as Record<string, unknown>)[positiveInfo.keys[0]] = params?.prompt;
        }
        const negativePrompt = params?.negative_prompt as string | undefined;
        const negativeInfo = details.rawVars.NegativePrompt;
        if (negativePrompt && negativeInfo?.keys.length && promptWorkflow[negativeInfo.nodeId]) {
          const node = promptWorkflow[negativeInfo.nodeId] as Record<string, unknown>;
          ((node.inputs ?? {}) as Record<string, unknown>)[negativeInfo.keys[0]] = negativePrompt;
        }

        onUpdate?.({
          content: [{ type: "text", text: "Selecting a ComfyUI backend…" }],
          details: {},
        });
        reservation = await reserveBackend(
          config.backends,
          params?.backend as string | undefined,
          signal,
        );
        const backend = reservation.backend;

        if (loraOverrides.length > 0) {
          const installedLoras = await getInstalledLoras(backend.url, signal);
          validateLoraOverridesInstalled(loraOverrides, installedLoras);
        }
        const loraMetadata = loadLoraMetadata(wfPath);
        const appliedLoras = loraOverrides.length > 0
          ? applyPowerLoraOverrides(promptWorkflow, details.loraSlots, loraOverrides, loraMetadata)
          : { applied: [] };

        const outputNodeIds = Object.keys(details.outputTypes);
        const jobId = generatePaintJobId(config.jobIdStyle);
        const outputPrefix = applyJobOutputPrefixes(promptWorkflow, outputNodeIds, jobId);
        job = createJob(config, {
          id: jobId,
          backend,
          clientId: config.clientId,
          workflow: path.basename(wfPath),
          workflowPath: wfPath,
          promptWorkflow,
          outputNodeIds,
          outputPrefix,
          prompt: params?.prompt as string | undefined,
          negativePrompt,
          variables,
          loras: rawLoras,
          sourceInputPaths: resolvedInputPaths,
          warnings,
          appliedLoras: appliedLoras.applied,
        });

        const uploadedInputs: UploadedInput[] = [];
        for (let index = 0; index < resolvedInputPaths.length; index++) {
          const slot = fileSlots[index];
          const key = pickFileInputKey(slot.keys, slot.expectedType);
          if (!key) throw new Error(`File slot ${slot.order} has no inputs to set.`);
          const uploaded = await uploadInputFile(backend.url, resolvedInputPaths[index], signal);
          const node = promptWorkflow[slot.nodeId] as Record<string, unknown>;
          const inputs = (node.inputs ?? {}) as Record<string, unknown>;
          inputs[key] = uploaded.name;
          node.inputs = inputs;
          uploadedInputs.push({ slot: slot.order, path: resolvedInputPaths[index], uploaded, key });
        }
        removeUncoveredOptionalFileSlots(
          promptWorkflow,
          fileSlots,
          new Set(uploadedInputs.map((input) => input.slot)),
        );
        job = rewriteWorkflowSnapshot(job, promptWorkflow);
        job = updateJob(job, { uploadedInputs });

        onUpdate?.({
          content: [{ type: "text", text: `Queuing job ${job.id} on ${backend.id}…` }],
          details: { jobId: job.id, backend },
        });
        job = updateJob(job, { state: "submitting" });
        submitting = true;
        const promptId = await queuePrompt(backend.url, promptWorkflow, config.clientId, signal);
        submitting = false;
        reservation.release();
        reservation = undefined;
        job = updateJob(job, {
          state: "submitted",
          promptId,
          submittedAt: new Date().toISOString(),
          error: undefined,
        });

        if (params?.background === true) return backgroundResult(job);

        const history = await pollHistory(
          backend.url,
          promptId,
          signal,
          config.syncTimeoutMs,
          1000,
          (elapsedMs) => {
            onUpdate?.({
              content: [{ type: "text", text: `Waiting for ${backend.id}… ${Math.round(elapsedMs / 1000)}s elapsed` }],
              details: { jobId: job?.id, promptId, backend, elapsedMs },
            });
          },
        );
        const executionError = extractExecutionError(history, promptId);
        if (executionError) {
          job = updateJob(job, { state: "failed", error: executionError });
          return formatJobResult(config, job);
        }
        const promptHistory = history[promptId];
        if (!promptHistory) {
          job = updateJob(job, { state: "unknown", diagnostic: "History response omitted this prompt." });
          return formatJobResult(config, job);
        }
        job = await finalizeJob(config, job, promptHistory, signal);
        return formatJobResult(config, job);
      } catch (error) {
        reservation?.release();
        reservation = undefined;

        if (error instanceof PollTimeoutError && job) {
          try {
            job = await reconcileJob(config, job, signal);
          } catch {
            job = updateJob(job, {
              state: "submitted",
              diagnostic: `Synchronous wait timed out after ${config.syncTimeoutMs}ms; the ComfyUI job continues.`,
            });
          }
          return formatJobResult(config, job);
        }

        if (signal?.aborted) {
          let cancellationNote = "";
          if (job && !job.promptId) {
            job = updateJob(job, {
              state: submitting ? "submission_unknown" : "cancelled",
              error: submitting
                ? "Prompt submission was aborted before its outcome was known."
                : undefined,
              diagnostic: submitting
                ? "The request may have reached ComfyUI; it was not retried automatically."
                : "Cancelled before ComfyUI accepted the prompt.",
            });
            cancellationNote = ` Job record: ${job.id}.`;
          } else if (job?.promptId && config.interruptOnAbort) {
            try {
              const cancelled = await cancelJob(config, job);
              job = cancelled.job;
              cancellationNote = ` ${cancelled.outcome}`;
            } catch (cancelError) {
              cancellationNote = ` Targeted cancellation failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`;
            }
          } else if (job?.promptId) {
            cancellationNote = ` Job ${job.id} remains active and can be checked with paint_job_status.`;
          }
          throw new Error(`Paint tool call cancelled.${cancellationNote}`);
        }

        if (job) {
          const ambiguousSubmission =
            submitting &&
            (!(error instanceof ComfyHttpError) || error.status === 408 || error.status >= 500);
          job = updateJob(job, {
            state: ambiguousSubmission ? "submission_unknown" : "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw new Error(
          `Paint error${job ? ` (job ${job.id})` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
