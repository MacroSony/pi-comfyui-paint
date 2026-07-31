/**
 * paint_list_workflows tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isWorkflowJsonFile, loadWorkflowJson, parseWorkflowDetails } from "../workflow.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createListWorkflowsTool(
  workflowDir: string,
  bundledWorkflowDir?: string,
): ToolRegistration {
  return {
    name: "paint_list_workflows",
    label: "Paint List Workflows",
    description:
      "Lists all available image generation workflows (JSON files) in the ComfyUI workflow folder, " +
      "plus bundled workflows usable by name (marked bundled). " +
      "Use this to browse what's available, then call paint_get_details for any workflow you want to use.",
    promptSnippet: "List available ComfyUI workflow JSON files",
    promptGuidelines: [
      "Use paint_list_workflows to discover what workflows are available before calling paint or paint_get_details.",
    ],
    parameters: {},
    async execute() {
      const summaryLine = (file: string, dir: string, markBundled: boolean): string => {
        const wf = loadWorkflowJson(path.join(dir, file));
        if (!wf) return `- ${file}${markBundled ? " (bundled)" : ""} (unreadable JSON)`;
        const details = parseWorkflowDetails(wf);
        const varCount = Object.keys(details.variables).length;
        const fileSlotCount = Object.keys(details.inputSlots).length;
        const loraSlotCount = details.loraSlots.length;
        const outCount = Object.keys(details.outputTypes).length;
        const bits = [
          `${varCount} variable${varCount === 1 ? "" : "s"}`,
          `${fileSlotCount} file slot${fileSlotCount === 1 ? "" : "s"}`,
          `${loraSlotCount} lora slot${loraSlotCount === 1 ? "" : "s"}`,
          `${outCount} output${outCount === 1 ? "" : "s"}`,
        ];
        return `- ${file}${markBundled ? " (bundled)" : ""} (${bits.join(", ")})`;
      };

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

      // Bundled workflows are usable by name via per-file fallback, so surface the
      // ones not shadowed by a same-named project file (marked "(bundled)").
      const bundledFiles =
        bundledWorkflowDir && !sameDir(bundledWorkflowDir, workflowDir) && fs.existsSync(bundledWorkflowDir)
          ? fs.readdirSync(bundledWorkflowDir).filter(isWorkflowJsonFile).sort()
          : [];
      const extraBundled = bundledFiles.filter((f) => !files.includes(f));

      if (files.length === 0 && extraBundled.length === 0) {
        return {
          content: [{ type: "text", text: "No workflows found in the .pi/comfyui_workflows folder." }],
          details: {},
        };
      }

      // One compact summary line per workflow (kept cheap: ~40 tokens per row),
      // enough to pick the right workflow without expanding full details.
      const lines = [
        ...files.map((file) => summaryLine(file, workflowDir, false)),
        ...extraBundled.map((file) => summaryLine(file, bundledWorkflowDir!, true)),
      ];
      return {
        content: [{ type: "text", text: `Available workflows:\n${lines.join("\n")}` }],
        details: { workflows: files, bundledWorkflows: extraBundled },
      };
    },
  };
}

/** True when two directory paths point at the same location (normalized compare). */
function sameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
