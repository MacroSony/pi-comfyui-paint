/**
 * Shared types for pi-comfyui-paint.
 */

// ─── Configuration ───────────────────────────────────────────────────────────

export interface PaintConfig {
  /** Configured ComfyUI backends. The first entry is the compatibility default. */
  backends: ComfyBackend[];
  /** Compatibility alias for the first configured backend URL. */
  serverAddress: string;
  workflowDir: string;
  projectWorkflowDir: string;
  bundledWorkflowDir: string;
  outputDir: string;
  outputDirIsDefault: boolean;
  outputRetentionHours: number;
  syncTimeoutMs: number;
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
  /** Durable job ID generator style. Timestamp IDs are short and chronologically sortable. */
  jobIdStyle: PaintJobIdStyle;
  /** Optional local/mounted ComfyUI output directories keyed by backend ID. */
  backendOutputDirs?: Record<string, string>;
  /** Background reconciliation interval in milliseconds; 0 disables the sweeper. */
  reconcileIntervalMs: number;
  /** JSON config files that contributed to this effective config. */
  configFiles: string[];
  projectConfigPath: string;
  globalConfigPath: string;
}

export type PaintJobIdStyle = "timestamp" | "uuid";

export interface ComfyBackend {
  id: string;
  url: string;
  /**
   * Capability tags this backend offers (JSON config only). Absent = accepts
   * every workflow; empty array = accepts none (soft-disable). Selection only
   * narrows: a workflow's required tags must all be present here.
   */
  capabilities?: string[];
}

export interface BackendQueueSnapshot {
  backend: ComfyBackend;
  running: number;
  pending: number;
  reservations: number;
  queue: ComfyUIQueueStatus;
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
  /** Capability tags required by this workflow's [CAPABILITY] marker nodes. */
  capabilities: string[];
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

export interface ComfyUIQueueStatus {
  queue_running?: unknown[];
  queue_pending?: unknown[];
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

export type PaintJobState =
  | "preparing"
  | "submitting"
  | "submitted"
  | "queued"
  | "running"
  | "finalizing"
  | "finalization_failed"
  | "completed"
  | "failed"
  | "submission_unknown"
  | "unknown"
  | "cancelling"
  | "cancelled";

export interface PaintJobRecord {
  version: 1;
  id: string;
  state: PaintJobState;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  backend: ComfyBackend;
  clientId: string;
  promptId?: string;
  workflow: string;
  workflowPath: string;
  workflowHash: string;
  workflowSnapshotPath: string;
  outputDir: string;
  outputNodeIds: string[];
  /** Server-side output prefix rewritten into Save nodes for deterministic recovery. */
  outputPrefix?: string;
  /** ComfyUI output metadata captured before download; survives history loss. */
  outputManifest?: Record<string, Record<string, ComfyUIOutputItem[]>>;
  prompt?: string;
  negativePrompt?: string;
  variables?: Record<string, unknown>;
  loras?: unknown;
  sourceInputPaths: string[];
  uploadedInputs: UploadedInput[];
  appliedLoras: unknown[];
  warnings: string[];
  files: GenerationResult[];
  submittedAt?: string;
  completedAt?: string;
  generationElapsedMs?: number;
  error?: string;
  diagnostic?: string;
}
