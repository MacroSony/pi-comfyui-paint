# pi-comfyui-paint

[![npm version](https://img.shields.io/npm/v/pi-comfyui-paint)](https://www.npmjs.com/package/pi-comfyui-paint)

ComfyUI image/video generation extension for [pi](https://github.com/earendil-works/pi-coding-agent).

## Install

```bash
pi install npm:pi-comfyui-paint
```

Or install a pinned version:

```bash
pi install npm:pi-comfyui-paint@0.1.0
```

Development/git install:

```bash
pi install git:github.com/MacroSony/pi-comfyui-paint@v0.1.0
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI server URL. `https://` URLs are supported; legacy `host:port` values are treated as `http://host:port`. |
| `COMFYUI_WORKFLOW_DIR` | (auto) | Custom workflow directory |
| `COMFYUI_INTERRUPT_ON_ABORT` | off | Set to `1`, `true`, `yes`, or `on` to call ComfyUI `/interrupt` when a `paint` tool call is cancelled. By default, cancellation only stops Pi from polling; ComfyUI may continue running. |
| `COMFYUI_IMAGE_QUALITY` | `85` | JPEG quality (1–100) for images sent to the LLM provider. Set to `0` to send raw PNG with no compression. Original files on disk are never modified. |
| `COMFYUI_IMAGE_MAX_DIMENSION` | `2048` | Resize images so the longest side ≤ this many pixels before sending to the LLM. Set to `0` to skip resizing. Original files on disk are never modified. |

## Workflow Resolution

Workflows are resolved in this order:

1. `COMFYUI_WORKFLOW_DIR` env var (if set)
2. `.pi/comfyui_workflows/` in your project root
3. `workflows/` bundled with this package (fallback)

Place your own `.json` workflow files in any of these locations. To customize the bundled workflows, call `paint_copy_workflow_to_project` first and edit the copied files in `.pi/comfyui_workflows/`.

## Tools

| Tool | Description |
|------|-------------|
| `paint_list_workflows` | List available workflow JSON files |
| `paint_get_details` | Inspect a workflow's variables and notes |
| `paint_validate_workflow` | Validate a workflow's JSON structure and pi-comfyui-paint annotations |
| `paint_copy_workflow_to_project` | Copy bundled workflows into `.pi/comfyui_workflows/` for project customization |
| `paint_server_status` | Check ComfyUI connectivity and effective extension configuration |
| `paint_get_models` | Query ComfyUI server for available models (checkpoints, LoRAs, etc.) |
| `paint_queue_status` | Check the current generation queue (running + pending) |
| `paint_interrupt` | Cancel the currently running generation |
| `paint` | Generate images/videos from a prompt, with optional workflow variables and input files |
| `paint_search_danbooru_tags` | Search Danbooru to confirm tags and find related tags (supports multiple queries) |

`paint_search_danbooru_tags` defaults to wildcard tag-name search. Pass `mode: "related"` to use Danbooru's related-tag endpoint for tags that commonly appear with a tag or search; optional related-mode parameters include `categories`, `order`, `search_sample_size`, and `tag_sample_size`. The tool warns when an input is not exact Danbooru tag spelling, and reports Danbooru request failures separately from successful empty results.

If your environment uses `HTTP_PROXY` or `HTTPS_PROXY` for outbound access, Node may require `NODE_USE_ENV_PROXY=1` for Danbooru requests to use those proxy settings.

## ComfyUI Custom Node Dependencies

Most bundled workflows only require standard ComfyUI nodes plus the models listed in `paint_get_details`. LoRA-enabled workflows that use `Power Lora Loader (rgthree)` require [`rgthree/rgthree-comfy`](https://github.com/rgthree/rgthree-comfy) to be installed in your ComfyUI `custom_nodes/` directory.

`Power Lora Loader (rgthree)` is preferred for LoRA workflows because it can load multiple LoRAs in one node, avoiding the need to manually edit workflows when combining style, character, detail, or concept LoRAs.

## Workflow Format

Workflow JSONs use `_meta.title` annotations:

- `[VAR] Name` — Customizable variable (exposed as a prompt parameter)
- `[NOTE]` — Documentation shown in `paint_get_details`
- `[OUTPUT:type]` — Tagged output node
- `[FILE:type:order]` — Input file slot for `paint.input_files`
- `[LORA:slot]` — LoRA loader slot for `paint.loras` overrides. Intended for `Power Lora Loader (rgthree)` nodes.

For workflows with `[FILE:type:order]` nodes, pass local image paths to `paint` as `input_files` in slot order. Relative paths are resolved from the current project directory, uploaded to ComfyUI as input files, and inserted into the annotated workflow nodes.

## LoRA Workflows

LoRA-enabled workflows should use [`Power Lora Loader (rgthree)`](https://github.com/rgthree/rgthree-comfy) and annotate each loader with a simple slot name:

```txt
[LORA:base_style] Power Lora Loader (rgthree)
[LORA:hires_detail] Power Lora Loader (rgthree)
[LORA:inpaint_character] Power Lora Loader (rgthree)
```

`paint_get_details` detects these slots and returns LoRA slot info together with workflow variables, notes, outputs, and sidecar metadata.

Optional LoRA metadata can be stored next to a workflow:

```txt
.pi/comfyui_workflows/T2I_Anime_Anima_lora.json
.pi/comfyui_workflows/T2I_Anime_Anima_lora.loras.json
```

Example sidecar entry:

```json
{
  "file": "anima/[Style]saio_ga_ushi_v1.safetensors",
  "displayName": "Saio ga Ushi Style",
  "activationPrompt": "@saio ga ushi",
  "defaultStrength": 0.7,
  "description": "Artist/style LoRA for Anima. Add the activation tag to the prompt when you want this style."
}
```

Use LoRA overrides in `paint` like this:

```json
{
  "workflow": "T2I_Anime_Anima_lora.json",
  "prompt": "masterpiece, best quality, score_7, safe, 1girl, @saio ga ushi, smile",
  "loras": {
    "base_style": {
      "file": "anima/[Style]saio_ga_ushi_v1.safetensors",
      "strength": 0.7
    }
  }
}
```

To load multiple LoRAs into one Power Lora Loader slot, use an array:

```json
{
  "loras": {
    "base_style": [
      { "file": "anima/[Style]saio_ga_ushi_v1.safetensors", "strength": 0.7 },
      { "file": "anima/[Detail]some_detail_lora.safetensors", "strength": 0.35 }
    ]
  }
}
```

LoRA overrides replace the contents of the named slot. Activation tags are not added automatically; put them in `prompt` yourself based on `paint_get_details` metadata.
