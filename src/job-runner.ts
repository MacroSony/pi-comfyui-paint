/** Submit, reconcile, finalize, format, and cancel durable paint jobs. */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  cancelPromptAtomically,
  collectOutputItems,
  comfyFetch,
  deleteQueuedPrompt,
  downloadOutputsToDirectory,
  extractExecutionError,
  getQueueStatus,
} from "./comfyui-client.js";
import { findPromptInQueue } from "./backends.js";
import { compressImageForLLM } from "./image-compression.js";
import { isTerminalJobState, updateJob } from "./job-store.js";
import type {
  ComfyUIHistoryOutput,
  ComfyUIOutputItem,
  InlineImagePreview,
  PaintConfig,
  PaintJobRecord,
} from "./types.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

const finalizationLocks = new Map<string, Promise<PaintJobRecord>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function manifestHasItems(
  manifest: Record<string, Record<string, ComfyUIOutputItem[]>> | undefined,
): manifest is Record<string, Record<string, ComfyUIOutputItem[]>> {
  return Boolean(
    manifest && Object.values(manifest).some((nodeOutput) => collectOutputItems(nodeOutput).length > 0),
  );
}

function scopedBackendOutputRoot(config: PaintConfig, job: PaintJobRecord): string | undefined {
  const configured = config.backendOutputDirs?.[job.backend.id];
  if (!configured || !job.outputPrefix) return undefined;
  const root = path.resolve(configured);
  const scoped = path.resolve(root, ...job.outputPrefix.split("/"));
  return scoped === root || scoped.startsWith(`${root}${path.sep}`) ? scoped : undefined;
}

/** Build a synthetic manifest from job-scoped files in a configured local/mounted ComfyUI output dir. */
function recoverManifestFromBackendOutput(
  config: PaintConfig,
  job: PaintJobRecord,
): Record<string, Record<string, ComfyUIOutputItem[]>> | undefined {
  const scopedRoot = scopedBackendOutputRoot(config, job);
  if (!scopedRoot || !fs.existsSync(scopedRoot)) return undefined;
  const backendRoot = path.resolve(config.backendOutputDirs![job.backend.id]);
  const items: ComfyUIOutputItem[] = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && !entry.name.endsWith(".part") && !entry.name.startsWith(".")) {
        const relative = path.relative(backendRoot, candidate).split(path.sep).join("/");
        const subfolder = path.dirname(relative) === "." ? "" : path.dirname(relative).split(path.sep).join("/");
        items.push({ filename: entry.name, subfolder, type: "output" });
      }
    }
  };
  visit(scopedRoot);
  if (items.length === 0) return undefined;
  items.sort((a, b) => `${a.subfolder}/${a.filename}`.localeCompare(`${b.subfolder}/${b.filename}`));
  return { recovered: { files: items } };
}

function selectNodeOutputs(
  job: PaintJobRecord,
  outputs: Record<string, Record<string, ComfyUIOutputItem[]>>,
): { nodeOutputs: Array<Record<string, ComfyUIOutputItem[]>>; usedTagged: boolean } {
  if (job.outputNodeIds.length > 0) {
    const tagged = job.outputNodeIds
      .map((id) => outputs[id])
      .filter((output): output is Record<string, ComfyUIOutputItem[]> => Boolean(output));
    if (tagged.length > 0) return { nodeOutputs: tagged, usedTagged: true };
  }
  return { nodeOutputs: Object.values(outputs), usedTagged: false };
}

async function finalizeUnlocked(
  config: PaintConfig,
  initialJob: PaintJobRecord,
  promptHistory: ComfyUIHistoryOutput[string],
  signal?: AbortSignal,
): Promise<PaintJobRecord> {
  let job = initialJob;
  if (job.state === "completed" && job.files.every((file) => fs.existsSync(file.path))) {
    return job;
  }

  const outputManifest = promptHistory.outputs ?? {};
  job = updateJob(job, {
    state: "finalizing",
    outputManifest,
    error: undefined,
    diagnostic: undefined,
  });
  try {
    const selected = selectNodeOutputs(job, outputManifest);
    let files = await downloadOutputsToDirectory(
      job.backend.url,
      selected.nodeOutputs,
      job.outputDir,
      signal,
    );
    if (files.length === 0 && selected.usedTagged) {
      files = await downloadOutputsToDirectory(
        job.backend.url,
        Object.values(outputManifest),
        job.outputDir,
        signal,
      );
    }
    const completedAt = new Date().toISOString();
    const generationElapsedMs = job.submittedAt
      ? Math.max(Date.parse(completedAt) - Date.parse(job.submittedAt), 0)
      : undefined;
    job = updateJob(job, {
      state: "completed",
      files,
      completedAt,
      generationElapsedMs,
      error: undefined,
      diagnostic: files.length === 0 ? "ComfyUI completed without downloadable outputs." : undefined,
    });
    return job;
  } catch (error) {
    job = updateJob(job, {
      state: "finalization_failed",
      error: `Output finalization failed: ${errorMessage(error)}`,
    });
    return job;
  }
}

