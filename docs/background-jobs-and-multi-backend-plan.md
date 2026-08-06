# Background Jobs and Multi-Backend Plan

Status: implemented; shipped in 0.3.0

Phases 1–3 and targeted cancellation from phase 4 are implemented. Optional
live-session completion notifications remain deferred because durable job
correctness does not depend on them.

## Decision summary

The first implementation will assign every generation directly to a ComfyUI
backend. ComfyUI's native queue becomes the durable execution queue, so an
accepted job continues if the Pi session exits.

The extension will not keep an undispatched central queue in this version. A
shared late-binding queue remains a useful future direction, but it requires an
always-running worker to guarantee progress while Pi is closed.

This plan adds:

- background generation with durable job records;
- synchronous generation implemented on top of the same job lifecycle;
- direct selection among multiple ComfyUI backends;
- job status, result retrieval, and targeted cancellation;
- streaming output downloads, especially for large videos;
- backend-aware status and diagnostics.

## Goals

1. Let long-running video generations continue without holding a Pi tool call
   open.
2. Preserve accepted work when the Pi process or session exits.
3. Execute jobs in parallel when multiple ComfyUI backends are available.
4. Keep the existing single-backend and synchronous `paint` behavior compatible.
5. Make job and output recovery possible after extension reloads and Pi restarts.
6. Avoid duplicate expensive generations during ambiguous network failures.

## Non-goals for the first implementation

- No extension-owned pending queue.
- No calendar or `notBefore` scheduling.
- No duration estimator or shortest-job scheduling.
- No standalone dispatcher/daemon.
- No automatic migration after a backend accepts a prompt.
- No automatic retry when prompt submission may have succeeded.
- No assumption that one ComfyUI process can execute multiple GPU jobs in
  parallel.
- No automatic model/custom-node synchronization between backends.

## High-level lifecycle

```text
paint request
    |
    v
prepare workflow and validate local inputs
    |
    v
inspect backend queues and select one backend
    |
    v
create durable job record and upload inputs to that backend
    |
    v
submit prompt directly to the selected ComfyUI queue
    |
    +-------------------- background=true ------------------> return job ID
    |
    +-------------------- background=false -----------------> wait for result
                                                                  |
                                                                  v
                                                    stream outputs to disk
```

Once ComfyUI returns a prompt ID, that backend permanently owns the job. All
history checks, cancellation, downloads, and diagnostics use the recorded
backend.

## User-facing API

### `paint`

Add two optional parameters:

- `background: boolean` — defaults to `false`. When true, return after ComfyUI
  accepts the prompt.
- `backend: string` — force a configured backend by ID. When omitted, select
  automatically.

Synchronous `paint` will use the same submit-and-record path and then wait for
the recorded job. This prevents the synchronous and background implementations
from drifting apart.

If a synchronous wait reaches its timeout, the result should report that the
job is still running and return its job ID instead of losing track of it. The
ComfyUI job continues.

### `paint_job_status`

- With `job_id`, reconcile one job with its recorded backend.
- With no `job_id`, list recent jobs and their summarized states.
- When a completed job has not yet been finalized, download its outputs once.
- Return bounded image previews and original output paths using the existing
  preview policy.
- Optionally support a short bounded wait in a later iteration; it is not needed
  for the initial implementation.

### `paint_job_cancel`

- Use ComfyUI's atomic per-job cancellation API for queued or running prompts
  when the backend supports it.
- On older backends, safely remove an exact pending prompt but leave running
  work untouched; the legacy `/interrupt` endpoint is backend-wide and can race
  with the next prompt.
- Never interrupt an unrelated job merely because it shares the backend.
- Preserve `paint_interrupt` as the explicit backend-wide/current-job escape
  hatch for compatibility.

## Backend configuration

Keep `COMFYUI_URL` fully compatible. If no multi-backend setting is present, it
creates one backend with ID `default`.

Add a simple named list:

```bash
COMFYUI_BACKENDS="gpu-a=http://gpu-a:8188,gpu-b=http://gpu-b:8188"
```

Rules:

- IDs must be unique and contain only a conservative identifier character set.
- URLs use the existing normalization rules.
- Invalid entries fail configuration clearly at startup.
- `COMFYUI_BACKENDS` takes precedence over `COMFYUI_URL`.
- The first version assumes all automatically selected backends have compatible
  models, custom nodes, and workflows.
- The explicit `backend` parameter provides an escape hatch for heterogeneous
  installations.

A structured backend file with tags, weights, authentication, or workflow
allowlists can be introduced later without changing the job model.

## Direct backend selection

For automatic selection:

