/**
 * Tests for the paint tool's argument preparation shim.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import {
  createPaintTool,
  collectFileSlotWarnings,
  assignInputFilesToSlots,
  removeUncoveredOptionalFileSlots,
} from "../src/tools/paint.js";
import {
  ComfyHttpError,
  PollTimeoutError,
  queuePrompt,
  pollHistory,
  downloadOutputsToDirectory,
  uploadInputFile,
} from "../src/comfyui-client.js";
import { reserveBackend } from "../src/backends.js";
import { loadJob } from "../src/job-store.js";
import { listJobs } from "../src/job-store.js";
import type { PaintConfig } from "../src/types.js";

vi.mock("../src/comfyui-client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/comfyui-client.js")>(
    "../src/comfyui-client.js",
  );
  return {
    ...actual,
    queuePrompt: vi.fn(),
    pollHistory: vi.fn(),
    downloadOutputsToDirectory: vi.fn(),
    uploadInputFile: vi.fn(),
  };
});

vi.mock("../src/backends.js", async () => {
  const actual = await vi.importActual<typeof import("../src/backends.js")>("../src/backends.js");
  return {
    ...actual,
    reserveBackend: vi.fn(),
  };
});

const config: PaintConfig = {
  backends: [{ id: "default", url: "http://127.0.0.1:8188" }],
  serverAddress: "http://127.0.0.1:8188",
  workflowDir: "/tmp/wf",
  projectWorkflowDir: "/tmp/proj",
  bundledWorkflowDir: "/tmp/bundled",
  outputDir: "/tmp/pi-comfyui-paint-tests",
  outputDirIsDefault: false,
  outputRetentionHours: 168,
  syncTimeoutMs: 600_000,
  clientId: "test-client",
  interruptOnAbort: false,
  inlineImageLimit: 1,
  imageQuality: 80,
  imageMaxDimension: 2000,
  imageMaxBytes: Math.floor(4.5 * 1024 * 1024),
  imageTotalMaxBytes: 8 * 1024 * 1024,
  jobIdStyle: "timestamp",
  reconcileIntervalMs: 30_000,
  configFiles: [],
  projectConfigPath: "/tmp/project-comfyui-paint.json",
  globalConfigPath: "/tmp/global-comfyui-paint.json",
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
    expect(collectFileSlotWarnings({}, [], [])).toBeUndefined();
  });

  it("returns undefined when all slots are covered", () => {
    const wf = { "10": { inputs: { image: "a.jpg" } }, "20": { inputs: { image: "b.jpg" } } };
    expect(
      collectFileSlotWarnings(wf, [{ order: 1, path: "a.png" }, { order: 2, path: "b.png" }], slots),
    ).toBeUndefined();
  });

  it("warns when no input files are provided and names the default image", () => {
    const wf = { "10": { inputs: { image: "default_reze.jpg" } } };
    const warning = collectFileSlotWarnings(wf, [], [slots[0]]);
    expect(warning).toContain("1 [FILE] input slot(s) but only 0 of 1 input file(s) provided");
    expect(warning).toContain("slot 1 → default_reze.jpg");
  });

  it("warns about uncovered slots when only some files are provided", () => {
    const wf = { "10": { inputs: { image: "a.jpg" } }, "20": { inputs: { image: "b.jpg" } } };
    const warning = collectFileSlotWarnings(wf, [{ order: 1, path: "a.png" }], slots);
    expect(warning).toContain("slot(s) 2");
    expect(warning).toContain("slot 2 → b.jpg");
  });

  it("reports non-string defaults as present", () => {
    const wf = { "10": { inputs: { image: { filename: "x.png", subfolder: "", type: "input" } } } };
    const warning = collectFileSlotWarnings(wf, [], [slots[0]]);
    expect(warning).toContain("slot 1 → (default present, non-string)");
  });

  it("reports missing defaults explicitly", () => {
    const wf = { "10": { inputs: {} } };
    const warning = collectFileSlotWarnings(wf, [], [slots[0]]);
    expect(warning).toContain("slot 1 → (no default)");
  });

  it("ignores the LoadImage upload widget key when scanning defaults", () => {
    const wf = { "10": { inputs: { image: "", upload: "image" } } };
    const warning = collectFileSlotWarnings(wf, [], [slots[0]]);
    expect(warning).toContain("slot 1 → (no default)");
    expect(warning).not.toContain("→ image");
  });

  it("does not warn about uncovered optional file slots", () => {
    const optionalSlot = { ...slots[0], optional: true };
    const wf = { "10": { inputs: { image: "placeholder.png" } } };
    expect(collectFileSlotWarnings(wf, [], [optionalSlot])).toBeUndefined();
  });
});

describe("removeUncoveredOptionalFileSlots", () => {
  it("removes uncovered optional nodes and propagates to fully-dependent downstream nodes", () => {
    const wf: Record<string, any> = {
      // uncovered optional slot chain: LoadVideo -> GetVideoComponents -> consumer
      "43": { class_type: "LoadVideo", inputs: { video: "placeholder.mp4" } },
      "49": { class_type: "GetVideoComponents", inputs: { video: ["43", 0] } },
      "20": {
        class_type: "MiniMaxH3ReferenceToVideo",
        inputs: {
          prompt: ["5", 0],
          clip: ["2", 0],
          vae: ["3", 0],
          ref_videos: ["49", 0],
          ref_audios: ["45", 0],
        },
      },
      // covered optional slot: LoadImage stays
      "40": { class_type: "LoadImage", inputs: { image: "ref.png" } },
      // unrelated node with no inputs must survive
      "99": { class_type: "EmptyLatentImage", inputs: {} },
    };
    const fileSlots = [
      { order: 1, nodeId: "40", keys: ["image"], expectedType: "image", optional: true },
      { order: 4, nodeId: "43", keys: ["file"], expectedType: "video", optional: true },
      { order: 5, nodeId: "45", keys: ["audio"], expectedType: "audio", optional: true },
    ];

    removeUncoveredOptionalFileSlots(wf, fileSlots, new Set([1]));

    expect(wf["40"]).toBeDefined(); // covered slot kept
    expect(wf["43"]).toBeUndefined(); // uncovered optional slot removed
    expect(wf["49"]).toBeUndefined(); // fully-dependent downstream removed too
    expect(wf["45"]).toBeUndefined(); // other uncovered optional slot removed
    expect(wf["99"]).toBeDefined(); // unrelated empty-input node untouched
    // consumer keeps its other inputs, only the dead refs are stripped
    expect(wf["20"].inputs.ref_videos).toBeUndefined();
    expect(wf["20"].inputs.ref_audios).toBeUndefined();
    expect(wf["20"].inputs.prompt).toEqual(["5", 0]);
  });

  it("does not remove nodes that still have non-removed inputs", () => {
    const wf: Record<string, any> = {
      "43": { class_type: "LoadVideo", inputs: { video: "placeholder.mp4" } },
      "49": {
        class_type: "GetVideoComponents",
        inputs: { video: ["43", 0], keep: ["88", 0] },
      },
      "88": { class_type: "SomethingElse", inputs: { x: 1 } },
    };
    removeUncoveredOptionalFileSlots(
      wf,
      [{ order: 4, nodeId: "43", keys: ["file"], expectedType: "video", optional: true }],
      new Set(),
    );
    expect(wf["43"]).toBeUndefined();
    expect(wf["49"]).toBeDefined(); // still has input from 88
    expect(wf["49"].inputs.video).toBeUndefined(); // dead link stripped
    expect(wf["49"].inputs.keep).toEqual(["88", 0]);
  });
});

describe("assignInputFilesToSlots", () => {
  // MiniMax H3 style: 9 image slots, then 3 video, then 3 audio.
  const h3Slots = [
    ...Array.from({ length: 9 }, (_, i) => ({
      order: i + 1,
      nodeId: `img${i + 1}`,
      keys: ["image"],
      expectedType: "image",
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      order: 10 + i,
      nodeId: `vid${i + 1}`,
      keys: ["video"],
      expectedType: "video",
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      order: 13 + i,
      nodeId: `aud${i + 1}`,
      keys: ["audio"],
      expectedType: "audio",
    })),
  ];

  it("returns empty assignments for null/undefined input", () => {
    expect(assignInputFilesToSlots(h3Slots, undefined)).toEqual({ assignments: [], errors: [] });
    expect(assignInputFilesToSlots(h3Slots, null)).toEqual({ assignments: [], errors: [] });
  });

  it("routes bare strings by inferred type", () => {
    const result = assignInputFilesToSlots(h3Slots, ["a.png", "b.png", "c.mp4", "d.mp3"]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([1, 2, 10, 13]);
  });

  it("lets typed entries skip earlier slots: one image + one audio", () => {
    const result = assignInputFilesToSlots(h3Slots, [
      { path: "img.png", type: "image" },
      { path: "bgm.mp3", type: "audio" },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([1, 13]);
  });

  it("keeps legacy positional behavior for all-image slots", () => {
    const imageSlots = h3Slots.slice(0, 3);
    const result = assignInputFilesToSlots(imageSlots, ["a.png", "b.png", "c.png"]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([1, 2, 3]);
  });

  it("treats unknown extensions as generic file (first uncovered slot)", () => {
    const result = assignInputFilesToSlots(h3Slots, ["a.bin", "b.bin"]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([1, 2]);
  });

  it("pins an exact slot with slot", () => {
    const result = assignInputFilesToSlots(h3Slots, [
      { path: "img.png", type: "image" },
      { path: "x.png", slot: 9 },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([1, 9]);
  });

  it("accepts a pin whose inferred type matches the slot", () => {
    const result = assignInputFilesToSlots(h3Slots, [{ path: "bgm.mp3", slot: 13 }]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([13]);
  });

  it("errors when a pin's type does not match the slot's expected type", () => {
    const result = assignInputFilesToSlots(h3Slots, [{ path: "bgm.mp3", slot: 1 }]);
    expect(result.assignments).toEqual([]);
    expect(result.errors[0]).toContain('type "audio"');
    expect(result.errors[0]).toContain("slot 1, which expects \"image\"");
    expect(result.errors[0]).toContain('type "file"');
  });

  it("errors on explicit type mismatch at a pinned slot", () => {
    const result = assignInputFilesToSlots(h3Slots, [{ path: "x.png", type: "video", slot: 9 }]);
    expect(result.assignments).toEqual([]);
    expect(result.errors[0]).toContain('type "video"');
    expect(result.errors[0]).toContain("slot 9, which expects \"image\"");
  });

  it("allows type \"file\" to pin any slot", () => {
    const result = assignInputFilesToSlots(h3Slots, [
      { path: "bgm.mp3", type: "file", slot: 1 },
      { path: "x.bin", type: "file", slot: 13 },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([1, 13]);
  });

  it("infers type from extension when the object omits type", () => {
    const result = assignInputFilesToSlots(h3Slots, [{ path: "shot.webm" }, { path: "bgm.wav" }]);
    expect(result.errors).toEqual([]);
    expect(result.assignments.map((a) => a.order)).toEqual([10, 13]);
  });

  it("errors when a type has no uncovered slot left", () => {
    const result = assignInputFilesToSlots(h3Slots, [
      ...Array.from({ length: 9 }, (_, i) => ({ path: `img${i}.png`, type: "image" })),
      { path: "one-too-many.png", type: "image" },
    ]);
    expect(result.assignments).toHaveLength(9);
    expect(result.errors[0]).toContain('type "image"');
    expect(result.errors[0]).toContain("10=video");
  });

  it("errors when an explicit slot is out of range", () => {
    const result = assignInputFilesToSlots(h3Slots, [{ path: "x.png", slot: 16 }]);
    expect(result.assignments).toEqual([]);
    expect(result.errors[0]).toContain("slot 16");
    expect(result.errors[0]).toContain("1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15");
  });

  it("errors when an explicit slot is already covered", () => {
    const result = assignInputFilesToSlots(h3Slots, [
      { path: "a.png", type: "image" },
      { path: "b.png", slot: 1 },
    ]);
    expect(result.assignments.map((a) => a.order)).toEqual([1]);
    expect(result.errors[0]).toContain("slot 1, which is already covered");
  });

  it("errors on invalid entries", () => {
    expect(assignInputFilesToSlots(h3Slots, [42]).errors[0]).toContain("input_files[0]");
    expect(assignInputFilesToSlots(h3Slots, [{ type: "image" }]).errors[0]).toContain("input_files[0]");
    expect(assignInputFilesToSlots(h3Slots, [{ path: "a.png", slot: 1.5 }]).errors[0]).toContain(
      "slot must be a positive integer",
    );
  });

  it("rejects a non-array input_files value", () => {
    expect(assignInputFilesToSlots(h3Slots, "a.png").errors[0]).toContain(
      "input_files must be an array",
    );
  });

  it("errors when input_files are given but the workflow has no slots", () => {
    const result = assignInputFilesToSlots([], ["a.png"]);
    expect(result.errors[0]).toContain("no [FILE:type:order] input slots");
    expect(assignInputFilesToSlots([], [])).toEqual({ assignments: [], errors: [] });
  });
});

describe("createPaintTool generated media content", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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
            inputs: { filename_prefix: "test-output" },
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
      vi.mocked(reserveBackend).mockImplementation(async () => ({
        backend: config.backends[0],
        snapshot: {
          backend: config.backends[0],
          running: 0,
          pending: 0,
          reservations: 0,
          queue: {},
        },
        release: vi.fn(),
      }));
      vi.mocked(downloadOutputsToDirectory).mockImplementation(
        async (_server, _outputs, outputDir) => {
          const imagePath = path.join(outputDir, "paint_0.png");
          const videoPath = path.join(outputDir, "paint_1.mp4");
          fs.writeFileSync(imagePath, validPng);
          fs.writeFileSync(videoPath, Buffer.from("not really an mp4"));
          return [
            { path: imagePath, filename: "paint_0.png", mimeType: "image/png" },
            { path: videoPath, filename: "paint_1.mp4", mimeType: "video/mp4" },
          ];
        },
      );

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
      const firstJobId = result.details.jobId as string;
      expect(firstJobId).toMatch(/^\d{8}-\d{6}Z-[0-9a-f]{6}$/);
      const submittedWorkflow = vi.mocked(queuePrompt).mock.calls[0][1] as Record<string, any>;
      expect(submittedWorkflow["2"].inputs.filename_prefix).toBe(`paint/${firstJobId}/test-output`);
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

      const pollsBeforeBackground = vi.mocked(pollHistory).mock.calls.length;
      const backgroundResult = await tool.execute(
        { prompt: "long video", workflow: "test.json", background: true },
        new AbortController().signal,
      );
      expect(backgroundResult.content[0]).toMatchObject({ type: "text" });
      expect((backgroundResult.content[0] as { text: string }).text).toContain(
        "Queued background paint job",
      );
      expect(vi.mocked(pollHistory).mock.calls).toHaveLength(pollsBeforeBackground);
      const backgroundJobId = backgroundResult.details.jobId as string;
      expect(loadJob(path.join(tmpDir, "outputs"), backgroundJobId)).toMatchObject({
        id: backgroundJobId,
        state: "submitted",
        promptId: "prompt-1",
        backend: config.backends[0],
        outputPrefix: `paint/${backgroundJobId}`,
      });

      vi.mocked(queuePrompt).mockRejectedValueOnce(new Error("connection reset after POST"));
      await expect(tool.execute(
        { prompt: "ambiguous", workflow: "test.json", background: true },
        new AbortController().signal,
      )).rejects.toThrow("Paint error (job");
      expect(listJobs(path.join(tmpDir, "outputs"))[0]).toMatchObject({
        state: "submission_unknown",
        error: "connection reset after POST",
      });

      vi.mocked(queuePrompt).mockRejectedValueOnce(
        new ComfyHttpError("/prompt", 400, "invalid workflow"),
      );
      await expect(tool.execute(
        { prompt: "invalid", workflow: "test.json", background: true },
        new AbortController().signal,
      )).rejects.toThrow("invalid workflow");
      expect(listJobs(path.join(tmpDir, "outputs")).some((job) =>
        job.state === "failed" && job.error?.includes("invalid workflow"),
      )).toBe(true);

      vi.mocked(pollHistory).mockRejectedValueOnce(new PollTimeoutError("prompt-1", 10));
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const value = url.pathname.startsWith("/history/")
          ? {}
          : { queue_running: [], queue_pending: [[0, "prompt-1"]] };
        return new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        });
      }));
      const timedOut = await tool.execute(
        { prompt: "slow", workflow: "test.json" },
        new AbortController().signal,
      );
      expect(timedOut.details).toMatchObject({ state: "queued", promptId: "prompt-1" });
      expect(timedOut.details.jobId).toEqual(expect.any(String));

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

  it("routes typed input_files to non-contiguous slots and disconnects uncovered optional slots", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paint-typed-test-"));
    try {
      const workflowDir = path.join(tmpDir, "workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, "h3.json"),
        JSON.stringify({
          "1": {
            class_type: "CLIPTextEncode",
            inputs: { text: "" },
            _meta: { title: "[VAR] PositivePrompt" },
          },
          "10": {
            class_type: "LoadImage",
            inputs: { image: "default_ref.png" },
            _meta: { title: "[FILE:image:1] First frame" },
          },
          "11": {
            class_type: "LoadAudio",
            inputs: { audio: "default_bgm.mp3" },
            _meta: { title: "[FILE:audio:2] BGM" },
          },
          "12": {
            class_type: "LoadVideo",
            inputs: { video: "placeholder.mp4" },
            _meta: { title: "[FILE:video:3:optional] Optional video" },
          },
          "2": {
            class_type: "SaveImage",
            inputs: { filename_prefix: "test-output" },
            _meta: { title: "[OUTPUT:any] Generated media" },
          },
        }),
      );
      fs.writeFileSync(path.join(tmpDir, "bgm.mp3"), Buffer.from("audio"));
      fs.writeFileSync(path.join(tmpDir, "ref.png"), Buffer.from("image"));

      vi.mocked(queuePrompt).mockResolvedValue("prompt-typed");
      vi.mocked(pollHistory).mockResolvedValue({
        "prompt-typed": {
          status: { status_str: "success", completed: true, messages: [] },
          outputs: {
            "2": { images: [{ filename: "out.png", subfolder: "", type: "output" }] },
          },
        },
      });
      vi.mocked(downloadOutputsToDirectory).mockImplementation(async (_server, _outputs, dir) => {
        const p = path.join(dir, "out.png");
        fs.writeFileSync(p, Buffer.from("x"));
        return [{ path: p, filename: "out.png", mimeType: "image/png" }];
      });
      vi.mocked(uploadInputFile).mockImplementation(async (_server, filePath) => ({
        name: path.basename(filePath),
        subfolder: "",
        type: "input",
      }));

      const tool = createPaintTool(
        { ...config, workflowDir, outputDir: path.join(tmpDir, "outputs") },
        tmpDir,
      );
      const result = await tool.execute(
        {
          prompt: "test",
          workflow: "h3.json",
          input_files: [
            { path: "bgm.mp3", type: "audio" },
            { path: "ref.png", type: "image" },
          ],
        },
        new AbortController().signal,
      );

      const job = loadJob(path.join(tmpDir, "outputs"), result.details.jobId as string);
      expect(job.uploadedInputs.map((input) => input.slot)).toEqual([2, 1]);
      expect(job.sourceInputPaths).toEqual([
        path.join(tmpDir, "bgm.mp3"),
        path.join(tmpDir, "ref.png"),
      ]);
      const submitted = vi.mocked(queuePrompt).mock.calls[0][1] as Record<string, any>;
      expect(submitted["11"].inputs.audio).toBe("bgm.mp3");
      expect(submitted["10"].inputs.image).toBe("ref.png");
      expect(submitted["12"]).toBeUndefined(); // uncovered optional slot removed from graph
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces uncovered-file-slot warnings in the background submission result", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paint-bg-warn-test-"));
    try {
      const workflowDir = path.join(tmpDir, "workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, "bg.json"),
        JSON.stringify({
          "1": {
            class_type: "CLIPTextEncode",
            inputs: { text: "" },
            _meta: { title: "[VAR] PositivePrompt" },
          },
          "10": {
            class_type: "LoadImage",
            inputs: { image: "default_ref.png" },
            _meta: { title: "[FILE:image:1] Reference" },
          },
          "2": {
            class_type: "SaveImage",
            inputs: { filename_prefix: "test-output" },
            _meta: { title: "[OUTPUT:any] Generated media" },
          },
        }),
      );

      vi.mocked(queuePrompt).mockResolvedValue("prompt-bg-warn");
      vi.mocked(uploadInputFile).mockImplementation(async (_server, filePath) => ({
        name: path.basename(filePath),
        subfolder: "",
        type: "input",
      }));

      const tool = createPaintTool(
        { ...config, workflowDir, outputDir: path.join(tmpDir, "outputs") },
        tmpDir,
      );
      const result = await tool.execute(
        { prompt: "test", workflow: "bg.json", background: true },
        new AbortController().signal,
      );

      // The warning is visible immediately, not only after paint_job_status.
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Queued background paint job");
      expect(text).toContain("⚠️");
      expect(text).toContain("will fall back to their default inputs");
      expect(text).toContain("slot 1 → default_ref.png");
      expect(result.details.warnings).toEqual([
        expect.stringContaining("slot 1 → default_ref.png"),
      ]);
      // The persisted job carries the warning too, so paint_job_status keeps showing it.
      const job = loadJob(path.join(tmpDir, "outputs"), result.details.jobId as string);
      expect(job.warnings.join(" ")).toContain("default_ref.png");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes the workflow's [CAPABILITY] tags to backend selection", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paint-caps-test-"));
    try {
      const workflowDir = path.join(tmpDir, "workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, "caps.json"),
        JSON.stringify({
          "1": {
            class_type: "CLIPTextEncode",
            inputs: { text: "" },
            _meta: { title: "[VAR] PositivePrompt" },
          },
          "77": {
            class_type: "PrimitiveStringMultiline",
            inputs: { value: " video, h3 " },
            _meta: { title: "[CAPABILITY]" },
          },
          "2": {
            class_type: "SaveImage",
            inputs: { filename_prefix: "test-output" },
            _meta: { title: "[OUTPUT:any] Generated media" },
          },
        }),
      );

      vi.mocked(queuePrompt).mockResolvedValue("prompt-caps");
      vi.mocked(pollHistory).mockResolvedValue({
        "prompt-caps": {
          status: { status_str: "success", completed: true, messages: [] },
          outputs: {
            "2": { images: [{ filename: "out.png", subfolder: "", type: "output" }] },
          },
        },
      });
      vi.mocked(downloadOutputsToDirectory).mockImplementation(async (_server, _outputs, dir) => {
        const p = path.join(dir, "out.png");
        fs.writeFileSync(p, Buffer.from("x"));
        return [{ path: p, filename: "out.png", mimeType: "image/png" }];
      });

      const tool = createPaintTool(
        { ...config, workflowDir, outputDir: path.join(tmpDir, "outputs") },
        tmpDir,
      );
      await tool.execute(
        { prompt: "test", workflow: "caps.json", background: true },
        new AbortController().signal,
      );

      expect(vi.mocked(reserveBackend).mock.calls[0][1]).toMatchObject({
        requiredCapabilities: ["video", "h3"],
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
