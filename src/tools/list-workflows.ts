/**
 * paint_list_workflows tool.
 */

import { isWorkflowJsonFile } from "../workflow.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createListWorkflowsTool(workflowDir: string): ToolRegistration {
  return {
    name: "paint_list_workflows",
    label: "Paint List Workflows",
    description:
      "Lists all available image generation workflows (JSON files) in the ComfyUI workflow folder. " +
      "Use this to browse what's available, then call paint_get_details for any workflow you want to use.",
    promptSnippet: "List available ComfyUI workflow JSON files",
    promptGuidelines: [
      "Use paint_list_workflows to discover what workflows are available before calling paint or paint_get_details.",
    ],
    parameters: {},
    async execute() {
      const fs = await import("node:fs");
      if (!fs.existsSync(workflowDir)) {
        return {
          content: [{ type: "text", text: `Workflow directory not found: ${workflowDir}` }],
          details: {},
        };
      }
      const files = fs
        .readdirSync(workflowDir)
        .filter(isWorkflowJsonFile)
        .sort();
      if (files.length === 0) {
        return {
          content: [{ type: "text", text: "No workflows found in the .pi/comfyui_workflows folder." }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: `Available workflows: ${files.join(", ")}` }],
        details: { workflows: files },
      };
    },
  };
}
