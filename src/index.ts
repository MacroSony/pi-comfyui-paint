/**
 * pi-comfyui-paint
 *
 * Connects to a ComfyUI server for image/video generation.
 *
 * Configuration (env vars or defaults):
 *   COMFYUI_URL                 - ComfyUI base URL (default: http://127.0.0.1:8188)
 *   COMFYUI_BACKENDS            - Named backends: id=url,id=url (overrides COMFYUI_URL)
 *   COMFYUI_WORKFLOW_DIR        - Workflow JSON folder
 *   COMFYUI_OUTPUT_DIR          - Root directory for private per-generation output folders
 *   COMFYUI_OUTPUT_RETENTION_HOURS - Retention for managed generation folders (default: 168; 0 disables)
 *   COMFYUI_SYNC_TIMEOUT_SECONDS - Maximum synchronous wait before returning a job ID (default: 600)
 *   COMFYUI_INTERRUPT_ON_ABORT  - Attempt targeted cancellation when a paint tool call is cancelled
 *   COMFYUI_INLINE_IMAGE_LIMIT  - Inline image preview count (0-4, default: 1)
 *   COMFYUI_IMAGE_QUALITY       - Initial JPEG preview quality (1-100, default: 80)
 *   COMFYUI_IMAGE_MAX_DIMENSION - Preview longest-side limit (default: 2000)
 *   COMFYUI_IMAGE_MAX_BYTES     - Per-preview base64 byte limit (default: 4.5 MiB)
 *   COMFYUI_IMAGE_TOTAL_MAX_BYTES - Total preview base64 byte limit (default: 8 MiB)
 *
 * Registers 10 tools:
 *   paint_list_workflows  paint_get_details       paint_validate_workflow
 *   paint_server_status   paint_get_models        paint_interrupt
 *   paint                 paint_job_status         paint_job_cancel
 *   paint_search_danbooru_tags
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { getConfig } from "./config.js";
import { createListWorkflowsTool } from "./tools/list-workflows.js";
import { createGetDetailsTool } from "./tools/get-details.js";
import { createValidateWorkflowTool } from "./tools/validate-workflow.js";
import { createServerStatusTool } from "./tools/server-status.js";
import { createGetModelsTool } from "./tools/get-models.js";
import { createInterruptTool } from "./tools/interrupt.js";
import { createPaintTool } from "./tools/paint.js";
import { createJobStatusTool } from "./tools/job-status.js";
import { createJobCancelTool } from "./tools/job-cancel.js";
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
    createJobStatusTool(config),
    createJobCancelTool(config),
    createSearchDanbooruTagsTool(config),
  ];

  for (const tool of tools) {
    const parameters = buildSchema(tool.parameters);
    pi.registerTool<typeof parameters, Record<string, unknown>>({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters,
      ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
      execute(_toolCallId, params, signal, onUpdate, _ctx) {
        return tool.execute(params, signal, onUpdate);
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `ComfyUI Paint: ${config.backends.map((backend) => backend.id).join(", ")} (${config.workflowDir})`,
        "info",
      );
    }
  });
}

/** Convert simplified param defs to a TypeBox schema. */
function buildSchema(params: Record<string, ToolParamDef>) {
  const schema: Record<string, TSchema> = {};
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
  return Type.Object(schema);
}
