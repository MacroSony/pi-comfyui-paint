/**
 * Shared types for pi-comfyui-paint.
 */

/** Callback for streaming progress updates during tool execution. */
export type OnUpdate = (update: {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
}) => void;

// ─── Configuration ───────────────────────────────────────────────────────────

export interface PaintConfig {
  serverAddress: string;
  workflowDir: string;
  projectWorkflowDir: string;
  bundledWorkflowDir: string;
  clientId: string;
  interruptOnAbort: boolean;
  /** JPEG quality 1-100 for images sent to the LLM. 0 = no compression (raw PNG). */
  imageQuality: number;
  /** Max pixels on the longest side when resizing images for the LLM. 0 = no resize. */
  imageMaxDimension: number;
}

// ─── Workflow ────────────────────────────────────────────────────────────────

export interface WorkflowVariables {
  [name: string]: { nodeId: string; keys: string[]; defaults: unknown[] };
}

/** Internal parsed workflow details (includes raw data used at generation time). */
export interface LoraSlotItem {
  key: string;
  enabled: boolean;
  file: string;
  strength?: number;
}

export interface LoraSlot {
  slot: string;
  nodeId: string;
  classType: string;
  title: string;
  annotated: boolean;
  loaderType: "power" | "unknown";
  items: LoraSlotItem[];
}

export interface LoraMetadata {
  file: string;
  displayName?: string;
  activationPrompt?: string;
  defaultStrength?: number;
  description?: string;
}

export interface LoraOverrideItem {
  file: string;
  strength?: number;
  on?: boolean;
}

export interface LoraOverride {
  slot: string;
  items: LoraOverrideItem[];
}

export interface ParsedWorkflow {
  notes: string;
  variables: Record<string, unknown>;
  outputTypes: Record<string, string>;
  inputSlots: Record<number, { keys: string[]; expectedType: string }>;
  fileNodes: Record<number, { nodeId: string; keys: string[]; expectedType: string }>;
  loraSlots: LoraSlot[];
  rawVars: WorkflowVariables;
}

export interface WorkflowValidationResult {
  errors: string[];
  warnings: string[];
}

// ─── ComfyUI HTTP ────────────────────────────────────────────────────────────

export interface ComfyUIQueueResult {
  prompt_id: string;
}

export interface ComfyUIOutputItem {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyUIHistoryOutput {
  [promptId: string]: {
    outputs: Record<string, Record<string, ComfyUIOutputItem[]>>;
  };
}

export interface ComfyUIUploadResult {
  name: string;
  subfolder?: string;
  type?: string;
}

export interface DownloadedOutput {
  data: Buffer;
  filename: string;
  ext: string;
  mimeType: string;
}

// ─── Generation ──────────────────────────────────────────────────────────────

export interface GenerationResult {
  path: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface UploadedInput {
  slot: number;
  path: string;
  uploaded: ComfyUIUploadResult;
  key: string;
}
