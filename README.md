# pi-comfyui-paint

ComfyUI image/video generation extension for [pi](https://github.com/earendil-works/pi-coding-agent).

## Install

```bash
pi install npm:pi-comfyui-paint
```

Or install a pinned version:

```bash
pi install npm:pi-comfyui-paint@0.0.4
```

Development/git install:

```bash
pi install git:github.com/MacroSony/pi-comfyui-paint@v0.0.4
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMFYUI_URL` | `127.0.0.1:8188` | ComfyUI server address |
| `COMFYUI_WORKFLOW_DIR` | (auto) | Custom workflow directory |
| `COMFYUI_INTERRUPT_ON_ABORT` | off | Set to `1`, `true`, `yes`, or `on` to call ComfyUI `/interrupt` when a `paint` tool call is cancelled. By default, cancellation only stops Pi from polling; ComfyUI may continue running. |

## Workflow Resolution

Workflows are resolved in this order:

1. `COMFYUI_WORKFLOW_DIR` env var (if set)
2. `comfyui_workflows/` in your project root
3. `workflows/` bundled with this package (fallback)

Place your own `.json` workflow files in any of these locations. To customize the bundled workflows, call `paint_copy_workflow_to_project` first and edit the copied files in `./comfyui_workflows/`.

## Tools

| Tool | Description |
|------|-------------|
| `paint_list_workflows` | List available workflow JSON files |
| `paint_get_details` | Inspect a workflow's variables and notes |
| `paint_validate_workflow` | Validate a workflow's JSON structure and pi-comfyui-paint annotations |
| `paint_copy_workflow_to_project` | Copy bundled workflows into `./comfyui_workflows/` for project customization |
| `paint_server_status` | Check ComfyUI connectivity and effective extension configuration |
| `paint_get_models` | Query ComfyUI server for available models (checkpoints, LoRAs, etc.) |
| `paint_queue_status` | Check the current generation queue (running + pending) |
| `paint_interrupt` | Cancel the currently running generation |
| `paint` | Generate images/videos from a prompt, with optional workflow variables and input files |

## Workflow Format

Workflow JSONs use `_meta.title` annotations:

- `[VAR] Name` — Customizable variable (exposed as a prompt parameter)
- `[NOTE]` — Documentation shown in `paint_get_details`
- `[OUTPUT:type]` — Tagged output node
- `[FILE:type:order]` — Input file slot for `paint.input_files`

For workflows with `[FILE:type:order]` nodes, pass local image paths to `paint` as `input_files` in slot order. Relative paths are resolved from the current project directory, uploaded to ComfyUI as input files, and inserted into the annotated workflow nodes.
