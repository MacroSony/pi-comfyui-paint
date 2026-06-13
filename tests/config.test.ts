/**
 * Tests for config module.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// We need to import the module after setting env vars,
// so we'll dynamic import within each test or use module-level setup.

// Import the pure functions for testing
import { envFlag } from "../src/config.js";

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

describe("getConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset relevant env vars
    delete process.env.COMFYUI_URL;
    delete process.env.COMFYUI_WORKFLOW_DIR;
    delete process.env.COMFYUI_INTERRUPT_ON_ABORT;
    delete process.env.COMFYUI_IMAGE_QUALITY;
    delete process.env.COMFYUI_IMAGE_MAX_DIMENSION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses defaults when no env vars are set", async () => {
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test-project");
    expect(config.serverAddress).toBe("127.0.0.1:8188");
    expect(config.interruptOnAbort).toBe(false);
    expect(config.imageQuality).toBe(85);
    expect(config.imageMaxDimension).toBe(2048);
    expect(config.clientId).toMatch(/^pi-paint-/);
    expect(config.projectWorkflowDir).toContain("test-project/comfyui_workflows");
  });

  it("respects COMFYUI_URL", async () => {
    process.env.COMFYUI_URL = "192.168.1.100:9199";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.serverAddress).toBe("192.168.1.100:9199");
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

  it("handles quality=0 for raw PNG", async () => {
    process.env.COMFYUI_IMAGE_QUALITY = "0";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.imageQuality).toBe(0);
  });

  it("handles maxDimension=0 for no resize", async () => {
    process.env.COMFYUI_IMAGE_MAX_DIMENSION = "0";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.imageMaxDimension).toBe(0);
  });

  it("respects COMFYUI_WORKFLOW_DIR if set", async () => {
    process.env.COMFYUI_WORKFLOW_DIR = "/custom/workflows";
    const { getConfig } = await import("../src/config.js");
    const config = getConfig("/tmp/test");
    expect(config.workflowDir).toBe("/custom/workflows");
  });
});
