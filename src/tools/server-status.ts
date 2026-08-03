/** Backend-aware ComfyUI and extension status. */

import * as fs from "node:fs";
import { comfyFetch } from "../comfyui-client.js";
import { listJobs } from "../job-store.js";
import { listAvailableWorkflowFiles } from "../workflow.js";
import type { ComfyUIQueueStatus, PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createServerStatusTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_server_status",
    label: "Paint Server Status",
    description:
      "Check all configured ComfyUI backends, queues, durable jobs, and effective extension configuration.",
    promptSnippet: "Check ComfyUI backend health, queues, jobs, and extension configuration",
    promptGuidelines: [
      "Use paint_server_status before generation to inspect every configured backend and its native queue.",
    ],
    parameters: {},
    async execute(_params, signal) {
      const availableWorkflows = listAvailableWorkflowFiles(
        config.workflowDir,
        config.bundledWorkflowDir,
      );
      const jobs = listJobs(config.outputDir, 100);

      const statuses = await Promise.all(
        config.backends.map(async (backend) => {
          const [queueResult, statsResult] = await Promise.allSettled([
            comfyFetch(backend.url, "/queue", { signal }),
            comfyFetch(backend.url, "/system_stats", { signal }),
          ]);
          const queue = queueResult.status === "fulfilled"
            ? queueResult.value as ComfyUIQueueStatus
            : undefined;
          return {
            backend,
            reachable: queueResult.status === "fulfilled",
            queue,
            running: queue?.queue_running?.length ?? 0,
            pending: queue?.queue_pending?.length ?? 0,
            queueError: queueResult.status === "rejected"
              ? queueResult.reason instanceof Error
                ? queueResult.reason.message
                : String(queueResult.reason)
              : undefined,
            systemStats: statsResult.status === "fulfilled" ? statsResult.value : undefined,
            statsError: statsResult.status === "rejected"
              ? statsResult.reason instanceof Error
                ? statsResult.reason.message
                : String(statsResult.reason)
              : undefined,
            jobCount: jobs.filter((job) => job.backend.id === backend.id).length,
          };
        }),
      );
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
      }

      const bundledCount = availableWorkflows.filter((workflow) => workflow.bundled).length;
      const lines = [
        "**ComfyUI Paint Status**",
        `Backends: ${config.backends.length}`,
        ...statuses.flatMap((status) => [
          `- ${status.backend.id}: ${status.backend.url}`,
          `  Reachable: ${status.reachable ? "yes" : "no"}; running: ${status.running}; pending: ${status.pending}; recorded jobs: ${status.jobCount}`,
          ...(status.queueError ? [`  Queue error: ${status.queueError}`] : []),
          ...(status.statsError ? [`  System stats error: ${status.statsError}`] : []),
        ]),
        `Active workflow directory: ${config.workflowDir}`,
        `Active workflow directory exists: ${fs.existsSync(config.workflowDir) ? "yes" : "no"}`,
        `Effective workflows: ${availableWorkflows.length} (${bundledCount} bundled fallback)`,
        `Output directory: ${config.outputDir}`,
        `Output retention: ${config.outputRetentionHours === 0 ? "disabled" : `${config.outputRetentionHours}h`}`,
        `Synchronous timeout: ${config.syncTimeoutMs / 1000}s`,
        `Interrupt on abort: ${config.interruptOnAbort ? "enabled" : "disabled"}`,
        `Inline image previews: up to ${config.inlineImageLimit}`,
        `Inline image quality/dimensions: JPEG q${config.imageQuality}, ${config.imageMaxDimension}px`,
        `Inline image bytes: ${config.imageMaxBytes} each / ${config.imageTotalMaxBytes} total`,
        config.backends.length > 1
          ? "Automatic backend selection assumes compatible models, custom nodes, and workflows."
          : "Single-backend compatibility mode is active.",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          backends: statuses,
          serverAddress: config.serverAddress,
          workflowDir: config.workflowDir,
          projectWorkflowDir: config.projectWorkflowDir,
          bundledWorkflowDir: config.bundledWorkflowDir,
          workflows: availableWorkflows.map((workflow) => workflow.name),
          bundledWorkflows: availableWorkflows.filter((workflow) => workflow.bundled).map((workflow) => workflow.name),
          outputDir: config.outputDir,
          outputDirIsDefault: config.outputDirIsDefault,
          outputRetentionHours: config.outputRetentionHours,
          syncTimeoutMs: config.syncTimeoutMs,
          interruptOnAbort: config.interruptOnAbort,
          inlineImageLimit: config.inlineImageLimit,
          imageQuality: config.imageQuality,
          imageMaxDimension: config.imageMaxDimension,
          imageMaxBytes: config.imageMaxBytes,
          imageTotalMaxBytes: config.imageTotalMaxBytes,
        },
      };
    },
  };
}
