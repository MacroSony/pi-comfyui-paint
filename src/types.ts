/**
 * Shared types for pi-comfyui-paint.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

export interface PaintConfig {
  serverAddress: string;
  workflowDir: string;
  projectWorkflowDir: string;
  bundledWorkflowDir: string;
  outputDir: string;
  outputDirIsDefault: boolean;
  outputRetentionHours: number;
  clientId: string;
  interruptOnAbort: boolean;
  /** Maximum number of generated images included as inline model previews. */
  inlineImageLimit: number;
  /** Initial JPEG quality, 1-100, for inline model previews. */
  imageQuality: number;
  /** Maximum pixels on the longest side for inline model previews. */
  imageMaxDimension: number;
  /** Maximum base64-encoded bytes for one inline image preview. */
  imageMaxBytes: number;
  /** Maximum base64-encoded bytes across all inline previews in one result. */
  imageTotalMaxBytes: number;
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
  inputSlots: Record<number, { keys: string[]; expectedType: string; optional?: boolean }>;
  fileNodes: Record<number, { nodeId: string; keys: string[]; expectedType: string; optional?: boolean }>;
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

export interface ComfyUIHistoryStatus {
  status_str?: string;
  completed?: boolean;
  messages?: unknown[];
}

export interface ComfyUIHistoryOutput {
  [promptId: string]: {
    status?: ComfyUIHistoryStatus;
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
}

export interface InlineImagePreview {
  path: string;
  mimeType: string;
  data: string;
  encodedBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
}

export interface UploadedInput {
  slot: number;
  path: string;
  uploaded: ComfyUIUploadResult;
  key: string;
}
