/**
 * pi-comfyui-paint
 *
 * Connects to a ComfyUI server for image/video generation.
 *
 * Configuration (env vars or defaults):
 *   COMFYUI_URL                 - ComfyUI server address (default: 127.0.0.1:8188)
 *   COMFYUI_WORKFLOW_DIR        - Workflow JSON folder
 *   COMFYUI_INTERRUPT_ON_ABORT  - Interrupt ComfyUI when a pi paint tool call is cancelled
 *   COMFYUI_IMAGE_QUALITY       - JPEG quality for images sent to the LLM provider (1-100, default: 85).
 *   COMFYUI_IMAGE_MAX_DIMENSION - Resize images so the longest side ≤ pixels (default: 2048).
 *
 * Registers 10 tools:
 *   paint_list_workflows  paint_get_details       paint_validate_workflow
 *   paint_copy_workflow_to_project  paint_server_status  paint_get_models
 *   paint_queue_status    paint_interrupt         paint
 *   paint_search_danbooru_tags
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "./config.js";
import { createListWorkflowsTool } from "./tools/list-workflows.js";
import { createGetDetailsTool } from "./tools/get-details.js";
import { createValidateWorkflowTool } from "./tools/validate-workflow.js";
import { createCopyWorkflowTool } from "./tools/copy-workflow.js";
import { createServerStatusTool } from "./tools/server-status.js";
import { createGetModelsTool } from "./tools/get-models.js";
import { createQueueStatusTool } from "./tools/queue-status.js";
import { createInterruptTool } from "./tools/interrupt.js";
import { createPaintTool } from "./tools/paint.js";
import { createSearchDanbooruTagsTool } from "./tools/search-danbooru-tags.js";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const config = getConfig(cwd);

  // Build all tool definitions, then bridge each into pi's ToolDefinition API.
  const tools = [
    createListWorkflowsTool(config.workflowDir),
    createGetDetailsTool(config),
    createValidateWorkflowTool(config.workflowDir),
    createCopyWorkflowTool(config.bundledWorkflowDir, config.projectWorkflowDir),
    createServerStatusTool(config),
    createGetModelsTool(config),
    createQueueStatusTool(config),
    createInterruptTool(config),
    createPaintTool(config, cwd),
    createSearchDanbooruTagsTool(config),
  ];

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: buildSchema(tool.parameters),
      execute(_toolCallId: any, params: any, signal: any, onUpdate: any, _ctx: any) {
        return tool.execute(params as any, signal) as any;
      },
    } as any);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `ComfyUI Paint: ${config.serverAddress} (${config.workflowDir})`,
        "info",
      );
    }
  });
}

/** Convert simplified param defs to a TypeBox schema. */
function buildSchema(params: Record<string, { type: string; description: string }>) {
  const schema: Record<string, any> = {};
  for (const [name, def] of Object.entries(params)) {
    if (def.type === "optional") {
      schema[name] = Type.Optional(Type.Unknown({ description: def.description }));
    } else if (def.type === "boolean") {
      schema[name] = Type.Boolean({ description: def.description });
    } else if (def.type === "array") {
      schema[name] = Type.Array(Type.String(), { description: def.description });
    } else if (def.type === "number") {
      schema[name] = Type.Number({ description: def.description });
    } else {
      schema[name] = def.type === "string"
        ? Type.String({ description: def.description })
        : Type.Unknown({ description: def.description });
    }
  }
  return Type.Object(schema) as any;
}
