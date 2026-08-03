# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `paint` returns bounded inline JPEG previews for image outputs while always
  retaining the original local paths. Preview count, quality, dimensions,
  per-image bytes, and total bytes are configurable; videos and other media
  remain path-only.
- Private, collision-free per-generation output directories with configurable
  output root and retention. Cleanup only removes expired directories carrying
  the extension's ownership marker.
- Optional `[FILE:type:order:optional]` workflow slots, which are disconnected
  when uncovered so one workflow can support text-to-video and image-guided modes.
- CI tests both the lockfile Pi API baseline and the latest published Pi API.

### Changed

- Generated originals are written with private permissions and are no longer
  retained in memory after being saved. Only the limited preview candidates are
  kept for inline processing.
- Pi/typebox host packages are optional wildcard peers with current versions
  used only as development and CI type-check baselines.
- Inline preview defaults use conservative provider-safe limits:
  2000px longest side, JPEG quality 80, and 4.5 MiB encoded per image.

### Fixed

- Video outputs are never mislabeled as image tool content.
- Output downloads honor cancellation and surface HTTP failures instead of
  silently degrading to a misleading "no images" result.
- Poll sleeps remove completed abort listeners instead of accumulating one per
  second during long generations.
- Workflow listing/status now includes bundled fallbacks when the active
  workflow directory is empty or missing.
- `paint` rejects malformed `variables` and `loras` JSON values rather than
  silently ignoring them.

### Security

- Upgraded `sharp` to the patched 0.35 line.
- Default output roots are ownership-checked and private; generation folders
  and files use user-only permissions on POSIX systems.

## [0.2.0] - 2026-07-31

### Added

- New bundled skill `pi-comfyui-paint-custom-workflow` (registered via
  `pi.skills` in `package.json`): a guide for writing and running custom
  ComfyUI API-format workflow JSONs through `paint` — the annotation
  reference, the write → validate → inspect → generate loop, a hires-fix
  walkthrough, and debugging tips. Referenced from `paint`'s prompt
  guidelines and the README.
- New bundled workflow `T2I_Anime_Anima_hires.json`: two-pass hires fix
  (~1 MP → ~2 MP) for Anima with `[VAR]` Seed1/Seed2/UpscaleWidth/
  UpscaleHeight/Denoise2 knobs and a `[LORA:base_style]` slot; usable by
  name with no copy step.
- Tests now guard every bundled workflow: parses, exposes
  `[VAR]PositivePrompt`, has a tagged output, and validates without errors.
- Bundled workflows are now usable **by name** via per-file fallback in
  `resolveWorkflowPath`: a same-named file in the project directory always wins,
  an empty/absent active directory falls back to the bundled default pick, and
  absolute paths are still accepted.
- `paint` reports diagnostics in its result: workflow name (marked `(bundled)`
  when loaded from the bundled directory), full `workflowPath`, and
  `generationElapsedMs`; the success text shows `Workflow:` and
  `⏱️ Generation time:` lines.
- `paint` warns when `[FILE:type:order]` slots are left uncovered by
  `input_files` (new `collectFileSlotWarnings` helper): it lists the uncovered
  slot numbers and each slot's fallback default, handles non-string defaults,
  and skips the LoadImage `upload` widget key. Warnings are also included in
  early-return `details` (execution error / no outputs / no images).
- `paint_list_workflows` prints one compact summary line per workflow
  (variables, file slots, LoRA slots, outputs) and lists bundled workflows
  marked `(bundled)`.
- `pollHistory` gained a progress callback (`onProgress`, configurable
  interval); `extractExecutionError` surfaces ComfyUI execution failures;
  `getObjectInfo` wraps the `/object_info` endpoint; URL normalization is
  shared through `normalizeComfyUrl`.
- `COMFYUI_IMAGE_QUALITY` and `COMFYUI_IMAGE_MAX_DIMENSION` values are clamped
  to valid ranges; `PI_PAINT_INLINE` is documented.

### Fixed

- `paint_interrupt` description, prompt snippet, and result text no longer
  claim the queue is cleared — ComfyUI `/interrupt` cancels only the
  running task; pending queue items stay queued.
- `paint_get_models` description no longer suggests model names go in
  prompts; they are referenced via `paint` variables and LoRA overrides.

### Removed

- `paint_queue_status` — fully covered by `paint_server_status`, which already
  reports queue running/pending counts.
- `paint_copy_workflow_to_project` — obsolete now that bundled workflows load
  by name; customize by copying files into `.pi/comfyui_workflows/` instead.

### Changed

- Workflow-not-found errors now report every searched location (active
  directory and bundled directory) and note that absolute paths are accepted.
- `paint` success `details.elapsedMs` renamed to `generationElapsedMs` (wall
  time measured up to output download, excluding image compression).

### Tests

- 23 new tests (133 total): bundled-fallback resolution (incl. same-name
  priority, empty-dir default, absolute-path guard),
  `collectFileSlotWarnings` boundary cases (partial coverage, non-array input,
  non-string defaults, upload widget key), and a guard that every bundled
  workflow parses, exposes `[VAR]PositivePrompt`, has a tagged output, and
  validates without errors.

## [0.1.1] - 2026-06-28

### Fixed

- LoRA overrides were dropped when models send object params as JSON strings.
  `prepareArguments` now parses JSON-string `variables` / `loras` /
  `input_files` back into objects before `execute()`.
