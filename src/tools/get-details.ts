/**
 * paint_get_details tool.
 */

import * as path from "node:path";
import { getBackend } from "../backends.js";
import { resolveWorkflowPath, loadWorkflowJson, parseWorkflowDetails } from "../workflow.js";
import {
  buildUsableLoras,
  formatLoraDetailsText,
  getInstalledLoras,
  loadLoraMetadata,
} from "../lora.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createGetDetailsTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_get_details",
    label: "Paint Get Details",
    description:
      "Inspect a specific generation workflow in detail. Returns: the workflow's notes/instructions " +
      "(model recommendations, prompt style guidance), customizable variables with their default values, " +
      "output media types, input file slots, and LoRA slots/metadata when present. " +
      "Call this before using 'paint' with a workflow you haven't inspected yet.",
    promptSnippet: "Inspect a workflow's variables, notes, output types, input file slots, and LoRA metadata",
    promptGuidelines: [
      "Use paint_get_details before calling paint with an unfamiliar workflow to learn its variables, prompt style, LoRA slots, and input requirements.",
    ],
    parameters: {
      workflow: { type: "optional", valueType: "string", description: "The name of the workflow file to inspect (e.g., 'SDXL_example.json'). If omitted, uses the first available workflow." },
      backend: { type: "optional", valueType: "string", description: "Backend used for installed-LoRA checks. Defaults to the first backend." },
    },
    async execute(params, signal) {
      try {
        const wfPath = resolveWorkflowPath(
          config.workflowDir,
          params?.workflow as string | undefined,
          config.bundledWorkflowDir,
        );
        const wf = loadWorkflowJson(wfPath);
        if (!wf) {
          return {
            content: [{ type: "text", text: `Failed to load workflow: ${wfPath}` }],
            details: {},
          };
        }
        const details = parseWorkflowDetails(wf);
        const workflowName = path.basename(wfPath);
        const backend = getBackend(config.backends, params?.backend as string | undefined);
        const loraMetadata = loadLoraMetadata(wfPath);
        let installedLoras: string[] | undefined;
        try {
          installedLoras = await getInstalledLoras(backend.url, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          installedLoras = undefined;
        }
        const usableLoras = buildUsableLoras(installedLoras, loraMetadata);

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

        const loraText = formatLoraDetailsText(
          details.loraSlots,
          usableLoras,
          installedLoras?.length,
        );
        if (loraText) lines.push(loraText);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            workflow: workflowName,
            backend,
            notes: details.notes,
            variables: details.variables,
            outputTypes: details.outputTypes,
            inputSlots: details.inputSlots,
            loras: {
              supported: details.loraSlots.length > 0,
              slots: details.loraSlots,
              metadata: loraMetadata,
              installedCount: installedLoras?.length,
              usable: usableLoras,
            },
          },
        };
      } catch (e) {
        if (signal?.aborted) throw e;
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
