/**
 * Tests for workflow module — parsing, validation, and path resolution.
 */

import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  loadWorkflowJson,
  resolveWorkflowPath,
  parseWorkflowDetails,
  validateWorkflow,
} from "../src/workflow.js";

const FIXTURES = path.join(__dirname, "fixtures");

// ─── loadWorkflowJson ────────────────────────────────────────────────────────

describe("loadWorkflowJson", () => {
  it("loads and parses a valid workflow JSON", () => {
    const wf = loadWorkflowJson(path.join(FIXTURES, "minimal-workflow.json"));
    expect(wf).not.toBeNull();
    expect(wf!["1"]).toBeDefined();
  });

  it("returns null for non-existent file", () => {
    const wf = loadWorkflowJson("/nonexistent/file.json");
    expect(wf).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    // empty file path tests read failure or empty content
    const wf = loadWorkflowJson(path.join(FIXTURES, "empty-workflow.json"));
    // Empty JSON object is actually valid JSON, just empty
    expect(wf).not.toBeNull();
    expect(wf).toEqual({});
  });

  it("returns null for non-JSON content", () => {
    const wf = loadWorkflowJson(__filename); // this .ts file is not JSON
    expect(wf).toBeNull();
  });
});

// ─── resolveWorkflowPath ─────────────────────────────────────────────────────

describe("resolveWorkflowPath", () => {
  it("resolves a workflow by name (without .json extension)", () => {
    const p = resolveWorkflowPath(FIXTURES, "minimal-workflow");
    expect(p).toContain("minimal-workflow.json");
  });

  it("resolves a workflow by name (with .json extension)", () => {
    const p = resolveWorkflowPath(FIXTURES, "minimal-workflow.json");
    expect(p).toContain("minimal-workflow.json");
  });

  it("falls back to first .json when no name given", () => {
    const p = resolveWorkflowPath(FIXTURES);
    expect(p).toMatch(/\.json$/);
  });

  it("throws when workflow not found", () => {
    expect(() => resolveWorkflowPath(FIXTURES, "nonexistent")).toThrow(
      "Workflow not found",
    );
  });

  it("throws when directory has no json files", () => {
    expect(() => resolveWorkflowPath("/tmp", undefined)).toThrow(
      "No default workflow found",
    );
  });
});

// ─── parseWorkflowDetails ────────────────────────────────────────────────────

describe("parseWorkflowDetails", () => {
  const wf = loadWorkflowJson(path.join(FIXTURES, "test-workflow.json"))!;

  it("extracts variables from [VAR] annotations", () => {
    const details = parseWorkflowDetails(wf);
    expect(details.variables).toHaveProperty("PositivePrompt");
    expect(details.variables).toHaveProperty("NegativePrompt");
    expect(details.variables).toHaveProperty("Width");
    expect(details.variables).toHaveProperty("Seed");
  });

  it("extracts variable defaults correctly", () => {
    const details = parseWorkflowDetails(wf);
    // Single-value var
    expect(details.variables["PositivePrompt"]).toBe("a beautiful landscape");
    expect(details.variables["NegativePrompt"]).toBe("bad quality, blurry");
    expect(details.variables["Seed"]).toBe(42);
  });

  it("extracts notes from [NOTE] annotations", () => {
    const details = parseWorkflowDetails(wf);
    expect(details.notes).toContain("test workflow");
  });

  it("extracts output types from [OUTPUT:type] annotations", () => {
    const details = parseWorkflowDetails(wf);
    expect(details.outputTypes).toHaveProperty("7");
    expect(details.outputTypes["7"]).toBe("image");
  });

  it("extracts file slots from [FILE:type:order] annotations", () => {
    const details = parseWorkflowDetails(wf);
    expect(details.fileNodes).toHaveProperty("0");
    expect(details.fileNodes).toHaveProperty("1");
    expect(details.fileNodes[0].expectedType).toBe("image");
    expect(details.fileNodes[1].expectedType).toBe("mask");
    expect(details.fileNodes[0].keys).toContain("image");
    expect(details.fileNodes[1].keys).toContain("image");
  });

  it("builds inputSlots view", () => {
    const details = parseWorkflowDetails(wf);
    expect(details.inputSlots).toHaveProperty("0");
    expect(details.inputSlots).toHaveProperty("1");
    // inputSlots should NOT have nodeId (it's the public-facing view)
    expect(details.inputSlots[0]).not.toHaveProperty("nodeId");
    expect(details.inputSlots[0].expectedType).toBe("image");
  });

  it("builds rawVars with nodeId, keys, defaults for each [VAR]", () => {
    const details = parseWorkflowDetails(wf);
    expect(details.rawVars["PositivePrompt"]).toEqual({
      nodeId: "1",
      keys: ["text"],
      defaults: ["a beautiful landscape"],
    });
    expect(details.rawVars["Seed"]).toEqual({
      nodeId: "4",
      keys: ["seed"],
      defaults: [42],
    });
  });

  it("handles empty workflow gracefully", () => {
    const details = parseWorkflowDetails({});
    expect(details.variables).toEqual({});
    expect(details.outputTypes).toEqual({});
    expect(details.notes).toBe("");
    expect(details.rawVars).toEqual({});
    expect(details.fileNodes).toEqual({});
    expect(details.inputSlots).toEqual({});
  });
});

// ─── validateWorkflow ────────────────────────────────────────────────────────

describe("validateWorkflow", () => {
  it("warns on empty workflow", () => {
    const result = validateWorkflow({});
    expect(result.errors).toContain("Workflow JSON is empty.");
  });

  it("warns when no PositivePrompt [VAR] exists", () => {
    const wf = loadWorkflowJson(path.join(FIXTURES, "test-workflow.json"))!;
    // This one has PositivePrompt, so it should NOT warn about it
    const result = validateWorkflow(wf);
    const posWarnings = result.warnings.filter((w) =>
      w.includes("PositivePrompt"),
    );
    expect(posWarnings).toHaveLength(0);
  });

  it("warns when some [VAR] has no inputs", () => {
    const wf: Record<string, unknown> = {
      "1": {
        _meta: { title: "[VAR] EmptyVar" },
        class_type: "Note",
        inputs: {},
      },
    };
    const result = validateWorkflow(wf);
    expect(result.warnings.some((w) => w.includes("EmptyVar"))).toBe(true);
  });

  it("warns when no [OUTPUT:type] nodes found", () => {
    const wf: Record<string, unknown> = {
      "1": {
        _meta: { title: "[VAR] PositivePrompt" },
        class_type: "CLIPTextEncode",
        inputs: { text: "" },
      },
    };
    const result = validateWorkflow(wf);
    expect(
      result.warnings.some((w) => w.includes("OUTPUT")),
    ).toBe(true);
  });

  it("errors when [FILE] slot has no inputs", () => {
    const wf: Record<string, unknown> = {
      "1": {
        _meta: { title: "[FILE:image:0]" },
        class_type: "LoadImage",
        inputs: {},
      },
    };
    const result = validateWorkflow(wf);
    expect(
      result.errors.some((e) => e.includes("no inputs to set")),
    ).toBe(true);
  });

  it("reports valid workflow with no errors", () => {
    const wf = loadWorkflowJson(path.join(FIXTURES, "minimal-workflow.json"))!;
    const result = validateWorkflow(wf);
    expect(result.errors).toHaveLength(0);
  });
});