export async function finalizeJob(
  config: PaintConfig,
  job: PaintJobRecord,
  promptHistory: ComfyUIHistoryOutput[string],
  signal?: AbortSignal,
): Promise<PaintJobRecord> {
  const existing = finalizationLocks.get(job.id);
  if (existing) return existing;
  const promise = finalizeUnlocked(config, job, promptHistory, signal).finally(() => {
    finalizationLocks.delete(job.id);
  });
  finalizationLocks.set(job.id, promise);
  return promise;
}

/** Reconcile one persisted job against its permanently assigned backend. */
export async function reconcileJob(
  config: PaintConfig,
  initialJob: PaintJobRecord,
  signal?: AbortSignal,
): Promise<PaintJobRecord> {
  let job = initialJob;
  if (job.state === "completed") {
    if (job.files.every((file) => fs.existsSync(file.path))) return job;
    job = updateJob(job, {
      state: "finalization_failed",
      diagnostic: "One or more downloaded output files are missing; retrieval will be retried.",
    });
  }
  if (isTerminalJobState(job.state)) return job;
  if (!job.promptId) return job;
  const promptId = job.promptId;

  const history = (await comfyFetch(
    job.backend.url,
    `/history/${encodeURIComponent(promptId)}`,
    { signal },
  )) as ComfyUIHistoryOutput;
  const promptHistory = history[promptId];
  if (promptHistory) {
    const executionError = extractExecutionError(history, promptId);
    if (executionError) {
      return updateJob(job, { state: "failed", error: executionError });
    }
    return finalizeJob(config, job, promptHistory, signal);
  }

  if (manifestHasItems(job.outputManifest)) {
    return finalizeJob(config, job, { outputs: job.outputManifest }, signal);
  }

  const queue = await getQueueStatus(job.backend.url, signal);
  const queueState = findPromptInQueue(queue, promptId);
  if (queueState) {
    return updateJob(job, { state: queueState, diagnostic: undefined });
  }

  const recoveredManifest = recoverManifestFromBackendOutput(config, job);
  if (recoveredManifest) {
    job = updateJob(job, {
      outputManifest: recoveredManifest,
      diagnostic: "Recovered output metadata from the configured backend output directory after ComfyUI history was lost.",
    });
    return finalizeJob(config, job, { outputs: recoveredManifest }, signal);
  }

  return updateJob(job, {
    state: "unknown",
    diagnostic: "Prompt is absent from both ComfyUI history and its current queue.",
  });
}

export async function cancelJob(
  config: PaintConfig,
  initialJob: PaintJobRecord,
  signal?: AbortSignal,
): Promise<{ job: PaintJobRecord; outcome: string }> {
  let job = initialJob;
  if (isTerminalJobState(job.state)) {
    return { job, outcome: `Job is already ${job.state}.` };
  }
  if (!job.promptId) {
    if (job.state === "submitting" || job.state === "submission_unknown") {
      job = updateJob(job, {
        state: "submission_unknown",
        diagnostic:
          "The prompt submission outcome is unknown and no prompt ID is available, so no cancellation request was sent.",
      });
      return {
        job,
        outcome:
          "This submission may have reached ComfyUI, but its prompt ID was not received; it cannot be targeted safely.",
      };
    }
    job = updateJob(job, { state: "cancelled", diagnostic: "Cancelled before prompt acceptance." });
    return { job, outcome: "Cancelled before ComfyUI accepted the prompt." };
  }
  const promptId = job.promptId;

  job = updateJob(job, { state: "cancelling" });
  try {
    const history = (await comfyFetch(
      job.backend.url,
      `/history/${encodeURIComponent(promptId)}`,
      { signal },
    )) as ComfyUIHistoryOutput;
    if (history[promptId]) {
      const reconciled = await reconcileJob(config, job, signal);
      return { job: reconciled, outcome: `Job already reached ${reconciled.state}.` };
    }

    const atomicallyCancelled = await cancelPromptAtomically(job.backend.url, promptId, signal);
    if (atomicallyCancelled === true) {
      job = updateJob(job, {
        state: "cancelled",
        diagnostic: "Cancelled through ComfyUI's targeted jobs API.",
      });
      return { job, outcome: "Cancelled the exact job on its backend." };
    }
    if (atomicallyCancelled === false) {
      const reconciled = await reconcileJob(config, job, signal);
      return {
        job: reconciled,
        outcome: isTerminalJobState(reconciled.state)
          ? `Job already reached ${reconciled.state}.`
          : `The backend could not cancel the exact job; its current state is ${reconciled.state}.`,
      };
    }

    // Older ComfyUI versions have no atomic per-job cancellation. Removing an
    // exact pending prompt is safe, but /interrupt is backend-wide and can race
    // with the next prompt, so running work is deliberately left untouched.
    const queue = await getQueueStatus(job.backend.url, signal);
    const queueState = findPromptInQueue(queue, promptId);
    if (queueState === "queued") {
      await deleteQueuedPrompt(job.backend.url, promptId, signal);
      job = updateJob(job, {
        state: "cancelled",
        diagnostic: "Removed from ComfyUI's pending queue.",
      });
      return { job, outcome: "Removed the job from the backend queue." };
    }
    if (queueState === "running") {
      job = updateJob(job, {
        state: "running",
        diagnostic:
          "This backend does not support targeted cancellation for running jobs; no backend-wide interrupt was sent.",
      });
      return {
        job,
        outcome:
          "The backend is too old for safe targeted cancellation. The running job was left untouched; use paint_interrupt only if a backend-wide interrupt is intended.",
      };
    }

    job = updateJob(job, {
      state: "unknown",
      diagnostic:
        "Could not find the prompt in ComfyUI history or queue; no unrelated work was interrupted.",
    });
    return { job, outcome: "Prompt was not found; no backend-wide interrupt was sent." };
  } catch (error) {
    try {
      updateJob(job, {
        state: initialJob.state,
        diagnostic: `Cancellation attempt failed: ${errorMessage(error)}`,
      });
    } catch {
      // Preserve the backend error if restoring the durable state also fails.
    }
    throw error;
  }
}

