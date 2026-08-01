/**
 * pi-comfyui-paint
 *
 * Connects to a ComfyUI server for image/video generation.
 *
 * Configuration (env vars or defaults):
 *   COMFYUI_URL                 - ComfyUI base URL (default: http://127.0.0.1:8188)
 *   COMFYUI_WORKFLOW_DIR        - Workflow JSON folder
 *   COMFYUI_INTERRUPT_ON_ABORT  - Interrupt ComfyUI when a pi paint tool call is cancelled
 *   COMFYUI_IMAGE_QUALITY       - Reserved JPEG quality for optional future inline images (1-100, default: 85).
 *   COMFYUI_IMAGE_MAX_DIMENSION - Reserved max dimension for optional future inline images (default: 2048).
 *
 * Registers 8 tools:
 *   paint_list_workflows  paint_get_details       paint_validate_workflow
 *   paint_server_status   paint_get_models        paint_interrupt
 *   paint                 paint_search_danbooru_tags
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "./config.js";
import { createListWorkflowsTool } from "./tools/list-workflows.js";
import { createGetDetailsTool } from "./tools/get-details.js";
import { createValidateWorkflowTool } from "./tools/validate-workflow.js";
import { createServerStatusTool } from "./tools/server-status.js";
import { createGetModelsTool } from "./tools/get-models.js";
import { createInterruptTool } from "./tools/interrupt.js";
import { createPaintTool } from "./tools/paint.js";
import { createSearchDanbooruTagsTool } from "./tools/search-danbooru-tags.js";
import type { ToolParamDef } from "./tools/tool-utils.js";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const config = getConfig(cwd);

  // Build all tool definitions, then bridge each into pi's ToolDefinition API.
  const tools = [
    createListWorkflowsTool(config.workflowDir, config.bundledWorkflowDir),
    createGetDetailsTool(config),
    createValidateWorkflowTool(config.workflowDir, config.bundledWorkflowDir),
    createServerStatusTool(config),
    createGetModelsTool(config),
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
      ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
      execute(_toolCallId: any, params: any, signal: any, onUpdate: any, _ctx: any) {
        return tool.execute(params as any, signal, onUpdate) as any;
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
function buildSchema(params: Record<string, ToolParamDef>) {
  const schema: Record<string, any> = {};
  for (const [name, def] of Object.entries(params)) {
    if (def.type === "optional") {
      const valueType = def.valueType ?? "unknown";
      if (valueType === "string") {
        schema[name] = Type.Optional(Type.String({ description: def.description }));
      } else if (valueType === "number") {
        schema[name] = Type.Optional(Type.Number({ description: def.description }));
      } else if (valueType === "boolean") {
        schema[name] = Type.Optional(Type.Boolean({ description: def.description }));
      } else if (valueType === "array") {
        schema[name] = Type.Optional(Type.Array(Type.String(), { description: def.description }));
      } else {
        schema[name] = Type.Optional(Type.Unknown({ description: def.description }));
      }
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
