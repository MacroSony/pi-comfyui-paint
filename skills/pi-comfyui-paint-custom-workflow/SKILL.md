---
name: pi-comfyui-paint-custom-workflow
description: How to run hand-written / custom ComfyUI workflows through the pi-comfyui-paint `paint` tool — write an API-format workflow JSON into .pi/comfyui_workflows/, use optional [VAR]/[OUTPUT]/[FILE]/[LORA] annotations, validate, and generate. Use when the user asks to run a DIY/custom workflow, tweak pipeline internals (hires fix, upscale, second-pass denoise), or when bundled workflows don't fit the request.
---

# Custom Workflows with pi-comfyui-paint

The `paint` tool is not limited to the workflows it ships with. Any ComfyUI API-format workflow JSON placed in `.pi/comfyui_workflows/` can be referenced **by name**. **All annotations are optional** — an unannotated workflow runs as-is.

For long video workflows, call `paint` with `background: true`, keep the returned job ID, and use `paint_job_status` later. Once ComfyUI accepts the prompt, its native queue continues processing even if the Pi session exits.

## ComfyUI API workflow JSON format

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "anima_baseV10.safetensors", "weight_dtype": "default" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "masterpiece, 1girl", "clip": ["5", 0] } },
  "3": { "class_type": "KSampler", "inputs": { "seed": 42, "steps": 25, "cfg": 4, "sampler_name": "er_sde", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["2", 0], "negative": ["6", 0], "latent_image": ["7", 0] } }
}
```

- Top level: `node_id → { class_type, inputs, _meta? }` (string node ids)
- Node connections use the array syntax `["<node_id>", <output_index>]`
- `_meta.title` carries the annotation system (see below); omit `_meta` entirely for a bare workflow
- `PrimitiveString` / `PrimitiveInt` / `PrimitiveFloat` nodes are the standard way to expose values as `[VAR]`s

## Annotation behavior (all optional)

| Annotation | Purpose | If omitted |
|---|---|---|
| `[VAR] Name` on a Primitive* node | `paint.variables` / `prompt` / `negative_prompt` injection point | prompt & variables are **ignored**; the workflow's hardcoded values are used |
| `[OUTPUT:image]` on a SaveImage node | Marks the result node | fallback: **all** output nodes are scanned & downloaded |
| `[FILE:image:1]` on a LoadImage node | `paint.input_files` upload slot (order = number). Entries are matched by media type, not strict position — see “Skipping file slots” below | no slot; passing input_files errors; without input_files no warning is raised |
| `[FILE:image:1:optional]` on a LoadImage node | Optional upload slot: uncovered slots are **removed from the graph** (downstream links stripped) so optional model inputs stay unconnected | same as above |
| `[LORA:slot]` on a Power Lora Loader (rgthree) | `paint.loras` override slot | unannotated Power Lora Loaders are auto-detected as `node_<id>` slots — overrides still work via that name, but annotation is recommended |
| `[NOTE]` | Documentation shown in `paint_get_details` | — |

Warnings: if a workflow **has** `[FILE]` slots but some are not covered by `input_files`, `paint` warns and the uncovered LoadImage node falls back to its default input image. Slots marked `:optional` are exempt — they are disconnected from the graph instead, which lets one workflow serve multiple modes (e.g. MiniMax H3: 0 files = t2v, 1 = i2v, 2 = fl2v). Because entries are matched by media type, “uncovered” means the slots you didn't target — not merely the trailing ones.

### Skipping file slots (multi-modal nodes)

`input_files` entries are routed by media type, so a later slot never requires filling earlier ones. Each entry is a bare path (type inferred from extension) or an object:

```json
{
  "workflow": "minimax_h3.json",
  "prompt": "...",
  "input_files": [
    { "path": "first_frame.png", "type": "image" },
    { "path": "bgm.mp3", "type": "audio" }
  ]
}
```

The image goes to the first uncovered `[FILE:image:N]` slot and the audio to the first uncovered `[FILE:audio:N]` slot regardless of slot order — a 9-image + 3-video + 3-audio H3 workflow needs no editing and no dummy files. `{ "path": ..., "type": "file" }` matches any slot (positional fallback); `{ "path": ..., "slot": 13 }` pins an exact `[FILE:type:order]` — the file's type must match that slot's expected type, otherwise `paint` errors (use `type: "file"` to bypass). Uncovered `:optional` slots are disconnected from the graph; uncovered required slots fall back to their defaults (with a warning).

## Workflow

1. **Write** the workflow JSON to `.pi/comfyui_workflows/<name>.json` (project dir) — or any absolute path; resolution order is: active dir → absolute path → bundled dir (same-name project file always wins).
2. **Validate**: `paint_validate_workflow <name>` — checks parseability + annotation structure.
3. **Inspect**: `paint_get_details <name>` — confirms variables, output nodes, file slots, LoRA slots.
4. **Generate**: `paint` with `workflow: "<name>.json"`, plus `prompt` / `negative_prompt` / `variables` / `input_files` / `loras` as needed.

For anime models trained on Danbooru tags (e.g. Anima), use `paint_search_danbooru_tags` to confirm tag spelling before writing the prompt.

## Example: hires fix (1MP → 2MP, two-pass sampling)

A two-pass pipeline — full denoise at 1MP, pixel-upscale to 2MP, re-encode, then a second low-denoise pass. This exact workflow ships bundled as `T2I_Anime_Anima_hires.json` (Anima-compatible) — usable **by name with no copy step**, and a good starting point to copy into `.pi/comfyui_workflows/` and adapt:

```
UNETLoader(anima_baseV10) ─┐
CLIPLoader(qwen_3_06b) ────┤
VAELoader(qwen_image_vae) ─┤
                           ├─ KSampler#1 (denoise 1.0, 1MP latent)
