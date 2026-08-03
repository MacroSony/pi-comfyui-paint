/**
 * Shared types for tool factory functions.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";

export interface ToolParamDef {
  type: string;
  description: string;
  /**
   * For type: "optional", the JSON type the value should have when present.
   * Defaults to "unknown". Use this to keep the public schema strict for
   * simple params while leaving genuinely polymorphic params (objects,
   * JSON-string values) loose.
   */
  valueType?: "string" | "number" | "boolean" | "array" | "unknown";
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
  execute: (
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}
