/**
 * paint_interrupt tool.
 */

import { interruptComfy } from "../comfyui-client.js";
import { getBackend } from "../backends.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createInterruptTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_interrupt",
    label: "Paint Interrupt",
    description:
      "Interrupt the currently running ComfyUI generation. " +
      "Use this when the user wants to cancel an in-progress image generation. " +
      "Note: this cancels only the currently running task — pending queue items stay queued (check paint_server_status for queue state).",
    promptSnippet: "Cancel the currently running ComfyUI generation",
    promptGuidelines: [
      "Use paint_interrupt when the user wants to cancel an in-progress generation. It cancels only the running task; pending queue items remain queued. After interrupting, a new paint call can be submitted.",
    ],
    parameters: {
      backend: { type: "optional", valueType: "string", description: "Backend ID. Required when multiple backends are configured." },
    },
    async execute(params, signal) {
      try {
        const requested = params?.backend as string | undefined;
        if (config.backends.length > 1 && !requested) {
          throw new Error(
            `backend is required when multiple backends are configured: ${config.backends.map((backend) => backend.id).join(", ")}`,
          );
        }
        const backend = getBackend(config.backends, requested);
        await interruptComfy(backend.url, signal);
        return {
          content: [
            {
              type: "text",
              text: `Interrupted the current generation on ${backend.id}. Pending queue items were not cleared.`,
            },
          ],
          details: { interrupted: true, backend },
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Failed to interrupt: ${(e as Error).message}` },
          ],
          details: {},
        };
      }
    },
  };
}
