/**
 * paint_interrupt tool.
 */

import { interruptComfy } from "../comfyui-client.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createInterruptTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_interrupt",
    label: "Paint Interrupt",
    description:
      "Interrupt the currently running ComfyUI generation. " +
      "Use this when the user wants to cancel an in-progress image generation. " +
      "After interrupting, the queue is cleared and you can submit a new prompt.",
    promptSnippet: "Cancel the currently running ComfyUI generation and clear the queue",
    promptGuidelines: [
      "Use paint_interrupt when the user wants to cancel an in-progress generation. After interrupting, a new paint call can be submitted.",
    ],
    parameters: {},
    async execute() {
      try {
        await interruptComfy(config.serverAddress);
        return {
          content: [
            {
              type: "text",
              text: "Interrupted. Current generation cancelled and queue cleared.",
            },
          ],
          details: { interrupted: true },
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
