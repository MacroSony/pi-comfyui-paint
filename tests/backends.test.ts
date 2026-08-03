import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findPromptInQueue,
  getBackend,
  reserveBackend,
  resetBackendSelectionState,
} from "../src/backends.js";
import type { ComfyBackend } from "../src/types.js";

const backends: ComfyBackend[] = [
  { id: "a", url: "http://a.test:8188" },
  { id: "b", url: "http://b.test:8188" },
];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("backend selection", () => {
  beforeEach(() => resetBackendSelectionState());
  afterEach(() => vi.unstubAllGlobals());

  it("resolves explicit and default backend IDs", () => {
    expect(getBackend(backends).id).toBe("a");
    expect(getBackend(backends, "b").url).toBe("http://b.test:8188");
    expect(() => getBackend(backends, "missing")).toThrow("Available backends: a, b");
  });

  it("selects the backend with the smallest native queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const host = new URL(String(input)).hostname;
      return jsonResponse(host === "a.test"
        ? { queue_running: [[0, "a-running"]], queue_pending: [[1, "a-pending"]] }
        : { queue_running: [], queue_pending: [] });
    }));

    const reservation = await reserveBackend(backends);
    expect(reservation.backend.id).toBe("b");
    reservation.release();
  });

  it("uses local reservations to spread concurrent submissions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      queue_running: [],
      queue_pending: [],
    })));

    const first = await reserveBackend(backends);
    const second = await reserveBackend(backends);
    expect([first.backend.id, second.backend.id].sort()).toEqual(["a", "b"]);
    first.release();
    second.release();
  });

  it("excludes an unreachable backend", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const host = new URL(String(input)).hostname;
      if (host === "a.test") throw new Error("offline");
      return jsonResponse({ queue_running: [], queue_pending: [] });
    }));

    const reservation = await reserveBackend(backends);
    expect(reservation.backend.id).toBe("b");
    reservation.release();
  });

  it("fails instead of retaining a local job when every backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(reserveBackend(backends)).rejects.toThrow("No reachable ComfyUI backend");
  });

  it("honors an explicit backend even when another has a shorter queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      queue_running: [[0, "busy"]],
      queue_pending: [[1, "waiting"]],
    })));
    const reservation = await reserveBackend(backends, "b");
    expect(reservation.backend.id).toBe("b");
    reservation.release();
  });
});

describe("findPromptInQueue", () => {
  it("recognizes array and object queue entries", () => {
    const queue = {
      queue_running: [[0, "running-id"]],
      queue_pending: [{ prompt_id: "pending-id" }],
    };
    expect(findPromptInQueue(queue, "running-id")).toBe("running");
    expect(findPromptInQueue(queue, "pending-id")).toBe("queued");
    expect(findPromptInQueue(queue, "missing")).toBeUndefined();
  });
});
