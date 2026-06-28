/**
 * Shared types for tool factory functions.
 */

import type { OnUpdate } from "../types.js";

export interface ToolParamDef {
  type: string;
  description: string;
}

export interface ToolParams {
  [key: string]: ToolParamDef;
}

export interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: ToolParams;
  /** Optional compatibility shim to prepare raw tool call arguments before schema validation. Some models send object/array params as JSON strings; use this to parse them back into objects. Must return an object conforming to parameters. */
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (params?: Record<string, unknown>, signal?: AbortSignal, onUpdate?: OnUpdate) => Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details: Record<string, unknown>;
  }>;
}