async function prepareInlinePreviews(
  config: PaintConfig,
  job: PaintJobRecord,
): Promise<{
  previews: InlineImagePreview[];
  failures: Array<{ path: string; error: string }>;
}> {
  const previews: InlineImagePreview[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  let totalBytes = 0;
  const candidates = job.files
    .filter((file) => file.mimeType.startsWith("image/"))
    .slice(0, config.inlineImageLimit);

  for (const candidate of candidates) {
    const remaining = config.imageTotalMaxBytes - totalBytes;
    if (remaining < 1024) break;
    try {
      const preview = await compressImageForLLM(
        candidate.path,
        config.imageQuality,
        config.imageMaxDimension,
        Math.min(config.imageMaxBytes, remaining),
      );
      totalBytes += preview.encodedBytes;
      previews.push({ path: candidate.path, ...preview });
    } catch (error) {
      failures.push({ path: candidate.path, error: errorMessage(error) });
    }
  }
  return { previews, failures };
}

export async function formatJobResult(
  config: PaintConfig,
  job: PaintJobRecord,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const { previews, failures } = await prepareInlinePreviews(config, job);
  const imageCount = job.files.filter((file) => file.mimeType.startsWith("image/")).length;
  const lines: string[] = [];

  if (job.state === "completed") {
    lines.push(
      job.files.length > 0
        ? `Generated ${job.files.length} file(s):`
        : "Generation completed without downloadable output files.",
    );
    if (job.files.length > 0) lines.push(...job.files.map((file) => file.path));
  } else if (job.state === "failed") {
    lines.push(`ComfyUI generation failed: ${job.error ?? "Unknown error"}`);
  } else if (job.state === "cancelled") {
    lines.push("Generation was cancelled.");
  } else if (job.state === "finalization_failed") {
    lines.push(
      `ComfyUI finished, but output retrieval failed: ${job.error ?? "Unknown error"}`,
      "Call paint_job_status again to retry output retrieval.",
    );
  } else {
    lines.push(`Paint job ${job.id} is ${job.state}.`);
  }

  lines.push(`Job: ${job.id}`, `Backend: ${job.backend.id} (${job.backend.url})`);
  if (job.promptId) lines.push(`ComfyUI prompt: ${job.promptId}`);
  lines.push(`Workflow: ${job.workflow}`);
  if (job.generationElapsedMs != null) {
    lines.push(`Generation time: ${(job.generationElapsedMs / 1000).toFixed(1)}s`);
  }
  for (const warning of job.warnings) lines.push(`⚠️ ${warning}`);
  if (imageCount > 0) {
    lines.push(`Inline previews: ${previews.length} of ${imageCount} image(s).`);
  }
  if (failures.length > 0) {
    lines.push(`⚠️ ${failures.length} image preview(s) could not be prepared.`);
  }
  if (job.diagnostic) lines.push(`Note: ${job.diagnostic}`);

  return {
    content: [
      { type: "text", text: lines.join("\n") },
      ...previews.map((preview) => ({
        type: "image" as const,
        data: preview.data,
        mimeType: preview.mimeType,
      })),
    ],
    details: {
      jobId: job.id,
      state: job.state,
      backend: job.backend,
      promptId: job.promptId,
      workflow: job.workflow,
      workflowPath: job.workflowPath,
      workflowHash: job.workflowHash,
      outputDir: job.outputDir,
      files: job.files,
      generationElapsedMs: job.generationElapsedMs,
      inlinePreviews: previews.map(({ data: _data, ...preview }) => preview),
      ...(failures.length > 0 ? { previewFailures: failures } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}),
      ...(job.warnings.length > 0 ? { warnings: job.warnings } : {}),
      uploadedInputs: job.uploadedInputs,
      appliedLoras: job.appliedLoras,
    },
  };
}
