/**
 * LoRA workflow helpers.
 *
 * v1 scope:
 * - rgthree Power Lora Loader nodes
 * - [LORA:slot] workflow annotations
 * - minimal sidecar metadata
 * - simple paint.loras slot map
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { comfyFetch } from "./comfyui-client.js";
import type { LoraMetadata, LoraOverride, LoraSlot, LoraSlotItem } from "./types.js";

const LORA_TITLE_RE = /^\[LORA:([^\]]+)\]/i;

export function isPowerLoraLoaderNode(node: Record<string, unknown>): boolean {
  const classType = String(node.class_type ?? "").toLowerCase();
  const title = String(((node._meta as Record<string, unknown> | undefined)?.title ?? "")).toLowerCase();
  return classType.includes("power lora loader") || title.includes("power lora loader");
}

function parseLoraAnnotation(title: string): string | null {
  const match = title.match(LORA_TITLE_RE);
  return match ? match[1].trim() : null;
}

function loraInputEntries(inputs: Record<string, unknown>): LoraSlotItem[] {
  return Object.entries(inputs)
    .filter(([key, value]) => /^lora_\d+$/i.test(key) && value && typeof value === "object")
    .sort(([a], [b]) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")))
    .map(([key, value]) => {
      const item = value as Record<string, unknown>;
      return {
        key,
        enabled: Boolean(item.on),
        file: typeof item.lora === "string" ? item.lora : "",
        strength: typeof item.strength === "number" ? item.strength : undefined,
      };
    });
}

/** Parse LoRA loader nodes from workflow JSON. */
export function parseLoraSlots(wf: Record<string, unknown>): LoraSlot[] {
  const slots: LoraSlot[] = [];

  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const meta = (n._meta as Record<string, unknown>) ?? {};
    const title = String(meta.title ?? "");
    const annotatedSlot = parseLoraAnnotation(title);
    const isPower = isPowerLoraLoaderNode(n);

    if (!annotatedSlot && !isPower) continue;

    const inputs = (n.inputs as Record<string, unknown>) ?? {};
    slots.push({
      slot: annotatedSlot ?? `node_${nodeId}`,
      nodeId,
      classType: String(n.class_type ?? ""),
      title,
      annotated: Boolean(annotatedSlot),
      loaderType: isPower ? "power" : "unknown",
      items: loraInputEntries(inputs),
    });
  }

  return slots;
}

function sidecarPathForWorkflow(workflowPath: string): string {
  const ext = path.extname(workflowPath);
  return `${workflowPath.slice(0, -ext.length)}.loras.json`;
}

function normalizeMetadata(raw: unknown): LoraMetadata[] {
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown> | null)?.loras)
      ? ((raw as Record<string, unknown>).loras as unknown[])
      : [];

  return entries
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => typeof entry.file === "string" && entry.file.length > 0)
    .map((entry) => ({
      file: entry.file as string,
      displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
      activationPrompt: typeof entry.activationPrompt === "string" ? entry.activationPrompt : undefined,
      defaultStrength: typeof entry.defaultStrength === "number" ? entry.defaultStrength : undefined,
      description: typeof entry.description === "string" ? entry.description : undefined,
    }));
}

/** Load sidecar metadata: WorkflowName.loras.json next to workflow. */
export function loadLoraMetadata(workflowPath: string): LoraMetadata[] {
  const sidecar = sidecarPathForWorkflow(workflowPath);
  if (!fs.existsSync(sidecar)) return [];
  try {
    return normalizeMetadata(JSON.parse(fs.readFileSync(sidecar, "utf-8")));
  } catch {
    return [];
  }
}

export function metadataByFile(metadata: LoraMetadata[]): Record<string, LoraMetadata> {
  return Object.fromEntries(metadata.map((entry) => [entry.file, entry]));
}

/** Query ComfyUI object_info for installed LoRA names. */
export async function getInstalledLoras(serverAddress: string): Promise<string[]> {
  const info = (await comfyFetch(serverAddress, "/object_info")) as Record<
    string,
    { input?: { required?: Record<string, [Array<unknown>, Record<string, unknown>?]> } }
  >;

  const names: string[] = [];
  for (const [nodeClass, key] of [
    ["LoraLoader", "lora_name"],
    ["LoraLoaderModelOnly", "lora_name"],
  ] as const) {
    const param = info[nodeClass]?.input?.required?.[key];
    if (param && Array.isArray(param) && Array.isArray(param[0])) {
      names.push(...param[0].filter((value): value is string => typeof value === "string"));
    }
  }
  return [...new Set(names)].sort();
}

export function buildUsableLoras(installed: string[] | undefined, metadata: LoraMetadata[]): LoraMetadata[] {
  // Workflow details should only advertise LoRAs intentionally documented for that workflow.
  // If ComfyUI is reachable, filter sidecar metadata to installed files; if not, show metadata as-is.
  if (!installed) return metadata;
  const installedSet = new Set(installed);
  return metadata.filter((entry) => installedSet.has(entry.file));
}

