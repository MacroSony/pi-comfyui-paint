/**
 * paint_get_models tool.
 */

import { comfyFetch } from "../comfyui-client.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

/** Known ComfyUI node classes that expose model lists */
const MODEL_NODES: Record<string, { key: string; label: string }> = {
  CheckpointLoaderSimple: { key: "ckpt_name", label: "Checkpoints" },
  CheckpointLoader: { key: "ckpt_name", label: "Checkpoints (legacy)" },
  UNETLoader: { key: "unet_name", label: "Diffusion Models" },
  CLIPLoader: { key: "clip_name", label: "CLIP" },
  DualCLIPLoader: { key: "clip_name1", label: "Dual CLIP" },
  VAELoader: { key: "vae_name", label: "VAE" },
  LoraLoader: { key: "lora_name", label: "LoRA" },
  LoraLoaderModelOnly: { key: "lora_name", label: "LoRA (model only)" },
  ControlNetLoader: { key: "control_net_name", label: "ControlNet" },
  UpscaleModelLoader: { key: "model_name", label: "Upscale Models" },
  StyleModelLoader: { key: "style_model_name", label: "Style Models" },
  GLIGENLoader: { key: "gligen_name", label: "GLIGEN" },
  PhotoMakerLoader: { key: "photomaker_model_name", label: "PhotoMaker" },
  InstantIDModelLoader: { key: "instantid_file", label: "InstantID" },
};

export function createGetModelsTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_get_models",
    label: "Paint Get Models",
    description:
      "Query the ComfyUI server for available models. " +
      "Returns models grouped by category (Checkpoints, LoRAs, VAEs, ControlNets, etc.). " +
      "Use this to discover what models are installed before generating images, " +
      "so you can reference specific model names in prompts or recommend workflows.",
    promptSnippet: "Query ComfyUI for available models (checkpoints, LoRAs, VAEs, etc.)",
    promptGuidelines: [
      "Use paint_get_models to discover installed models before recommending a workflow or selecting a model name for paint variables.",
    ],
    parameters: {},
    async execute() {
      try {
        const info = (await comfyFetch(config.serverAddress, "/object_info")) as Record<
          string,
          {
            input?: {
              required?: Record<string, [Array<unknown>, Record<string, unknown>?]>;
            };
          }
        >;

        const models: Record<string, string[]> = {};

        for (const [nodeClass, mapping] of Object.entries(MODEL_NODES)) {
          const nodeInfo = info[nodeClass];
          if (!nodeInfo?.input?.required) continue;

          const param = nodeInfo.input.required[mapping.key];
          if (!param || !Array.isArray(param) || !Array.isArray(param[0])) continue;

          const modelList = param[0] as string[];
          if (modelList.length === 0) continue;

          const label = mapping.label;
          if (!models[label]) {
            models[label] = [];
          }
          models[label].push(...modelList);
        }

        if (Object.keys(models).length === 0) {
          return {
            content: [
              { type: "text", text: "No models found. Is ComfyUI running? Check COMFYUI_URL." },
            ],
            details: {},
          };
        }

        const lines: string[] = ["**Available ComfyUI Models:**"];
        for (const [category, names] of Object.entries(models)) {
          const sorted = [...new Set(names)].sort();
          lines.push(`\n**${category}:** ${sorted.join(", ")}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { models },
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `Failed to fetch models from ComfyUI: ${(e as Error).message}` },
          ],
          details: {},
        };
      }
    },
  };
}
