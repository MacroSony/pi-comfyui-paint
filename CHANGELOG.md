# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- 19 new tests (129 total): bundled-fallback resolution (incl. same-name
  priority, empty-dir default, absolute-path guard) and
  `collectFileSlotWarnings` boundary cases (partial coverage, non-array input,
  non-string defaults, upload widget key).

## [0.1.1] - 2026-06-28

### Fixed

- LoRA overrides were dropped when models send object params as JSON strings.
  `prepareArguments` now parses JSON-string `variables` / `loras` /
  `input_files` back into objects before `execute()`.
