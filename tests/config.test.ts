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
import { envFlag, normalizeComfyUrl } from "../src/config.js";

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

describe("getConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.COMFYUI_URL;
    delete process.env.COMFYUI_WORKFLOW_DIR;
    delete process.env.COMFYUI_INTERRUPT_ON_ABORT;
    delete process.env.COMFYUI_OUTPUT_DIR;
    delete process.env.COMFYUI_OUTPUT_RETENTION_HOURS;
    delete process.env.COMFYUI_INLINE_IMAGE_LIMIT;
    delete process.env.COMFYUI_IMAGE_QUALITY;
    delete process.env.COMFYUI_IMAGE_MAX_DIMENSION;
    delete process.env.COMFYUI_IMAGE_MAX_BYTES;
    delete process.env.COMFYUI_IMAGE_TOTAL_MAX_BYTES;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses defaults when no env vars are set", async () => {
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test-project");
    expect(config.serverAddress).toBe("http://127.0.0.1:8188");
    expect(config.interruptOnAbort).toBe(false);
    expect(config.outputRetentionHours).toBe(168);
    expect(config.outputDirIsDefault).toBe(true);
    expect(config.inlineImageLimit).toBe(1);
    expect(config.imageQuality).toBe(80);
    expect(config.imageMaxDimension).toBe(2000);
    expect(config.imageMaxBytes).toBe(Math.floor(4.5 * 1024 * 1024));
    expect(config.imageTotalMaxBytes).toBe(8 * 1024 * 1024);
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
});