export function formatLoraDetailsText(slots: LoraSlot[], usable: LoraMetadata[], installedCount?: number): string {
  if (slots.length === 0 && usable.length === 0) return "";

  const lines: string[] = ["\n**LoRA support:**"];
  if (slots.length > 0) {
    lines.push("\n**Workflow LoRA slots:**");
    for (const slot of slots) {
      const annotation = slot.annotated ? "" : " (auto-detected; consider adding [LORA:slot])";
      lines.push(`- **${slot.slot}** - node ${slot.nodeId}, ${slot.loaderType}${annotation}`);
      for (const item of slot.items) {
        lines.push(`  - ${item.key}: ${item.enabled ? "on" : "off"}, ${item.file || "(empty)"}, strength=${item.strength ?? "default"}`);
      }
    }
  }

  if (installedCount != null) {
    lines.push(`\nInstalled ComfyUI LoRAs detected: ${installedCount}`);
  }

  if (usable.length > 0) {
    lines.push("\n**Usable LoRA metadata:**");
    for (const lora of usable.slice(0, 30)) {
      const parts = [lora.file];
      if (lora.activationPrompt) parts.push(`activation: ${lora.activationPrompt}`);
      if (lora.defaultStrength != null) parts.push(`strength: ${lora.defaultStrength}`);
      lines.push(`- **${lora.displayName ?? lora.file}** (${parts.join("; ")})`);
      if (lora.description) lines.push(`  - ${lora.description}`);
    }
    if (usable.length > 30) lines.push(`- ...and ${usable.length - 30} more LoRAs`);
  }

  return lines.join("\n");
}

/**
 * Normalize paint.loras to internal overrides.
 * Preferred shape:
 *   { "base_style": { file, strength }, "detail": [{ file, strength }, ...] }
 * Legacy array shape is still accepted for compatibility with early local builds.
 */
export function normalizeLoraOverrides(value: unknown): LoraOverride[] {
  if (!value || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => normalizeOverrideEntry(String(entry.slot ?? ""), Array.isArray(entry.items) ? entry.items : [entry]))
      .filter((entry): entry is LoraOverride => Boolean(entry));
  }

  return Object.entries(value as Record<string, unknown>)
    .map(([slot, raw]) => normalizeOverrideEntry(slot, Array.isArray(raw) ? raw : [raw]))
    .filter((entry): entry is LoraOverride => Boolean(entry));
}

function normalizeOverrideEntry(slot: string, rawItems: unknown[]): LoraOverride | null {
  const items = rawItems
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.file === "string" && item.file.length > 0)
    .map((item) => ({
      file: item.file as string,
      strength: typeof item.strength === "number" ? item.strength : undefined,
      on: typeof item.on === "boolean" ? item.on : undefined,
    }));

  return slot && items.length > 0 ? { slot, items } : null;
}

export function validateLoraOverridesInstalled(overrides: LoraOverride[], installed: string[]): void {
  const installedSet = new Set(installed);
  const requested = overrides.flatMap((override) => override.items.map((item) => item.file));
  const missing = [...new Set(requested.filter((file) => !installedSet.has(file)))];
  if (missing.length === 0) return;

  const suggestions = missing.flatMap((file) => {
    const basename = path.basename(file).toLowerCase().replace(/\.safetensors$/, "");
    return installed
      .filter((candidate) => candidate.toLowerCase().includes(basename) || basename.includes(path.basename(candidate).toLowerCase().replace(/\.safetensors$/, "")))
      .slice(0, 5);
  });

  throw new Error(
    [
      `LoRA file(s) not installed on ComfyUI: ${missing.join(", ")}`,
      suggestions.length > 0 ? `Available similar LoRAs: ${[...new Set(suggestions)].join(", ")}` : undefined,
      "Call paint_get_models or paint_get_details to inspect installed LoRA filenames.",
    ].filter(Boolean).join("\n"),
  );
}

export function applyPowerLoraOverrides(
  workflow: Record<string, unknown>,
  slots: LoraSlot[],
  overrides: LoraOverride[],
  metadata: LoraMetadata[],
): { applied: unknown[] } {
  const bySlot = Object.fromEntries(slots.map((slot) => [slot.slot, slot]));
  const meta = metadataByFile(metadata);
  const applied: unknown[] = [];

  for (const override of overrides) {
    const slot = bySlot[override.slot];
    if (!slot) throw new Error(`LoRA slot not found: ${override.slot}`);
    if (slot.loaderType !== "power") throw new Error(`LoRA slot ${override.slot} is not a Power Lora Loader slot.`);

    const node = workflow[slot.nodeId] as Record<string, unknown> | undefined;
    if (!node || typeof node !== "object") throw new Error(`LoRA node not found: ${slot.nodeId}`);
    const inputs = (node.inputs ?? {}) as Record<string, unknown>;

    const existingKeys = Object.keys(inputs).filter((key) => /^lora_\d+$/i.test(key));
    for (let i = 0; i < override.items.length; i++) {
      const item = override.items[i];
      const info = meta[item.file];
      const key = `lora_${i + 1}`;
      const strength = item.strength ?? info?.defaultStrength ?? 0.7;
      inputs[key] = { on: item.on ?? true, lora: item.file, strength };
      applied.push({ slot: override.slot, key, file: item.file, strength });
    }

    // Overrides replace the slot contents; disable leftover existing entries.
    for (const key of existingKeys) {
      const index = Number(key.replace(/\D/g, ""));
      if (index > override.items.length && inputs[key] && typeof inputs[key] === "object") {
        (inputs[key] as Record<string, unknown>).on = false;
      }
    }
    node.inputs = inputs;
  }

  return { applied };
}
