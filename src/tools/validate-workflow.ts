/**
 * paint_validate_workflow tool.
 */

import * as path from "node:path";
import { getBackend, backendFitDiagnostic } from "../backends.js";
import { resolveWorkflowPath, loadWorkflowJson, parseWorkflowDetails, validateWorkflow } from "../workflow.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createValidateWorkflowTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_validate_workflow",
    label: "Paint Validate Workflow",
    description:
      "Validate a ComfyUI workflow JSON before generation. Checks parseability, [VAR] annotations, " +
      "[OUTPUT:type] annotations, [FILE:type:order] input slots, and [CAPABILITY] tags. " +
      "Pass a backend to also check whether that backend can accept the workflow's required capabilities. " +
      "Use this when a workflow fails or before using a custom workflow.",
    promptSnippet: "Validate a workflow JSON's structure, annotations, and backend capability fit",
    promptGuidelines: [
      "Use paint_validate_workflow when a paint generation fails or before using a custom workflow to check for annotation errors.",
      "Pass backend to paint_validate_workflow to confirm a specific backend accepts the workflow's [CAPABILITY] requirements.",
    ],
    parameters: {
      workflow: { type: "optional", valueType: "string", description: "The workflow file to validate. If omitted, validates the first available workflow." },
      backend: { type: "optional", valueType: "string", description: "Backend ID to check capability fit against. Defaults to the first backend." },
    },
    async execute(params) {
      try {
        const wfPath = resolveWorkflowPath(
          config.workflowDir,
          params?.workflow as string | undefined,
          config.bundledWorkflowDir,
        );
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
          `Required capabilities: ${
            details.capabilities.length > 0 ? details.capabilities.join(", ") : "none (any backend)"
          }`,
        ];

        const backend = getBackend(config.backends, params?.backend as string | undefined);
        const fit = backendFitDiagnostic(backend, details.capabilities);
        if (fit) {
          lines.push(`⚠️ **Backend fit:** ${fit}`);
        } else if (details.capabilities.length > 0) {
          lines.push(`✅ **Backend fit:** ${backend.id} accepts this workflow's capabilities.`);
        }

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
            capabilities: details.capabilities,
            backend,
            backendFit: fit ? { accepted: false, reason: fit } : { accepted: true },
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
