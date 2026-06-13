/**
 * paint_get_details tool.
 */

import * as path from "node:path";
import { resolveWorkflowPath, loadWorkflowJson, parseWorkflowDetails } from "../workflow.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createGetDetailsTool(workflowDir: string): ToolRegistration {
  return {
    name: "paint_get_details",
    label: "Paint Get Details",
    description:
      "Inspect a specific generation workflow in detail. Returns: the workflow's notes/instructions " +
      "(model recommendations, prompt style guidance), customizable variables with their default values, " +
      "output media types, and input file slots. " +
      "Call this before using 'paint' with a workflow you haven't inspected yet.",
    promptSnippet: "Inspect a workflow's variables, notes, output types, and input file slots",
    promptGuidelines: [
      "Use paint_get_details before calling paint with an unfamiliar workflow to learn its variables, prompt style, and input requirements.",
    ],
    parameters: {
      workflow: { type: "optional", description: "The name of the workflow file to inspect (e.g., 'SDXL_example.json'). If omitted, uses the first available workflow." },
    },
    async execute(params) {
      try {
        const wfPath = resolveWorkflowPath(workflowDir, params?.workflow as string | undefined);
        const wf = loadWorkflowJson(wfPath);
        if (!wf) {
          return {
            content: [{ type: "text", text: `Failed to load workflow: ${wfPath}` }],
            details: {},
          };
        }
        const details = parseWorkflowDetails(wf);
        const workflowName = path.basename(wfPath);

        const lines: string[] = [`**Workflow details for '${workflowName}':**`];

        if (details.notes) {
          lines.push(`\n📝 **Notes:**\n${details.notes}`);
        }

        const varKeys = Object.keys(details.variables);
        if (varKeys.length > 0) {
          lines.push(
            `\n🎛️ **Variables:**\n\`\`\`json\n${JSON.stringify(details.variables, null, 2)}\n\`\`\``,
          );
        } else {
          lines.push("\n🎛️ **Variables:** (none — this workflow has no [VAR] nodes)");
        }

        const outKeys = Object.keys(details.outputTypes);
        if (outKeys.length > 0) {
          lines.push(
            `\n📤 **Output types:**\n\`\`\`json\n${JSON.stringify(details.outputTypes, null, 2)}\n\`\`\``,
          );
        }

        const slotKeys = Object.keys(details.inputSlots);
        if (slotKeys.length > 0) {
          lines.push(
            `\n📥 **Input file slots:**\n\`\`\`json\n${JSON.stringify(details.inputSlots, null, 2)}\n\`\`\``,
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            workflow: workflowName,
            notes: details.notes,
            variables: details.variables,
            outputTypes: details.outputTypes,
            inputSlots: details.inputSlots,
          },
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Error getting workflow details: ${(e as Error).message}` },
          ],
          details: {},
        };
      }
    },
  };
}
