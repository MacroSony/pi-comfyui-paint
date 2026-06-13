/**
 * paint_server_status tool.
 */

import * as fs from "node:fs";
import { comfyFetch } from "../comfyui-client.js";
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
    async execute() {
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
      const queue =
        queueEntry.status === "fulfilled"
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
  };
}
