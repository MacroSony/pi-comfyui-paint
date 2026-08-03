/** ComfyUI backend discovery and direct-assignment selection. */

import { comfyFetch } from "./comfyui-client.js";
import type {
  BackendQueueSnapshot,
  ComfyBackend,
  ComfyUIQueueStatus,
} from "./types.js";

const reservations = new Map<string, number>();
let tieCursor = 0;

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function combinedTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`Backend health check timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export function getBackend(backends: ComfyBackend[], id?: string): ComfyBackend {
  if (!id) {
    if (backends.length === 0) throw new Error("No ComfyUI backends are configured.");
    return backends[0];
  }
  const backend = backends.find((candidate) => candidate.id === id);
  if (!backend) {
    throw new Error(
      `Unknown ComfyUI backend '${id}'. Available backends: ${backends.map((b) => b.id).join(", ")}.`,
    );
  }
  return backend;
}

export function promptIdFromQueueEntry(entry: unknown): string | undefined {
  if (Array.isArray(entry) && typeof entry[1] === "string") return entry[1];
  if (entry && typeof entry === "object") {
    const value = entry as Record<string, unknown>;
    for (const key of ["prompt_id", "promptId", "id"]) {
      if (typeof value[key] === "string") return value[key] as string;
    }
  }
  return undefined;
}

export function findPromptInQueue(
  queue: ComfyUIQueueStatus,
  promptId: string,
): "running" | "queued" | undefined {
  if (queue.queue_running?.some((entry) => promptIdFromQueueEntry(entry) === promptId)) {
    return "running";
  }
  if (queue.queue_pending?.some((entry) => promptIdFromQueueEntry(entry) === promptId)) {
    return "queued";
  }
  return undefined;
}

export async function getBackendQueueSnapshot(
  backend: ComfyBackend,
  signal?: AbortSignal,
  timeoutMs = 5000,
): Promise<BackendQueueSnapshot> {
  if (signal?.aborted) throw abortError(signal);
  const timed = combinedTimeoutSignal(signal, timeoutMs);
  try {
    const queue = (await comfyFetch(backend.url, "/queue", {
      signal: timed.signal,
    })) as ComfyUIQueueStatus;
    return {
      backend,
      running: queue.queue_running?.length ?? 0,
      pending: queue.queue_pending?.length ?? 0,
      reservations: reservations.get(backend.id) ?? 0,
      queue,
    };
  } finally {
    timed.cleanup();
  }
}

export interface BackendReservation {
  backend: ComfyBackend;
  snapshot: BackendQueueSnapshot;
  release(): void;
}

/** Reserve the least-loaded reachable backend for one imminent submission. */
export async function reserveBackend(
  backends: ComfyBackend[],
  preferredId?: string,
  signal?: AbortSignal,
  timeoutMs = 5000,
): Promise<BackendReservation> {
  if (signal?.aborted) throw abortError(signal);
  const candidates = preferredId ? [getBackend(backends, preferredId)] : backends;
  const settled = await Promise.allSettled(
    candidates.map((backend) => getBackendQueueSnapshot(backend, signal, timeoutMs)),
  );
  if (signal?.aborted) throw abortError(signal);

  const healthy = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (healthy.length === 0) {
    const failures = settled
      .map((result, index) =>
        result.status === "rejected"
          ? `${candidates[index].id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          : undefined,
      )
      .filter(Boolean)
      .join("; ");
    throw new Error(`No reachable ComfyUI backend${failures ? ` (${failures})` : ""}.`);
  }

  for (const snapshot of healthy) {
    // Refresh the process-local count at selection time. Another concurrent
    // selector may have reserved this backend after its HTTP snapshot completed.
    snapshot.reservations = reservations.get(snapshot.backend.id) ?? 0;
  }
  const minimum = Math.min(
    ...healthy.map((snapshot) => snapshot.running + snapshot.pending + snapshot.reservations),
  );
  const tied = healthy.filter(
    (snapshot) => snapshot.running + snapshot.pending + snapshot.reservations === minimum,
  );
  const snapshot = tied[tieCursor % tied.length];
  tieCursor = (tieCursor + 1) % Number.MAX_SAFE_INTEGER;
  reservations.set(snapshot.backend.id, (reservations.get(snapshot.backend.id) ?? 0) + 1);

  let released = false;
  return {
    backend: snapshot.backend,
    snapshot,
    release() {
      if (released) return;
      released = true;
      const remaining = Math.max((reservations.get(snapshot.backend.id) ?? 1) - 1, 0);
      if (remaining === 0) reservations.delete(snapshot.backend.id);
      else reservations.set(snapshot.backend.id, remaining);
    },
  };
}

/** Test helper; production code should release reservations normally. */
export function resetBackendSelectionState(): void {
  reservations.clear();
  tieCursor = 0;
}
