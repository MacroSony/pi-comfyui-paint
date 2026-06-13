/**
 * paint_queue_status tool.
 */

import { comfyFetch } from "../comfyui-client.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createQueueStatusTool(config: PaintConfig): ToolRegistration {
  return {
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
    parameters: {},
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
            content: [
              { type: "text", text: "Queue is empty — no generations running or pending." },
            ],
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
            { type: "text", text: `Failed to query queue: ${(e as Error).message}` },
          ],
          details: {},
        };
      }
    },
  };
}
