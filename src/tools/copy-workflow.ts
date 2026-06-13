/**
 * paint_copy_workflow_to_project tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolRegistration } from "./tool-utils.js";

export function createCopyWorkflowTool(
  bundledWorkflowDir: string,
  projectWorkflowDir: string,
): ToolRegistration {
  return {
    name: "paint_copy_workflow_to_project",
    label: "Paint Copy Workflow To Project",
    description:
      "Copy a bundled workflow into ./comfyui_workflows/ so it can be edited for the current project. " +
      "Use this before customizing a bundled workflow instead of modifying package files.",
    promptSnippet: "Copy bundled workflows into ./comfyui_workflows/ for project customization",
    promptGuidelines: [
      "Use paint_copy_workflow_to_project before editing a bundled workflow so changes stay in the project and don't affect the package.",
    ],
    parameters: {
      workflow: { type: "optional", description: "Bundled workflow file to copy. If omitted, copies all bundled workflow JSON files." },
      overwrite: { type: "optional", description: "Overwrite an existing project workflow file. Defaults to false." },
    },
    async execute(params) {
      try {
        if (!fs.existsSync(bundledWorkflowDir)) {
          throw new Error(`Bundled workflow directory not found: ${bundledWorkflowDir}`);
        }

        const bundledFiles = fs
          .readdirSync(bundledWorkflowDir)
          .filter((file) => file.endsWith(".json"))
          .sort();
        const selectedFiles = params?.workflow
          ? [path.basename(
              ((params.workflow as string).endsWith(".json") ? params.workflow : `${params.workflow}.json`) as string,
            )]
          : bundledFiles;

        if (selectedFiles.length === 0) {
          throw new Error("No bundled workflows found to copy.");
        }

        fs.mkdirSync(projectWorkflowDir, { recursive: true });
        const copied: string[] = [];
        const skipped: string[] = [];

        for (const file of selectedFiles) {
          if (!bundledFiles.includes(file)) {
            throw new Error(`Bundled workflow not found: ${file}`);
          }
          const src = path.join(bundledWorkflowDir, file);
          const dest = path.join(projectWorkflowDir, file);
          if (fs.existsSync(dest) && !params?.overwrite) {
            skipped.push(dest);
            continue;
          }
          fs.copyFileSync(src, dest);
          copied.push(dest);
        }

        const lines = [
          `Project workflow directory: ${projectWorkflowDir}`,
          `Copied ${copied.length} workflow(s).`,
        ];
        if (copied.length > 0) lines.push(...copied.map((file) => `- copied: ${file}`));
        if (skipped.length > 0) {
          lines.push(
            `Skipped ${skipped.length} existing workflow(s); pass overwrite=true to replace them.`,
          );
          lines.push(...skipped.map((file) => `- skipped: ${file}`));
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { projectWorkflowDir, copied, skipped },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error copying workflow: ${(e as Error).message}` }],
          details: {},
        };
      }
    },
  };
}
