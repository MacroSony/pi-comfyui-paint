/**
 * paint_copy_workflow_to_project tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isWorkflowJsonFile } from "../workflow.js";
import type { ToolRegistration } from "./tool-utils.js";

function sidecarName(file: string): string {
  return `${file.slice(0, -path.extname(file).length)}.loras.json`;
}

export function createCopyWorkflowTool(
  bundledWorkflowDir: string,
  projectWorkflowDir: string,
): ToolRegistration {
  return {
    name: "paint_copy_workflow_to_project",
    label: "Paint Copy Workflow To Project",
    description:
      "Copy a bundled workflow into .pi/comfyui_workflows/ so it can be edited for the current project. " +
      "Use this before customizing a bundled workflow instead of modifying package files.",
    promptSnippet: "Copy bundled workflows into .pi/comfyui_workflows/ for project customization",
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
          .filter(isWorkflowJsonFile)
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

          const sidecar = sidecarName(file);
          const sidecarSrc = path.join(bundledWorkflowDir, sidecar);
          const sidecarDest = path.join(projectWorkflowDir, sidecar);
          if (fs.existsSync(sidecarSrc)) {
            if (fs.existsSync(sidecarDest) && !params?.overwrite) {
              skipped.push(sidecarDest);
            } else {
              fs.copyFileSync(sidecarSrc, sidecarDest);
              copied.push(sidecarDest);
            }
          }
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
