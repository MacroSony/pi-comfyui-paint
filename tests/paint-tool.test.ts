/**
 * Tests for the paint tool's argument preparation shim.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { createPaintTool, collectFileSlotWarnings } from "../src/tools/paint.js";
import { queuePrompt, pollHistory, downloadOutput } from "../src/comfyui-client.js";
import type { PaintConfig } from "../src/types.js";

vi.mock("../src/comfyui-client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/comfyui-client.js")>(
    "../src/comfyui-client.js",
  );
  return {
    ...actual,
    queuePrompt: vi.fn(),
    pollHistory: vi.fn(),
    downloadOutput: vi.fn(),
  };
});

const config: PaintConfig = {
  serverAddress: "http://127.0.0.1:8188",
  workflowDir: "/tmp/wf",
  projectWorkflowDir: "/tmp/proj",
  bundledWorkflowDir: "/tmp/bundled",
  outputDir: "/tmp/pi-comfyui-paint-tests",
  outputDirIsDefault: false,
  outputRetentionHours: 168,
  clientId: "test-client",
  interruptOnAbort: false,
  inlineImageLimit: 1,
  imageQuality: 80,
  imageMaxDimension: 2000,
  imageMaxBytes: Math.floor(4.5 * 1024 * 1024),
  imageTotalMaxBytes: 8 * 1024 * 1024,
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

  it("does not warn about uncovered optional file slots", () => {
    const optionalSlot = { ...slots[0], optional: true };
    const wf = { "10": { inputs: { image: "placeholder.png" } } };
    expect(collectFileSlotWarnings(wf, undefined, [optionalSlot])).toBeUndefined();
  });
});

describe("createPaintTool generated media content", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns originals by path, inlines only bounded image previews, and supports path-only mode", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paint-tool-test-"));
    try {
      const workflowDir = path.join(tmpDir, "workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, "test.json"),
        JSON.stringify({
          "1": {
            class_type: "CLIPTextEncode",
            inputs: { text: "" },
            _meta: { title: "[VAR] PositivePrompt" },
          },
          "2": {
            class_type: "SaveImage",
            inputs: {},
            _meta: { title: "[OUTPUT:any] Generated media" },
          },
        }),
      );

      vi.mocked(queuePrompt).mockResolvedValue("prompt-1");
      vi.mocked(pollHistory).mockResolvedValue({
        "prompt-1": {
          status: { status_str: "success", completed: true, messages: [] },
          outputs: {
            "2": {
              images: [
                { filename: "image.png", subfolder: "", type: "output" },
                { filename: "video.mp4", subfolder: "", type: "output" },
              ],
            },
          },
        },
      });
      const validPng = await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: { r: 20, g: 40, b: 60 },
        },
      }).png().toBuffer();
      vi.mocked(downloadOutput).mockResolvedValue([
        {
          data: validPng,
          filename: "image.png",
          ext: "png",
          mimeType: "image/png",
        },
        {
          data: Buffer.from("not really an mp4"),
          filename: "video.mp4",
          ext: "mp4",
          mimeType: "video/mp4",
        },
      ]);

      const tool = createPaintTool({
        ...config,
        workflowDir,
        outputDir: path.join(tmpDir, "outputs"),
      }, tmpDir);
      const result = await tool.execute(
        { prompt: "test", workflow: "test.json" },
        new AbortController().signal,
      );

      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe("text");
      expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);

      const files = result.details.files as Array<{ path: string; mimeType: string }>;
      expect(files).toHaveLength(2);
      expect(files.map((file) => file.mimeType)).toEqual(["image/png", "video/mp4"]);
      for (const file of files) {
        expect(fs.existsSync(file.path)).toBe(true);
      }
      const previews = result.details.inlinePreviews as Array<{ path: string; encodedBytes: number }>;
      expect(previews).toHaveLength(1);
      expect(previews[0].path).toBe(files[0].path);
      expect(previews[0].encodedBytes).toBeGreaterThan(0);

      const pathOnlyTool = createPaintTool({
        ...config,
        workflowDir,
        outputDir: path.join(tmpDir, "outputs"),
        inlineImageLimit: 0,
      }, tmpDir);
      const pathOnlyResult = await pathOnlyTool.execute(
        { prompt: "test", workflow: "test.json" },
        new AbortController().signal,
      );
      expect(pathOnlyResult.content).toHaveLength(1);
      expect(pathOnlyResult.content[0].type).toBe("text");
      expect(pathOnlyResult.details.inlinePreviews).toEqual([]);

      await expect(tool.execute(
        { prompt: "test", workflow: "test.json", variables: "invalid" },
        new AbortController().signal,
      )).rejects.toThrow("variables must be a JSON object");
      await expect(tool.execute(
        { prompt: "test", workflow: "test.json", loras: 42 },
        new AbortController().signal,
      )).rejects.toThrow("loras must be a JSON object");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
