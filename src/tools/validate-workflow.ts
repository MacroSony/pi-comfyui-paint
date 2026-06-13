/**
 * paint_validate_workflow tool.
 */

import * as path from "node:path";
import { resolveWorkflowPath, loadWorkflowJson, parseWorkflowDetails, validateWorkflow } from "../workflow.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createValidateWorkflowTool(workflowDir: string): ToolRegistration {
  return {
    name: "paint_validate_workflow",
    label: "Paint Validate Workflow",
    description:
      "Validate a ComfyUI workflow JSON before generation. Checks parseability, [VAR] annotations, " +
      "[OUTPUT:type] annotations, and [FILE:type:order] input slots. Use this when a workflow fails or before using a custom workflow.",
    promptSnippet: "Validate a workflow JSON's structure and pi-comfyui-paint annotations",
    promptGuidelines: [
      "Use paint_validate_workflow when a paint generation fails or before using a custom workflow to check for annotation errors.",
    ],
    parameters: {
      workflow: { type: "optional", description: "The workflow file to validate. If omitted, validates the first available workflow." },
    },
    async execute(params) {
      try {
        const wfPath = resolveWorkflowPath(workflowDir, params?.workflow as string | undefined);
        const wf = loadWorkflowJson(wfPath);
        if (!wf) {
          return {
            content: [{ type: "text", text: `Workflow is invalid JSON or unreadable: ${wfPath}` }],
            details: { valid: false, workflow: path.basename(wfPath), errors: ["Invalid or unreadable JSON"], warnings: [] },
          };
        }

        const details = parseWorkflowDetails(wf);
        const validation = validateWorkflow(wf);
        const valid = validation.errors.length === 0;
        const lines = [
          `**Workflow validation for '${path.basename(wfPath)}': ${valid ? "passed" : "failed"}**`,
          `Nodes: ${Object.keys(wf).length}`,
          `Variables: ${Object.keys(details.variables).length}`,
          `Tagged outputs: ${Object.keys(details.outputTypes).length}`,
          `Input file slots: ${Object.keys(details.inputSlots).length}`,
        ];

        if (validation.errors.length > 0) {
          lines.push("\n❌ **Errors:**");
          lines.push(...validation.errors.map((err) => `- ${err}`));
        }
        if (validation.warnings.length > 0) {
          lines.push("\n⚠️ **Warnings:**");
          lines.push(...validation.warnings.map((warning) => `- ${warning}`));
        }
        if (valid && validation.warnings.length === 0) {
          lines.push("\nNo issues found.");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            valid,
            workflow: path.basename(wfPath),
            errors: validation.errors,
            warnings: validation.warnings,
            variables: details.variables,
            outputTypes: details.outputTypes,
            inputSlots: details.inputSlots,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error validating workflow: ${(e as Error).message}` }],
          details: { valid: false },
        };
      }
    },
  };
}
