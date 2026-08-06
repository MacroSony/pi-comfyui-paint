import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findPromptInQueue,
  getBackend,
  reserveBackend,
  backendFitDiagnostic,
  resetBackendSelectionState,
} from "../src/backends.js";
import type { ComfyBackend } from "../src/types.js";

const backends: ComfyBackend[] = [
  { id: "a", url: "http://a.test:8188" },
  { id: "b", url: "http://b.test:8188" },
];

const capableBackends: ComfyBackend[] = [
  { id: "video-box", url: "http://video.test:8188", capabilities: ["video", "h3", "image"] },
  { id: "anime-box", url: "http://anime.test:8188", capabilities: ["image", "anime"] },
  { id: "open-box", url: "http://open.test:8188" },
  { id: "disabled-box", url: "http://disabled.test:8188", capabilities: [] },
];

/** Capability-declaring backends only; no unrestricted entry, so filters are observable. */
const declaredOnlyBackends = capableBackends.filter(
  (backend) => backend.id === "video-box" || backend.id === "anime-box",
);

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
    const reservation = await reserveBackend(backends, { preferredId: "b" });
    expect(reservation.backend.id).toBe("b");
    reservation.release();
  });

  it("selects only among backends that offer every required capability", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const host = new URL(String(input)).hostname;
      return jsonResponse(host === "video.test"
        ? { queue_running: [[0, "busy"]], queue_pending: [] }
        : { queue_running: [], queue_pending: [] });
    }));

    // anime-box is idle but does not offer [video]; video-box is busy but does.
    const reservation = await reserveBackend(declaredOnlyBackends, {
      requiredCapabilities: ["video"],
    });
    expect(reservation.backend.id).toBe("video-box");
    reservation.release();
  });

  it("treats backends without a declared capability list as accepting everything", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const host = new URL(String(input)).hostname;
      return jsonResponse(host === "video.test"
        ? { queue_running: [[0, "busy"]], queue_pending: [] }
        : { queue_running: [], queue_pending: [] });
    }));
    const reservation = await reserveBackend(capableBackends, {
      requiredCapabilities: ["video"],
    });
    expect(reservation.backend.id).toBe("open-box"); // idle and unrestricted
    reservation.release();
  });

  it("prefers least-queued among the capable subset", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const host = new URL(String(input)).hostname;
      return jsonResponse(host === "video.test"
        ? { queue_running: [[0, "busy"]], queue_pending: [] }
        : { queue_running: [], queue_pending: [] });
    }));
    const reservation = await reserveBackend(capableBackends, {
      requiredCapabilities: ["h3", "video"],
    });
    expect(reservation.backend.id).toBe("open-box");
    reservation.release();
  });

  it("excludes soft-disabled backends (capabilities: []) from capability selection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ queue_running: [], queue_pending: [] })));
    const reservation = await reserveBackend(capableBackends, {
      requiredCapabilities: ["image"],
    });
    expect(reservation.backend.id).not.toBe("disabled-box");
    reservation.release();
  });

  it("errors when no backend offers the required capabilities", async () => {
    await expect(reserveBackend(declaredOnlyBackends, {
      requiredCapabilities: ["audio", "h3"],
    })).rejects.toThrow("No configured backend accepts workflow requirements [audio, h3]");
  });

  it("rejects an explicit backend that does not support the workflow", async () => {
    await expect(reserveBackend(capableBackends, {
      preferredId: "anime-box",
      requiredCapabilities: ["video"],
    })).rejects.toThrow("only offers: image, anime (missing: video)");
  });

  it("accepts an explicit backend whose capabilities cover the workflow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ queue_running: [], queue_pending: [] })));
    const reservation = await reserveBackend(capableBackends, {
      preferredId: "video-box",
      requiredCapabilities: ["video", "h3"],
    });
    expect(reservation.backend.id).toBe("video-box");
    reservation.release();
  });
});

describe("backendFitDiagnostic", () => {
  it("accepts when the workflow has no required capabilities", () => {
    expect(backendFitDiagnostic(capableBackends[0], [])).toBeUndefined();
    expect(backendFitDiagnostic(capableBackends[3], [])).toBeUndefined();
  });

  it("accepts when the backend has no declared capabilities", () => {
    expect(backendFitDiagnostic(capableBackends[2], ["video", "h3"])).toBeUndefined();
  });

  it("reports the missing tags for a partial fit", () => {
    const diagnostic = backendFitDiagnostic(capableBackends[1], ["video", "image"]);
    expect(diagnostic).toContain("missing: video");
    expect(diagnostic).toContain("only offers: image, anime");
  });

  it("explains that an empty capability list is a soft-disable", () => {
    const diagnostic = backendFitDiagnostic(capableBackends[3], ["image"]);
    expect(diagnostic).toContain("soft-disabled");
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