1. Query `/queue` on all configured backends concurrently with a short health
   timeout.
2. Exclude unreachable backends for this selection attempt.
3. Compute `running + pending + localReservations` for each reachable backend.
4. Choose the smallest value.
5. Break ties with process-local round-robin selection.
6. Hold a local reservation until submission succeeds or fails, preventing
   simultaneous tool calls from selecting the same apparently idle backend.

If every backend is busy, submit to the backend with the smallest native queue.
This deliberately delegates durable waiting to ComfyUI instead of retaining the
job locally.

If the caller specifies a backend, use it or return a clear error; do not fall
back silently.

If all backends are unreachable, fail without creating a locally pending job.

This selector does not estimate duration. It is intentionally basic; native
backend queues remain the source of truth.

## Durable job records

Create the private job directory before prompt submission. Store one atomic JSON
record per job rather than maintaining a single mutable registry file.

Proposed layout:

```text
<output-root>/job-<id>/
  .pi-comfyui-paint-output
  job.json
  workflow.json
  outputs/
    paint_....png
    paint_....mp4
```

`job.json` should be versioned and contain:

- extension job ID;
- state and state timestamps;
- backend ID and URL identity;
- ComfyUI prompt ID, once known;
- workflow name, path, and hash;
- prompt, negative prompt, variables, and LoRA overrides;
- source input paths and uploaded input identities;
- submission and execution errors;
- generated file metadata and local paths;
- whether finalization/download has completed;
- timing information.

Write updates through a temporary file followed by an atomic rename. Do not put
base64 previews or output media bytes in the record.

The job ID is generated by the extension before contacting ComfyUI. It remains
stable even if submission fails or the Comfy prompt ID is unavailable.

## Job states

Initial state model:

```text
preparing
  -> submitting
      -> submitted
          -> queued
          -> running
          -> finalizing
              -> completed
          -> failed
      -> submission_unknown
  -> failed

queued/running -> cancelling -> cancelled
```

`submission_unknown` is important: a POST can reach ComfyUI even if the response
is lost. Such a job must not be submitted automatically to another backend.

On reconciliation:

1. Query `/history/<promptId>` for terminal output or execution failure.
2. If absent, inspect the recorded backend's queue to distinguish queued and
   running states.
3. If absent from both, retain an `unknown` diagnostic instead of claiming
   success or failure without evidence.

## Output finalization

Refactor output handling out of `paint` so synchronous and background jobs call
the same finalizer.

Large files must stream from the ComfyUI response directly to a private file.
The previous whole-response `arrayBuffer()` path has been removed, so a large
video download no longer scales process memory with the complete output size.

Finalization requirements:

- idempotent: repeated status calls reuse already-downloaded outputs;
- private file permissions;
- no videos embedded in tool content;
- bounded image previews generated from saved files;
- partial download failures recorded without misreporting completion;
- output filenames collision-safe within the job directory.

A process-local per-job mutex is sufficient for the first version. The durable
state should still make duplicate finalization detectable after restarts.

## Cancellation and abort behavior

Tool-call cancellation and job cancellation are different operations.

- `paint_job_cancel` explicitly cancels the durable job.
- Cancelling a background submission before ComfyUI accepts it aborts the
  submission.
- Cancelling a synchronous waiting tool call follows the existing
  `COMFYUI_INTERRUPT_ON_ABORT` policy.
- When interrupt-on-abort is disabled, the job detaches from the tool call and
  remains retrievable by job ID.
- When enabled, use the same targeted cancellation rules as
  `paint_job_cancel`; running work on a legacy backend is left untouched.

The ComfyUI queue-delete request, tuple/object queue entry shapes, current
atomic cancellation endpoint, and safe legacy fallback are covered by tests.

## Retention

- Active jobs (`preparing`, `submitted`, `queued`, `running`, `finalizing`,
  `finalization_failed`, or
  uncertain submission) are never removed by age-based cleanup.
- Terminal job directories use `COMFYUI_OUTPUT_RETENTION_HOURS`.
- Retention age should be based on terminal/completion time, not submission time.
- Existing marked generation directories remain eligible under the current
  retention behavior for backward compatibility.

## Existing tools under multiple backends

### `paint_server_status`

Report every backend independently:

- ID and normalized URL;
- reachable/unreachable state;
- running and pending counts;
- recent error;
- number of extension jobs associated with it.

Also report which configuration source is active and whether automatic selection
assumes homogeneous backends.

### `paint_get_models`

Add an optional `backend` parameter. With one backend, behavior is unchanged.
With multiple backends and no explicit selection, initially query the first
configured backend and state that choice clearly. Aggregated model intersection
or union can be added later because it may create very large tool results.

