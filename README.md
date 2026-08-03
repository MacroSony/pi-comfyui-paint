# pi-comfyui-paint

[![npm version](https://img.shields.io/npm/v/pi-comfyui-paint)](https://www.npmjs.com/package/pi-comfyui-paint)

ComfyUI image/video generation extension for [pi](https://github.com/earendil-works/pi-coding-agent).

## Install

```bash
pi install npm:pi-comfyui-paint
```

Or install a pinned version:

```bash
pi install npm:pi-comfyui-paint@0.2.0
```

Development/git install:

```bash
pi install git:github.com/MacroSony/pi-comfyui-paint@v0.2.0
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI server URL. `https://` URLs are supported; legacy `host:port` values are treated as `http://host:port`. |
| `COMFYUI_WORKFLOW_DIR` | (auto) | Custom workflow directory |
| `COMFYUI_OUTPUT_DIR` | `<temp>/pi-comfyui-paint-<user>` | Root for private, unique per-generation output folders. Relative paths are resolved from the project directory. Set this to a persistent location if results must survive temp cleanup. |
| `COMFYUI_OUTPUT_RETENTION_HOURS` | `168` | Delete extension-managed generation folders older than this many hours when a new generation saves output. Set to `0` to disable extension cleanup. Unmarked folders are never removed. |
| `COMFYUI_INTERRUPT_ON_ABORT` | off | Set to `1`, `true`, `yes`, or `on` to call ComfyUI `/interrupt` when a `paint` tool call is cancelled. By default, cancellation only stops Pi from polling; ComfyUI may continue running. |
| `COMFYUI_INLINE_IMAGE_LIMIT` | `1` | Number of generated images returned to the model as inline previews. Clamped to 0–4; set to `0` for path-only results. |
| `COMFYUI_IMAGE_QUALITY` | `80` | Initial JPEG quality for inline previews, clamped to 1–100. Quality and dimensions are reduced further when needed to meet byte limits. |
| `COMFYUI_IMAGE_MAX_DIMENSION` | `2000` | Maximum width or height of an inline preview. |
| `COMFYUI_IMAGE_MAX_BYTES` | `4718592` | Maximum base64-encoded bytes for one inline preview (4.5 MiB). |
| `COMFYUI_IMAGE_TOTAL_MAX_BYTES` | `8388608` | Maximum base64-encoded bytes across all previews returned by one `paint` call (8 MiB). |

Every generated original is returned by local path. Up to the configured number of image outputs are also returned as bounded JPEG previews so the agent can inspect them without another `read` call. Videos and other non-image outputs are path-only. Preview processing never modifies the originals and does not make an otherwise successful generation fail.

The default output root is user-specific and private. Each generation uses a random subdirectory with user-only directory/file permissions where the platform supports POSIX modes. Paths are temporary by default; configure `COMFYUI_OUTPUT_DIR` for durable output.

## Workflow Resolution

Workflows are resolved in this order:

1. `COMFYUI_WORKFLOW_DIR` env var (if set)
2. `.pi/comfyui_workflows/` in your project root
3. `workflows/` bundled with this package (per-file fallback)

Resolution is **per file**: a workflow name is first looked up in the active directory, then falls back to the bundled directory. This means bundled workflows (`T2I_Anime_Anima.json`, `T2I_Anime_Anima_hires.json`, `I2I_General_QwenImageEdit.json`, …) are usable **by name directly** — no copy step required. A same-named file in the project directory always wins.

Place your own `.json` workflow files in any of these locations. To customize a bundled workflow, copy the `.json` (and its `*.loras.json` sidecar, if any) into `.pi/comfyui_workflows/` and edit the copy.

## Tools

| Tool | Description |
|------|-------------|
| `paint_list_workflows` | List available workflow JSON files with a one-line summary each (variables, file slots, LoRA slots, outputs) |
| `paint_get_details` | Inspect a workflow's variables, notes, outputs, file slots, and LoRA metadata |
| `paint_validate_workflow` | Validate a workflow's JSON structure and pi-comfyui-paint annotations |
| `paint_server_status` | Check ComfyUI connectivity, effective extension configuration, and the current queue state |
| `paint_get_models` | Query ComfyUI server for available models (checkpoints, LoRAs, etc.) |
| `paint_interrupt` | Cancel the currently running generation |
| `paint` | Generate images/videos from a prompt, with optional workflow variables, input files, and LoRA overrides |
| `paint_search_danbooru_tags` | Search Danbooru to confirm tags and find related tags (supports multiple queries) |

`paint_search_danbooru_tags` defaults to wildcard tag-name search. Pass `mode: "related"` to use Danbooru's related-tag endpoint for tags that commonly appear with a tag or search; optional related-mode parameters include `categories`, `order`, `search_sample_size`, and `tag_sample_size`. The tool warns when an input is not exact Danbooru tag spelling, and reports Danbooru request failures separately from successful empty results.

If your environment uses `HTTP_PROXY` or `HTTPS_PROXY` for outbound access, Node may require `NODE_USE_ENV_PROXY=1` for Danbooru requests to use those proxy settings.

## Skills

This package ships the `pi-comfyui-paint-custom-workflow` skill. It teaches the agent how to write and run custom ComfyUI API-format workflow JSONs through `paint`: the `[VAR]` / `[OUTPUT]` / `[FILE]` / `[LORA]` annotation system, the write → validate (`paint_validate_workflow`) → inspect (`paint_get_details`) → generate loop, a two-pass hires-fix walkthrough (bundled as `T2I_Anime_Anima_hires.json`), and debugging tips. The skill loads on demand when you ask the agent to build or tweak a custom workflow — no setup needed.

## ComfyUI Custom Node Dependencies

Most bundled workflows only require standard ComfyUI nodes plus the models listed in `paint_get_details`. LoRA-enabled workflows that use `Power Lora Loader (rgthree)` require [`rgthree/rgthree-comfy`](https://github.com/rgthree/rgthree-comfy) to be installed in your ComfyUI `custom_nodes/` directory.

`Power Lora Loader (rgthree)` is preferred for LoRA workflows because it can load multiple LoRAs in one node, avoiding the need to manually edit workflows when combining style, character, detail, or concept LoRAs.

## Workflow Format

Workflow JSONs use `_meta.title` annotations:

- `[VAR] Name` — Customizable variable (exposed as a prompt parameter)
- `[NOTE]` — Documentation shown in `paint_get_details`
- `[OUTPUT:type]` — Tagged output node
- `[FILE:type:order]` — Input file slot for `paint.input_files`
- `[FILE:type:order:optional]` — Optional input file slot. When no `input_files` entry covers it, the node is removed from the graph (and all downstream links to it are stripped) instead of failing on its placeholder default. Use this for optional image inputs like MiniMax H3 `first_frame`/`last_frame`/`ref_image_N` — one workflow can serve t2v/i2v/fl2v depending on how many files are passed.
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

**Path separators:** Always use forward slashes (`/`) in `file` values, matching ComfyUI's `lora_name` list (e.g. `Krea2/KNPV3.safetensors`). Backslash paths are normalized to forward slashes automatically, but prefer the canonical form. Slot names come from `paint_get_details` (LoRA slots); valid `file` names come from `paint_get_models` (LoRA category) or the "Usable LoRA metadata" in `paint_get_details`. If a LoRA's sidecar metadata declares an `activationPrompt`, copy that tag into `prompt` — it is not injected automatically.
