/**
 * paint_server_status tool.
 */

import * as fs from "node:fs";
import { comfyFetch } from "../comfyui-client.js";
import { listAvailableWorkflowFiles } from "../workflow.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createServerStatusTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_server_status",
    label: "Paint Server Status",
    description:
      "Check ComfyUI connectivity and show the effective pi-comfyui-paint configuration. " +
      "Use this to debug COMFYUI_URL, workflow discovery, queue state, and cancellation behavior before generating.",
    promptSnippet: "Check ComfyUI server connectivity and extension configuration",
    promptGuidelines: [
      "Use paint_server_status to debug connectivity issues before generating images — it reports whether ComfyUI is reachable, which workflow directory is active, and the current queue state.",
    ],
    parameters: {},
    async execute(_params, signal) {
      const workflowDirExists = fs.existsSync(config.workflowDir);
      const availableWorkflows = listAvailableWorkflowFiles(
        config.workflowDir,
        config.bundledWorkflowDir,
      );
      const workflows = availableWorkflows.map((entry) => entry.name);
      const bundledWorkflows = availableWorkflows
        .filter((entry) => entry.bundled)
        .map((entry) => entry.name);

      const queueResult = await Promise.allSettled([
        comfyFetch(config.serverAddress, "/queue", { signal }),
        comfyFetch(config.serverAddress, "/system_stats", { signal }),
      ]);
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
      }

      const queueEntry = queueResult[0];
      const statsEntry = queueResult[1];
      const queueOk = queueEntry.status === "fulfilled";
      const queue =
        queueEntry.status === "fulfilled"
          ? (queueEntry.value as { queue_running?: unknown[]; queue_pending?: unknown[] })
          : undefined;

      const lines = [
        "**ComfyUI Paint Status**",
        `Server: ${config.serverAddress}`,
        `Reachable: ${queueOk ? "yes" : "no"}`,
        `Active workflow directory: ${config.workflowDir}`,
        `Project workflow directory: ${config.projectWorkflowDir}`,
        `Bundled workflow directory: ${config.bundledWorkflowDir}`,
        `Active workflow directory exists: ${workflowDirExists ? "yes" : "no"}`,
        `Effective workflow count: ${workflows.length} (${bundledWorkflows.length} bundled fallback)`,
        `Output directory: ${config.outputDir}`,
        `Output retention: ${config.outputRetentionHours === 0 ? "disabled" : `${config.outputRetentionHours}h`}`,
        `Interrupt on abort: ${config.interruptOnAbort ? "enabled" : "disabled"}`,
        `Inline image previews: up to ${config.inlineImageLimit}`,
        `Inline image quality: JPEG q${config.imageQuality}`,
        `Inline image max dimension: ${config.imageMaxDimension}px`,
        `Inline image max bytes: ${config.imageMaxBytes} each / ${config.imageTotalMaxBytes} total`,
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
          bundledWorkflows,
          outputDir: config.outputDir,
          outputDirIsDefault: config.outputDirIsDefault,
          outputRetentionHours: config.outputRetentionHours,
          interruptOnAbort: config.interruptOnAbort,
          inlineImageLimit: config.inlineImageLimit,
          imageQuality: config.imageQuality,
          imageMaxDimension: config.imageMaxDimension,
          imageMaxBytes: config.imageMaxBytes,
          imageTotalMaxBytes: config.imageTotalMaxBytes,
          queue,
          systemStats: statsEntry.status === "fulfilled" ? statsEntry.value : undefined,
        },
      };
    },
  };
}
