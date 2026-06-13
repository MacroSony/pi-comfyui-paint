/**
 * Tests for ComfyUI client module — pure helper functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveInputFilePath,
  pickFileInputKey,
  abortableSleep,
} from "../src/comfyui-client.js";

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
