/**
 * Tests for LoRA workflow helpers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPowerLoraOverrides,
  buildUsableLoras,
  loadLoraMetadata,
  normalizeLoraOverrides,
  parseLoraSlots,
  validateLoraOverridesInstalled,
} from "../src/lora.js";
import { loadWorkflowJson } from "../src/workflow.js";

const ROOT = path.resolve(__dirname, "..");
const BASE_ANIMA_WORKFLOW = path.join(ROOT, "workflows", "T2I_Anime_Anima.json");

describe("parseLoraSlots", () => {
  it("detects annotated Power Lora Loader slots", () => {
    const wf = loadWorkflowJson(BASE_ANIMA_WORKFLOW)!;
    const slots = parseLoraSlots(wf);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slot: "base_style",
      annotated: true,
      loaderType: "power",
    });
    expect(slots[0].items[0]).toMatchObject({
      key: "lora_1",
      enabled: false,
      file: "None",
      strength: 0,
    });
  });

  it("auto-detects unannotated Power Lora Loader slots", () => {
    const wf: Record<string, unknown> = {
      "78": {
        class_type: "Power Lora Loader (rgthree)",
        inputs: {
          lora_1: { on: true, lora: "foo.safetensors", strength: 0.5 },
        },
        _meta: { title: "Power Lora Loader (rgthree)" },
      },
    };
    const slots = parseLoraSlots(wf);
    expect(slots[0]).toMatchObject({
      slot: "node_78",
      annotated: false,
    });
  });
});

describe("loadLoraMetadata", () => {
  it("loads workflow sidecar metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-comfyui-paint-lora-"));
    const workflowPath = path.join(dir, "Fixture.json");
    const sidecarPath = path.join(dir, "Fixture.loras.json");
    fs.writeFileSync(workflowPath, "{}", "utf-8");
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({
        version: 1,
        workflow: "Fixture.json",
        loras: [
          {
            file: "anima/[Style]saio_ga_ushi_v1.safetensors",
            activationPrompt: "@zkz",
            defaultStrength: 0.7,
            description: "Artist/style LoRA for Anima.",
          },
          {
            file: "anima/jk348/natsue_v2.safetensors",
            activationPrompt: "@jk348",
            defaultStrength: 0.8,
          },
        ],
      }),
      "utf-8",
    );

    try {
      const metadata = loadLoraMetadata(workflowPath);
      expect(metadata).toHaveLength(2);
      expect(metadata[0]).toMatchObject({
        file: "anima/[Style]saio_ga_ushi_v1.safetensors",
        activationPrompt: "@zkz",
        defaultStrength: 0.7,
        description: "Artist/style LoRA for Anima.",
      });
      expect(metadata).toContainEqual(expect.objectContaining({
        file: "anima/jk348/natsue_v2.safetensors",
        activationPrompt: "@jk348",
        defaultStrength: 0.8,
      }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildUsableLoras", () => {
  it("only returns sidecar metadata entries that are installed", () => {
    const metadata = [
      { file: "a.safetensors", displayName: "A" },
      { file: "b.safetensors", displayName: "B" },
    ];
    expect(buildUsableLoras(["a.safetensors", "unrelated.safetensors"], metadata)).toEqual([
      { file: "a.safetensors", displayName: "A" },
    ]);
  });

  it("returns metadata as-is if installed LoRAs cannot be queried", () => {
    const metadata = [{ file: "a.safetensors", displayName: "A" }];
    expect(buildUsableLoras(undefined, metadata)).toEqual(metadata);
  });
});

describe("normalizeLoraOverrides", () => {
  it("supports preferred slot map shape", () => {
    const overrides = normalizeLoraOverrides({
      base: { file: "a.safetensors", strength: 0.7 },
      detail: [{ file: "b.safetensors", strength: 0.3 }, { file: "c.safetensors" }],
    });
    expect(overrides).toEqual([
      { slot: "base", items: [{ file: "a.safetensors", strength: 0.7, on: undefined }] },
      { slot: "detail", items: [
        { file: "b.safetensors", strength: 0.3, on: undefined },
        { file: "c.safetensors", strength: undefined, on: undefined },
      ] },
    ]);
  });

  it("still accepts legacy array shape", () => {
    const overrides = normalizeLoraOverrides([
      { slot: "base", items: [{ file: "a.safetensors", strength: 0.7 }] },
      { slot: "detail", file: "b.safetensors", strength: 0.3 },
    ]);
    expect(overrides).toEqual([
      { slot: "base", items: [{ file: "a.safetensors", strength: 0.7, on: undefined }] },
      { slot: "detail", items: [{ file: "b.safetensors", strength: 0.3, on: undefined }] },
    ]);
  });
});

describe("validateLoraOverridesInstalled", () => {
  it("throws a clear error for missing LoRA files", () => {
    expect(() => validateLoraOverridesInstalled(
      [{ slot: "base", items: [{ file: "missing.safetensors" }] }],
      ["anima/installed.safetensors"],
    )).toThrow("LoRA file(s) not installed on ComfyUI: missing.safetensors");
  });
});

describe("applyPowerLoraOverrides", () => {
  it("replaces PowerLora slot contents", () => {
    const wf: Record<string, unknown> = {
      "78": {
        class_type: "Power Lora Loader (rgthree)",
        inputs: {
          lora_1: { on: true, lora: "old.safetensors", strength: 0.5 },
          lora_2: { on: true, lora: "leftover.safetensors", strength: 0.4 },
        },
        _meta: { title: "[LORA:base_style] Power Lora Loader (rgthree)" },
      },
    };
    const slots = parseLoraSlots(wf);
    const result = applyPowerLoraOverrides(
      wf,
      slots,
      [{ slot: "base_style", items: [{ file: "new.safetensors" }] }],
      [{ file: "new.safetensors", defaultStrength: 0.8 }],
    );

    const inputs = ((wf["78"] as Record<string, unknown>).inputs as Record<string, unknown>);
    expect(inputs.lora_1).toEqual({ on: true, lora: "new.safetensors", strength: 0.8 });
    expect(inputs.lora_2).toMatchObject({ on: false });
    expect(result.applied).toEqual([{ slot: "base_style", key: "lora_1", file: "new.safetensors", strength: 0.8 }]);
  });
});
