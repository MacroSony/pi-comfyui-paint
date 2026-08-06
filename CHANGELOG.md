# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-06

### Added

- Backend capacity declarations: each backend may declare which workflows it
  can accept via `capabilities` tags (JSON config only), and workflows declare
  their required tags with a `[CAPABILITY]` marker node. `paint` only
  auto-selects among backends offering every required tag, then picks the
  least-queued one; an explicit `backend:` that cannot run the workflow fails
  fast. Backends without a `capabilities` field accept everything (zero-config
  setups are unaffected), and `capabilities: []` soft-disables a backend.
  `paint_get_details` and `paint_validate_workflow(backend)` report the
  workflow's required tags and per-backend fit; `paint_server_status` lists
  every backend's capabilities and every workflow's requirements. Bundled
  workflows now ship with `[CAPABILITY]` tags (e.g. `image, anima`).

- `paint.input_files` entries are now matched by media type instead of strict
  position: each entry can be `{ path, type?: image|video|audio|file, slot?: order }`
  (bare paths infer the type from their extension). Files fill the lowest-numbered
  uncovered slot of their type, so multi-modal workflows (e.g. MiniMax H3 with 9
  image + 3 video + 3 audio slots) accept sparse inputs — one image plus one audio
  without dummy files or workflow edits. `slot` pins an exact `[FILE:type:order]`
  and is validated against the slot's expected type (mismatches error with a
  pointer to `type: "file"` as the escape hatch). Bare paths preserve legacy
  positional mapping only for single-slot and all-image workflows; once slot
  types differ, entries are routed by type instead of strict position, so a
  mixed-type positional caller sees an explicit "matches no uncovered slot"
  error rather than a silently mis-fed node.

- `paint` returns bounded inline JPEG previews for image outputs while always
  retaining the original local paths. Preview count, quality, dimensions,
  per-image bytes, and total bytes are configurable; videos and other media
  remain path-only.
- Private, collision-free per-generation output directories with configurable
  output root and retention. Cleanup only removes expired directories carrying
  the extension's ownership marker.
- Optional `[FILE:type:order:optional]` workflow slots, which are disconnected
  when uncovered so one workflow can support text-to-video and image-guided modes.
- Durable background jobs: `paint(background=true)` returns after prompt
  acceptance, while `paint_job_status` recovers status/results after Pi restarts
  and `paint_job_cancel` targets the recorded prompt.
- Direct multi-backend assignment through `COMFYUI_BACKENDS=id=url,id=url`, with
  least-queued selection, local submission reservations, round-robin ties, and
  explicit backend overrides.
- CI tests both the lockfile Pi API baseline and the latest published Pi API.
- Optional global/project `comfyui-paint.json` configuration with env-var
  overrides, including named backends and local backend output directories.
- Short timestamp job IDs by default, with legacy UUID IDs available through
  `COMFYUI_JOB_ID_STYLE=uuid` or `jobIdStyle: "uuid"`.
- Durable output manifests are persisted before downloads, and new jobs scope
  ComfyUI Save-node prefixes under `paint/<jobId>/` for deterministic recovery.
- A configurable background reconciler periodically captures manifests and
  retrieves completed outputs without waiting for a manual status call.

### Changed

- Generated originals are written with private permissions and are no longer
  retained in memory after being saved. Only the limited preview candidates are
  kept for inline processing.
- Pi/typebox host packages are optional wildcard peers with current versions
  used only as development and CI type-check baselines.
- Inline preview defaults use conservative provider-safe limits:
  2000px longest side, JPEG quality 80, and 4.5 MiB encoded per image.
- Synchronous generation now uses the durable job lifecycle. A wait timeout
  returns a recoverable job ID while ComfyUI continues processing.
- Output downloads stream directly to atomic private files instead of buffering
  complete videos in process memory.
- Job cancellation uses ComfyUI's atomic targeted endpoint when available.
  Legacy backends can still remove pending prompts, but running jobs are not
  subjected to a race-prone backend-wide interrupt.
- Background submissions (`paint(background=true)`) now surface job warnings
  (e.g. uncovered `[FILE]` slots falling back to their defaults) in the
  immediate response, matching the synchronous result path.
- Input uploads stream the multipart body directly from disk instead of
  buffering the whole file in memory, keeping memory constant for large video
  inputs.
- Job status now reports temporarily unreachable backends as retryable
  diagnostics without mutating the persisted job state.

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
- Retryable output-download failures no longer discard an otherwise completed
  ComfyUI generation, and ambiguous submissions are never retried automatically.
- Completed outputs can be recovered after ComfyUI history loss from the saved
  manifest or, for local/mounted backends, from the job-scoped output prefix.
- Uncovered optional `[FILE]` slots now propagate removal to downstream nodes
  whose inputs all referenced removed nodes (e.g. MiniMax H3 ref2va's
  `LoadVideo` → `GetVideoComponents` chain), instead of leaving a broken node
  behind that fails ComfyUI's required-input validation.
- `config` tests are isolated from any real global `~/.pi/agent/comfyui-paint.json`:
  `getConfig` tests point `HOME` at a clean path and restore env vars by
  mutating `process.env` instead of replacing it wholesale (replacing the
  object desyncs Node's cached environ, so a later `os.homedir()` keeps
  returning the stale `$HOME` and leaks the host's global config into tests).

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
