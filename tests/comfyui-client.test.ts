/**
 * Tests for ComfyUI client module — pure helper functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildComfyUrl,
  resolveInputFilePath,
  pickFileInputKey,
  abortableSleep,
  extractExecutionError,
  pollHistory,
} from "../src/comfyui-client.js";
import type { ComfyUIHistoryOutput } from "../src/types.js";

// ─── buildComfyUrl ──────────────────────────────────────────────────────────

describe("buildComfyUrl", () => {
  it("preserves full http URLs", () => {
    expect(buildComfyUrl("http://127.0.0.1:8188", "/queue")).toBe("http://127.0.0.1:8188/queue");
  });

  it("preserves full https URLs", () => {
    expect(buildComfyUrl("https://comfy.example.com", "/queue")).toBe("https://comfy.example.com/queue");
  });

  it("normalizes legacy host:port values", () => {
    expect(buildComfyUrl("127.0.0.1:8188", "/queue")).toBe("http://127.0.0.1:8188/queue");
  });

  it("preserves path-prefixed base URLs", () => {
    expect(buildComfyUrl("https://example.com/comfy/", "/queue")).toBe("https://example.com/comfy/queue");
  });
});

// ─── resolveInputFilePath ────────────────────────────────────────────────────

describe("resolveInputFilePath", () => {
  it("passes through absolute paths", () => {
    const result = resolveInputFilePath("/tmp/test", "/absolute/path/file.png");
    expect(result).toBe("/absolute/path/file.png");
  });

  it("resolves relative paths against cwd", () => {
    const result = resolveInputFilePath("/home/project", "images/input.png");
    expect(result).toBe("/home/project/images/input.png");
  });

  it("resolves .. paths correctly", () => {
    const result = resolveInputFilePath("/home/project", "../shared/input.png");
    expect(result).toBe("/home/shared/input.png");
  });
});

// ─── pickFileInputKey ────────────────────────────────────────────────────────

describe("pickFileInputKey", () => {
  it("picks the expectedType key when available", () => {
    const result = pickFileInputKey(["filename", "image", "path"], "image");
    expect(result).toBe("image");
  });

  it("falls back to generic 'image' when expectedType not found", () => {
    const result = pickFileInputKey(["filename", "path"], "video");
    expect(result).toBe("filename"); // first preferred match
  });

  it("falls back to 'file' key", () => {
    const result = pickFileInputKey(["data", "file", "stuff"], "unknown");
    expect(result).toBe("file");
  });

  it("falls back to 'filename' key", () => {
    const result = pickFileInputKey(["data", "filename", "stuff"], "unknown");
    expect(result).toBe("filename");
  });

  it("returns first key as last resort", () => {
    const result = pickFileInputKey(["custom_param"], "unknown");
    expect(result).toBe("custom_param");
  });

  it("returns undefined for empty keys array", () => {
    const result = pickFileInputKey([], "image");
    expect(result).toBeUndefined();
  });

  it("prefers exact expectedType match over generic 'image'", () => {
    const result = pickFileInputKey(["image", "mask"], "mask");
    expect(result).toBe("mask");
  });
});

// ─── abortableSleep ──────────────────────────────────────────────────────────

describe("abortableSleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the specified time", async () => {
    const promise = abortableSleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1000, controller.signal)).rejects.toThrow(
      "Paint cancelled",
    );
  });

  it("rejects when signal is aborted during sleep", async () => {
    const controller = new AbortController();
    const promise = abortableSleep(5000, controller.signal);

    vi.advanceTimersByTime(1000);
    controller.abort();

    await expect(promise).rejects.toThrow("Paint cancelled");
  });

  it("does not reject if aborted after resolution", async () => {
    const controller = new AbortController();
    const promise = abortableSleep(1000, controller.signal);

    vi.advanceTimersByTime(1000);
    await promise; // should resolve
    controller.abort(); // should not throw
  });
});

// ─── extractExecutionError ───────────────────────────────────────────────────

describe("extractExecutionError", () => {
  it("returns undefined for missing history entry", () => {
    expect(extractExecutionError({}, "abc")).toBeUndefined();
  });

  it("returns undefined for a successful run", () => {
    const history: ComfyUIHistoryOutput = {
      abc: {
        status: { status_str: "success", completed: true, messages: [] },
        outputs: {},
      },
    };
    expect(extractExecutionError(history, "abc")).toBeUndefined();
  });

  it("extracts exception details from execution_error message", () => {
    const history: ComfyUIHistoryOutput = {
      abc: {
        status: {
          status_str: "error",
          completed: false,
          messages: [
            ["execution_error", {
              node_type: "KSampler",
              exception_type: "ValueError",
              exception_message: "steps must be positive",
            }],
          ],
        },
        outputs: {},
      },
    };
    expect(extractExecutionError(history, "abc")).toBe(
      "ValueError: steps must be positive (in node KSampler)",
    );
  });

  it("falls back to a generic message when details are missing", () => {
    const history: ComfyUIHistoryOutput = {
      abc: {
        status: { status_str: "error", completed: false, messages: [] },
        outputs: {},
      },
    };
    expect(extractExecutionError(history, "abc")).toBe("Unknown execution error");
  });
});

// ─── pollHistory ─────────────────────────────────────────────────────────────

describe("pollHistory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls until the prompt appears in history", async () => {
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        polls += 1;
        return {
          ok: true,
          json: async () => (polls >= 3 ? { abc: { outputs: {} } } : {}),
        };
      }),
    );

    const history = await pollHistory("http://comfy.test", "abc", undefined, 5000, 1);
    expect(history["abc"]).toBeDefined();
    expect(polls).toBe(3);
  });

  it("reports progress via onProgress callback", async () => {
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        polls += 1;
        return {
          ok: true,
          json: async () => (polls >= 2 ? { abc: { outputs: {} } } : {}),
        };
      }),
    );

    const elapsed: number[] = [];
    await pollHistory("http://comfy.test", "abc", undefined, 5000, 1, (ms) => elapsed.push(ms), 0);
    expect(elapsed.length).toBeGreaterThan(0);
    expect(elapsed.every((ms) => ms >= 0)).toBe(true);
  });
});