Positive [VAR] ────────────┘        │
                                    ▼
                              VAEDecode
                                    │
                              ImageScale (lanczos, → 1448×1448 ≈ 2MP)
                                    │
                              VAEEncode
                                    │
KSampler#2 (denoise 0.3–0.4) ◄──────┘  ← second pass restores detail
                                    │
                              VAEDecode → SaveImage [OUTPUT:image]
```

`[VAR]Seed1` / `[VAR]Seed2` / `[VAR]Denoise2` / `[VAR]UpscaleWidth` / `[VAR]UpscaleHeight` expose the knobs as `paint.variables`. Key points from real usage:
- Two-pass at 1024²→1448² took ~88s on a fast GPU; output had no artifacts, no over-sharpening, quality on par with native 1448² renders
- `Denoise2` in the 0.3–0.45 range keeps composition while adding detail; >0.5 starts drifting toward a redraw
- Seed1 and Seed2 should differ for the second pass; keep sampler/scheduler identical (er_sde/simple worked well with Anima)

## Debugging

- `Workflow not found: X (looked in A and bundled B); absolute paths are also accepted` → file isn't where you think; check the path or move it into `.pi/comfyui_workflows/`
- Generation fails inside ComfyUI → `paint` returns the `execution_error` message with node info; check the failing node's class_type (custom nodes must be installed) and that model names exactly match `paint_get_models` output
- Queue busy / stuck → `paint_server_status` shows queue state; `paint_interrupt` cancels
- No output but status success → no `[OUTPUT]` tag and no output nodes detected; add `[OUTPUT:image]` to the SaveImage node

## Gotchas

- Model/CLIP/VAE filenames must exactly match what `paint_get_models` reports (subfolders use forward slashes, e.g. `anima/[Style]foo.safetensors`)
- Class types must exist in the running ComfyUI (`/object_info`); rgthree nodes require the rgthree-comfy custom node pack
- Same-named file in project dir shadows the bundled one
- `.loras.json` sidecars next to a workflow carry LoRA metadata for `paint_get_details`; they're ignored by the loader itself