### `paint_get_details`

Workflow parsing remains backend-independent. Installed-LoRA checks should use
an explicitly requested backend when available; otherwise use the same clearly
reported default backend behavior as `paint_get_models`.

### `paint_interrupt`

Add an optional backend selector when multiple backends are configured. Require
it when more than one backend exists to avoid interrupting an arbitrary server.

## Internal refactor

Suggested modules:

- `src/backends.ts` — backend parsing, health snapshots, selection, and local
  reservations;
- `src/job-store.ts` — job IDs, directories, atomic records, listing, retention,
  and state transitions;
- `src/generation.ts` — workflow preparation and backend-independent validation;
- `src/job-runner.ts` — upload, submit, reconcile, cancel, wait, and finalize;
- `src/output-download.ts` — streamed downloads and MIME/file metadata;
- `src/tools/job-status.ts` and `src/tools/job-cancel.ts` — user-facing job tools.

`src/tools/paint.ts` should become orchestration rather than owning every stage.

## Implementation phases

### Phase 1: foundations without behavior change

1. Introduce `ComfyBackend` and convert the existing single URL into a one-item
   backend list.
2. Refactor workflow preparation out of `paint`.
3. Refactor output finalization and stream downloads to disk.
4. Keep synchronous `paint` behavior and existing tools working.
5. Add unit tests for the single-backend compatibility path.

### Phase 2: durable jobs and background execution

1. Add the versioned job store and job-specific output directories.
2. Make synchronous `paint` submit a recorded job and wait on it.
3. Add `background` to `paint`.
4. Add `paint_job_status` and idempotent result finalization.
5. Reconcile jobs after extension/session restart through explicit status calls.
6. Ensure synchronous timeout/abort returns or preserves the job ID.

### Phase 3: multiple direct-assigned backends

1. Parse `COMFYUI_BACKENDS` with `COMFYUI_URL` fallback.
2. Add concurrent queue/health snapshots and least-queued selection.
3. Add local reservations and round-robin tie breaking.
4. Add the explicit `backend` parameter.
5. Make every job operation backend-sticky.
6. Update server status, model lookup, LoRA checks, and interrupt behavior.

### Phase 4: cancellation and live-session conveniences

1. Add targeted `paint_job_cancel` for native queued and running work.
2. Optionally monitor active background jobs while Pi remains open.
3. Use Pi's public message API for a non-triggering completion notice.
4. Stop monitoring cleanly on session shutdown; job correctness must not depend
   on the monitor.

### Phase 5: dogfood and hardening

1. Exercise long H3 jobs across Pi shutdown/restart.
2. Exercise simultaneous submissions against two backends.
3. Test backend loss before submission, after submission, and during download.
4. Verify large video downloads do not scale process memory with file size.
5. Confirm repeated status calls never duplicate output files.
6. Confirm retention never deletes active or uncertain jobs.

## Test matrix

At minimum, automated tests should cover:

- legacy `COMFYUI_URL` creates the `default` backend;
- valid and invalid named multi-backend configuration;
- explicit backend selection;
- least-queued selection and deterministic tie rotation;
- simultaneous selections respect local reservations;
- unreachable backends are excluded;
- all-unreachable produces no locally pending job;
- background paint returns after prompt acceptance without polling history;
- synchronous and background paths produce the same durable metadata;
- restart simulation can reconcile a submitted job from disk;
- completed results finalize exactly once;
- images preview inline while videos remain path-only;
- large response bodies stream to files;
- ambiguous submission is never retried automatically;
- queued versus running targeted cancellation;
- active job retention protection;
- old terminal job cleanup;
- single-backend behavior remains compatible with the current extension.

## Future shared queue

The late-binding central queue remains desirable if an always-running worker is
introduced. It would improve fairness and let the first compatible free backend
pull the next job without duration estimation.

That future worker can reuse the job store, backend abstraction, state model,
streamed finalizer, and job tools from this plan. The dispatch transition would
change from immediate direct assignment to:

```text
pending locally -> leased by worker -> assigned to free backend -> submitted
```

Until such a worker exists, direct assignment is the safer durability tradeoff.

## Definition of done

- A background H3 job returns a durable job ID shortly after ComfyUI accepts it.
- The accepted generation continues after Pi exits.
- A later Pi session can query the job and retrieve its outputs.
- With two available backends, independent jobs can run in parallel.
- Backend choice and all later operations are visible and reproducible.
- Large video output download does not require buffering the whole file.
- No ambiguous submission is duplicated automatically.
- The current single-backend synchronous workflow remains supported.
