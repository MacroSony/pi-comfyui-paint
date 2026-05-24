# pi-comfyui-paint

ComfyUI image/video generation extension for [pi](https://github.com/earendil-works/pi-coding-agent).

## Install

```bash
pi install git:github.com/<your-username>/pi-comfyui-paint@v1.0.0
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMFYUI_URL` | `127.0.0.1:8188` | ComfyUI server address |
| `COMFYUI_WORKFLOW_DIR` | (auto) | Custom workflow directory |

## Workflow Resolution

Workflows are resolved in this order:

1. `COMFYUI_WORKFLOW_DIR` env var (if set)
2. `comfyui_workflows/` in your project root
3. `workflows/` bundled with this package (fallback)

Place your own `.json` workflow files in any of these locations.

## Tools

| Tool | Description |
|------|-------------|
| `paint_list_workflows` | List available workflow JSON files |
| `paint_get_details` | Inspect a workflow's variables and notes |
| `paint_get_models` | Query ComfyUI server for available models (checkpoints, LoRAs, etc.) |
| `paint_queue_status` | Check the current generation queue (running + pending) |
| `paint_interrupt` | Cancel the currently running generation |
| `paint` | Generate images/videos from a prompt |

## Workflow Format

Workflow JSONs use `_meta.title` annotations:

- `[VAR] Name` — Customizable variable (exposed as a prompt parameter)
- `[NOTE]` — Documentation shown in `paint_get_details`
- `[OUTPUT:type]` — Tagged output node
- `[FILE:type:order]` — Input file slot
