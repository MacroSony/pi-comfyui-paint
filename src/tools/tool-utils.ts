/**
 * Shared types for tool factory functions.
 */

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
  execute: (params?: Record<string, unknown>, signal?: AbortSignal) => Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details: Record<string, unknown>;
  }>;
}
