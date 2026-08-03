/**
 * Tests for config module.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// We need to import the module after setting env vars,
// so we'll dynamic import within each test or use module-level setup.

// Import the pure functions for testing
import { envFlag, normalizeComfyUrl, parseComfyBackends } from "../src/config.js";

describe("envFlag", () => {
  it("returns true for '1'", () => {
    process.env.TEST_FLAG = "1";
    expect(envFlag("TEST_FLAG")).toBe(true);
    delete process.env.TEST_FLAG;
  });

  it("returns true for 'true' (case insensitive)", () => {
    process.env.TEST_FLAG = "True";
    expect(envFlag("TEST_FLAG")).toBe(true);
    delete process.env.TEST_FLAG;
  });

  it("returns true for 'yes'", () => {
    process.env.TEST_FLAG = "yes";
    expect(envFlag("TEST_FLAG")).toBe(true);
    delete process.env.TEST_FLAG;
  });

  it("returns true for 'on'", () => {
    process.env.TEST_FLAG = "on";
    expect(envFlag("TEST_FLAG")).toBe(true);
    delete process.env.TEST_FLAG;
  });

  it("returns false for '0'", () => {
    process.env.TEST_FLAG = "0";
    expect(envFlag("TEST_FLAG")).toBe(false);
    delete process.env.TEST_FLAG;
  });

  it("returns false for empty string", () => {
    process.env.TEST_FLAG = "";
    expect(envFlag("TEST_FLAG")).toBe(false);
    delete process.env.TEST_FLAG;
  });

  it("returns false for unset variable", () => {
    delete process.env.TEST_FLAG;
    expect(envFlag("TEST_FLAG")).toBe(false);
  });

  it("returns false for random string", () => {
    process.env.TEST_FLAG = "random";
    expect(envFlag("TEST_FLAG")).toBe(false);
    delete process.env.TEST_FLAG;
  });
});

describe("normalizeComfyUrl", () => {
  it("uses the full default URL when unset", () => {
    expect(normalizeComfyUrl(undefined)).toBe("http://127.0.0.1:8188");
  });

  it("adds http:// for legacy host:port values", () => {
    expect(normalizeComfyUrl("192.168.1.100:9199")).toBe("http://192.168.1.100:9199");
  });

  it("preserves https URLs", () => {
    expect(normalizeComfyUrl("https://comfy.example.com")).toBe("https://comfy.example.com");
  });

  it("removes trailing slash, query, and hash", () => {
    expect(normalizeComfyUrl("https://comfy.example.com/base/?x=1#top")).toBe("https://comfy.example.com/base");
  });
});

describe("parseComfyBackends", () => {
  it("uses a default backend when the named list is unset", () => {
    expect(parseComfyBackends(undefined, "comfy.test:8188")).toEqual([
      { id: "default", url: "http://comfy.test:8188" },
    ]);
  });

  it("parses named backends", () => {
    expect(parseComfyBackends(
      "gpu-a=http://gpu-a:8188,gpu-b=https://gpu-b.example",
      undefined,
    )).toEqual([
      { id: "gpu-a", url: "http://gpu-a:8188" },
      { id: "gpu-b", url: "https://gpu-b.example" },
    ]);
  });

  it("rejects malformed and duplicate backend IDs", () => {
    expect(() => parseComfyBackends("missing-url", undefined)).toThrow("Expected id=");
    expect(() => parseComfyBackends("gpu=http://a,gpu=http://b", undefined)).toThrow("Duplicate");
  });
});

describe("getConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.COMFYUI_URL;
    delete process.env.COMFYUI_BACKENDS;
    delete process.env.COMFYUI_WORKFLOW_DIR;
    delete process.env.COMFYUI_INTERRUPT_ON_ABORT;
    delete process.env.COMFYUI_OUTPUT_DIR;
    delete process.env.COMFYUI_OUTPUT_RETENTION_HOURS;
    delete process.env.COMFYUI_SYNC_TIMEOUT_SECONDS;
    delete process.env.COMFYUI_INLINE_IMAGE_LIMIT;
    delete process.env.COMFYUI_IMAGE_QUALITY;
    delete process.env.COMFYUI_IMAGE_MAX_DIMENSION;
    delete process.env.COMFYUI_IMAGE_MAX_BYTES;
    delete process.env.COMFYUI_IMAGE_TOTAL_MAX_BYTES;
    delete process.env.COMFYUI_JOB_ID_STYLE;
    delete process.env.COMFYUI_BACKEND_OUTPUT_DIRS;
    delete process.env.COMFYUI_RECONCILE_INTERVAL_SECONDS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses defaults when no env vars are set", async () => {
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test-project");
    expect(config.serverAddress).toBe("http://127.0.0.1:8188");
    expect(config.backends).toEqual([{ id: "default", url: "http://127.0.0.1:8188" }]);
    expect(config.interruptOnAbort).toBe(false);
    expect(config.outputRetentionHours).toBe(168);
    expect(config.syncTimeoutMs).toBe(600_000);
    expect(config.outputDirIsDefault).toBe(true);
    expect(config.inlineImageLimit).toBe(1);
    expect(config.imageQuality).toBe(80);
    expect(config.imageMaxDimension).toBe(2000);
    expect(config.imageMaxBytes).toBe(Math.floor(4.5 * 1024 * 1024));
    expect(config.imageTotalMaxBytes).toBe(8 * 1024 * 1024);
    expect(config.jobIdStyle).toBe("timestamp");
    expect(config.reconcileIntervalMs).toBe(30_000);
    expect(config.configFiles).toEqual([]);
    expect(config.clientId).toMatch(/^pi-paint-/);
    expect(config.projectWorkflowDir).toContain("test-project/.pi/comfyui_workflows");
  });

  it("respects COMFYUI_URL as a full URL", async () => {
    process.env.COMFYUI_URL = "https://comfy.example.com";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.serverAddress).toBe("https://comfy.example.com");
  });

  it("normalizes legacy COMFYUI_URL host:port values", async () => {
    process.env.COMFYUI_URL = "192.168.1.100:9199";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.serverAddress).toBe("http://192.168.1.100:9199");
  });

  it("uses COMFYUI_BACKENDS in preference to COMFYUI_URL", async () => {
    process.env.COMFYUI_URL = "http://ignored:8188";
    process.env.COMFYUI_BACKENDS = "a=http://a:8188,b=http://b:8188";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.backends.map((backend) => backend.id)).toEqual(["a", "b"]);
    expect(config.serverAddress).toBe("http://a:8188");
  });

  it("configures the synchronous wait timeout", async () => {
    process.env.COMFYUI_SYNC_TIMEOUT_SECONDS = "42";
    const { getConfig } = await import("../src/config.js");
    expect(getConfig("/tmp/test").syncTimeoutMs).toBe(42_000);
  });

  it("respects COMFYUI_INTERRUPT_ON_ABORT", async () => {
    process.env.COMFYUI_INTERRUPT_ON_ABORT = "1";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.interruptOnAbort).toBe(true);
  });

  it("respects COMFYUI_IMAGE_QUALITY", async () => {
    process.env.COMFYUI_IMAGE_QUALITY = "50";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.imageQuality).toBe(50);
  });

  it("respects COMFYUI_IMAGE_MAX_DIMENSION", async () => {
    process.env.COMFYUI_IMAGE_MAX_DIMENSION = "4096";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.imageMaxDimension).toBe(4096);
  });

  it("clamps quality=0 to the safe minimum", async () => {
    process.env.COMFYUI_IMAGE_QUALITY = "0";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.imageQuality).toBe(1);
  });

  it("clamps maxDimension=0 to the safe minimum", async () => {
    process.env.COMFYUI_IMAGE_MAX_DIMENSION = "0";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.imageMaxDimension).toBe(1);
  });

  it("clamps COMFYUI_IMAGE_QUALITY above 100 to 100", async () => {
    process.env.COMFYUI_IMAGE_QUALITY = "500";
    const { getConfig } = await import("../src/config.js");
    expect(getConfig("/tmp/test").imageQuality).toBe(100);
  });

  it("clamps negative COMFYUI_IMAGE_QUALITY to 1", async () => {
    process.env.COMFYUI_IMAGE_QUALITY = "-10";
    const { getConfig } = await import("../src/config.js");
    expect(getConfig("/tmp/test").imageQuality).toBe(1);
  });

  it("clamps negative COMFYUI_IMAGE_MAX_DIMENSION to 1", async () => {
    process.env.COMFYUI_IMAGE_MAX_DIMENSION = "-2048";
    const { getConfig } = await import("../src/config.js");
    expect(getConfig("/tmp/test").imageMaxDimension).toBe(1);
  });

  it("falls back to default for non-numeric quality", async () => {
    process.env.COMFYUI_IMAGE_QUALITY = "abc";
    const { getConfig } = await import("../src/config.js");
    expect(getConfig("/tmp/test").imageQuality).toBe(80);
  });

  it("respects and clamps COMFYUI_INLINE_IMAGE_LIMIT", async () => {
    const { getConfig } = await import("../src/config.js");
    process.env.COMFYUI_INLINE_IMAGE_LIMIT = "0";
    expect(getConfig("/tmp/test").inlineImageLimit).toBe(0);
    process.env.COMFYUI_INLINE_IMAGE_LIMIT = "99";
    expect(getConfig("/tmp/test").inlineImageLimit).toBe(4);
  });

  it("resolves a relative COMFYUI_OUTPUT_DIR from the project", async () => {
    process.env.COMFYUI_OUTPUT_DIR = "artifacts/paint";
    const { getConfig } = await import("../src/config.js");
    expect(getConfig("/tmp/test").outputDir).toBe("/tmp/test/artifacts/paint");
    expect(getConfig("/tmp/test").outputDirIsDefault).toBe(false);
  });

  it("accepts disabled output retention", async () => {
    process.env.COMFYUI_OUTPUT_RETENTION_HOURS = "0";
    const { getConfig } = await import("../src/config.js");
    expect(getConfig("/tmp/test").outputRetentionHours).toBe(0);
  });

  it("respects COMFYUI_WORKFLOW_DIR if set", async () => {
    process.env.COMFYUI_WORKFLOW_DIR = "/custom/workflows";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.workflowDir).toBe("/custom/workflows");
  });

  it("uses .pi/comfyui_workflows when present", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-comfyui-paint-"));
    const workflowDir = path.join(projectDir, ".pi", "comfyui_workflows");
    fs.mkdirSync(workflowDir, { recursive: true });

    try {
      const { getConfig } = await import("../src/config.js");
      const config = getConfig(projectDir);
      expect(config.projectWorkflowDir).toBe(workflowDir);
      expect(config.workflowDir).toBe(workflowDir);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reads project comfyui-paint.json and resolves paths from the project root", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-comfyui-paint-config-"));
    process.env.HOME = projectDir;
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "comfyui-paint.json"),
      JSON.stringify({
        backends: [{ id: "gpu", url: "gpu:8188" }],
        outputDir: "artifacts/paint",
        syncTimeoutSeconds: 42,
        interruptOnAbort: true,
        jobIdStyle: "uuid",
        backendOutputDirs: { gpu: "ComfyUI/output" },
      }),
    );

    try {
      const { getConfig } = await import("../src/config.js");
      const config = getConfig(projectDir);
      expect(config.backends).toEqual([{ id: "gpu", url: "http://gpu:8188" }]);
      expect(config.outputDir).toBe(path.join(projectDir, "artifacts/paint"));
      expect(config.syncTimeoutMs).toBe(42_000);
      expect(config.interruptOnAbort).toBe(true);
      expect(config.jobIdStyle).toBe("uuid");
      expect(config.backendOutputDirs).toEqual({ gpu: path.join(projectDir, "ComfyUI/output") });
      expect(config.configFiles).toEqual([path.join(projectDir, ".pi", "comfyui-paint.json")]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("lets env vars override comfyui-paint.json", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-comfyui-paint-config-"));
    process.env.HOME = projectDir;
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "comfyui-paint.json"),
      JSON.stringify({ outputDir: "from-file", syncTimeoutSeconds: 42, jobIdStyle: "uuid" }),
    );
    process.env.COMFYUI_OUTPUT_DIR = "from-env";
    process.env.COMFYUI_SYNC_TIMEOUT_SECONDS = "7";
    process.env.COMFYUI_JOB_ID_STYLE = "timestamp";

    try {
      const { getConfig } = await import("../src/config.js");
      const config = getConfig(projectDir);
      expect(config.outputDir).toBe(path.join(projectDir, "from-env"));
      expect(config.syncTimeoutMs).toBe(7_000);
      expect(config.jobIdStyle).toBe("timestamp");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
