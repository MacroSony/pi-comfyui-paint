/**
 * Tests for the paint tool's argument preparation shim.
 */

import { describe, it, expect } from "vitest";
import { createPaintTool, collectFileSlotWarnings } from "../src/tools/paint.js";
import type { PaintConfig } from "../src/types.js";

const config: PaintConfig = {
  serverAddress: "http://127.0.0.1:8188",
  workflowDir: "/tmp/wf",
  projectWorkflowDir: "/tmp/proj",
  bundledWorkflowDir: "/tmp/bundled",
  clientId: "test-client",
  interruptOnAbort: false,
  imageQuality: 85,
  imageMaxDimension: 2048,
};

describe("createPaintTool prepareArguments", () => {
  const tool = createPaintTool(config, "/tmp/cwd");

  it("passes plain objects through unchanged", () => {
    const args = { prompt: "a cat", variables: { Width: 1024 } };
    expect(tool.prepareArguments!(args)).toBe(args);
  });

  it("parses JSON-string variables", () => {
    const out = tool.prepareArguments!({ variables: '{"Width": 1024, "Seed": 42}' });
    expect(out.variables).toEqual({ Width: 1024, Seed: 42 });
  });

  it("parses JSON-string loras", () => {
    const out = tool.prepareArguments!({
      loras: '{"base_style": {"file": "style.safetensors", "strength": 0.7}}',
    });
    expect(out.loras).toEqual({ base_style: { file: "style.safetensors", strength: 0.7 } });
  });

  it("parses a JSON-string input_files array", () => {
    const out = tool.prepareArguments!({ input_files: '["a.png", "b.png"]' });
    expect(out.input_files).toEqual(["a.png", "b.png"]);
  });

  it("wraps a single plain-string input_files into an array", () => {
    const out = tool.prepareArguments!({ input_files: "ref.png" });
    expect(out.input_files).toEqual(["ref.png"]);
  });

  it("leaves malformed JSON strings for execute() to reject", () => {
    const out = tool.prepareArguments!({ variables: "{ not json" });
    expect(out.variables).toBe("{ not json");
  });

  it("returns non-object args unchanged", () => {
    expect(tool.prepareArguments!(null)).toBeNull();
    expect(tool.prepareArguments!("prompt only")).toBe("prompt only");
  });
});

describe("collectFileSlotWarnings", () => {
  const slots = [
    { order: 1, nodeId: "10", keys: ["image"], expectedType: "image" },
    { order: 2, nodeId: "20", keys: ["image"], expectedType: "image" },
  ];

  it("returns undefined when there are no file slots", () => {
    expect(collectFileSlotWarnings({}, undefined, [])).toBeUndefined();
  });

  it("returns undefined when all slots are covered", () => {
    const wf = { "10": { inputs: { image: "a.jpg" } }, "20": { inputs: { image: "b.jpg" } } };
    expect(collectFileSlotWarnings(wf, ["a.png", "b.png"], slots)).toBeUndefined();
  });

  it("warns when no input files are provided and names the default image", () => {
    const wf = { "10": { inputs: { image: "default_reze.jpg" } } };
    const warning = collectFileSlotWarnings(wf, undefined, [slots[0]]);
    expect(warning).toContain("1 [FILE] input slot(s) but only 0 of 1 input file(s) provided");
    expect(warning).toContain("slot 1 → default_reze.jpg");
  });

  it("warns about uncovered slots when only some files are provided", () => {
    const wf = { "10": { inputs: { image: "a.jpg" } }, "20": { inputs: { image: "b.jpg" } } };
    const warning = collectFileSlotWarnings(wf, ["a.png"], slots);
    expect(warning).toContain("slot(s) 2");
    expect(warning).toContain("slot 2 → b.jpg");
  });

  it("reports non-string defaults as present", () => {
    const wf = { "10": { inputs: { image: { filename: "x.png", subfolder: "", type: "input" } } } };
    const warning = collectFileSlotWarnings(wf, undefined, [slots[0]]);
    expect(warning).toContain("slot 1 → (default present, non-string)");
  });

  it("reports missing defaults explicitly", () => {
    const wf = { "10": { inputs: {} } };
    const warning = collectFileSlotWarnings(wf, undefined, [slots[0]]);
    expect(warning).toContain("slot 1 → (no default)");
  });

  it("treats a non-array input_files value as zero provided", () => {
    const wf = { "10": { inputs: { image: "a.jpg" } } };
    const warning = collectFileSlotWarnings(wf, "a.png", [slots[0]]);
    expect(warning).toContain("only 0 of 1 input file(s) provided");
  });

  it("counts arrays containing non-strings as provided", () => {
    const wf = { "10": { inputs: { image: "a.jpg" } } };
    expect(collectFileSlotWarnings(wf, ["a.png", 42], [slots[0]])).toBeUndefined();
  });

  it("ignores the LoadImage upload widget key when scanning defaults", () => {
    const wf = { "10": { inputs: { image: "", upload: "image" } } };
    const warning = collectFileSlotWarnings(wf, undefined, [slots[0]]);
    expect(warning).toContain("slot 1 → (no default)");
    expect(warning).not.toContain("→ image");
  });
});
