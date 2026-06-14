/**
 * Workflow JSON loading, parsing, validation, and path resolution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseLoraSlots } from "./lora.js";
import type { ParsedWorkflow, WorkflowValidationResult, WorkflowVariables } from "./types.js";

// ─── Loading ─────────────────────────────────────────────────────────────────

/** True for runnable workflow JSON files. Excludes sidecars like *.loras.json. */
export function isWorkflowJsonFile(file: string): boolean {
  return file.endsWith(".json") && !file.endsWith(".loras.json");
}

/** Load and parse a workflow JSON file. Returns null on failure. */
export function loadWorkflowJson(workflowPath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(workflowPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a workflow file path from a workflow directory and optional name.
 * When no name is given, the first .json file in the directory is used.
 * Throws if no matching workflow is found.
 */
export function resolveWorkflowPath(workflowDir: string, workflowName?: string): string {
  if (!workflowName) {
    if (fs.existsSync(workflowDir)) {
      const files = fs.readdirSync(workflowDir).filter(isWorkflowJsonFile);
      if (files.length > 0) return path.join(workflowDir, files[0]);
    }
    throw new Error("No default workflow found and no workflow specified.");
  }

  const name = workflowName.endsWith(".json") ? workflowName : `${workflowName}.json`;
  const direct = path.join(workflowDir, name);
  if (fs.existsSync(direct)) return direct;
  // Try as absolute path
  if (fs.existsSync(name)) return name;
  throw new Error(`Workflow not found: ${name} (looked in ${workflowDir})`);
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a workflow JSON object to extract pi-comfyui-paint annotations:
 * [VAR], [NOTE], [OUTPUT:type], and [FILE:type:order].
 */
export function parseWorkflowDetails(wf: Record<string, unknown>): ParsedWorkflow {
  const rawVars: WorkflowVariables = {};
  const outputTypes: Record<string, string> = {};
  const fileNodes: Record<number, { nodeId: string; keys: string[]; expectedType: string }> = {};
  const notesParts: string[] = [];
  const loraSlots = parseLoraSlots(wf);

  for (const [nodeId, node] of Object.entries(wf)) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const meta = (n._meta as Record<string, unknown>) ?? {};
    const title = (meta.title as string) ?? "";

    if (title.startsWith("[VAR]")) {
      const varName = title.replace("[VAR]", "").trim();
      const inputs = (n.inputs as Record<string, unknown>) ?? {};
      const keys = Object.keys(inputs);
      const defaults = Object.values(inputs);
      rawVars[varName] = { nodeId, keys, defaults };
    } else if (title.startsWith("[NOTE]")) {
      const inputs = (n.inputs as Record<string, unknown>) ?? {};
      const noteText = ((inputs.value ?? inputs.text ?? "") as string).trim();
      if (noteText) notesParts.push(noteText);
    } else {
      const outMatch = title.match(/^\[OUTPUT:([^\]]+)\]/i);
      const fileMatch = title.match(/^\[FILE:([^:]+):(\d+)\]/i);
      if (outMatch) {
        outputTypes[nodeId] = outMatch[1].trim().toLowerCase() || "any";
      } else if (fileMatch) {
        const expectedType = fileMatch[1].trim().toLowerCase();
        const order = parseInt(fileMatch[2], 10);
        const inputs = (n.inputs as Record<string, unknown>) ?? {};
        fileNodes[order] = {
          nodeId,
          keys: Object.keys(inputs),
          expectedType,
        };
      }
    }
  }

  // Build simplified variables view (defaults only)
  const variables: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(rawVars)) {
    variables[name] = v.defaults.length === 1 ? v.defaults[0] : v.defaults;
  }

  // Build inputSlots view (same as fileNodes but without nodeId)
  const inputSlots: Record<number, { keys: string[]; expectedType: string }> = {};
  for (const [order, info] of Object.entries(fileNodes)) {
    inputSlots[parseInt(order)] = { keys: info.keys, expectedType: info.expectedType };
  }

  return {
    notes: notesParts.join("\n\n"),
    variables,
    outputTypes,
    inputSlots,
    fileNodes,
    loraSlots,
    rawVars,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Validate a workflow JSON structure and its pi-comfyui-paint annotations. */
export function validateWorkflow(wf: Record<string, unknown>): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const details = parseWorkflowDetails(wf);

  if (Object.keys(wf).length === 0) {
    errors.push("Workflow JSON is empty.");
  }

  const nodeEntries = Object.entries(wf).filter(([, node]) => node && typeof node === "object");
  const classlessNodes = nodeEntries
    .filter(([, node]) => !("class_type" in (node as Record<string, unknown>)))
    .map(([nodeId]) => nodeId);
  if (classlessNodes.length > 0) {
    warnings.push(
      `Node(s) without class_type: ${classlessNodes.slice(0, 10).join(", ")}${classlessNodes.length > 10 ? "..." : ""}`,
    );
  }

  const rawVars = details.rawVars ?? {};
  if (!rawVars.PositivePrompt) {
    warnings.push(
      "No [VAR] PositivePrompt node found; paint.prompt will not be injected automatically.",
    );
  }
  for (const [name, info] of Object.entries(rawVars)) {
    if (info.keys.length === 0) {
      warnings.push(`[VAR] ${name} has no inputs to set.`);
    }
  }

  if (Object.keys(details.outputTypes).length === 0) {
    warnings.push(
      "No [OUTPUT:type] nodes found; paint will fall back to scanning all ComfyUI outputs.",
    );
  }

  const fileOrders = Object.keys(details.fileNodes)
    .map(Number)
    .sort((a, b) => a - b);
  for (const order of fileOrders) {
    const slot = details.fileNodes[order];
    if (!slot.keys.length) {
      errors.push(`[FILE:${slot.expectedType}:${order}] has no inputs to set.`);
    }
  }

  return { errors, warnings };
}
