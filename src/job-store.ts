/** Durable, private job records for background and recoverable generations. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createJobOutputDir } from "./output-storage.js";
import type {
  ComfyBackend,
  PaintConfig,
  PaintJobRecord,
  PaintJobState,
  UploadedInput,
} from "./types.js";

const JOB_RECORD = "job.json";
const WORKFLOW_SNAPSHOT = "workflow.json";
const JOB_DIR_PATTERN = /^job-([A-Za-z0-9-]+)$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const TERMINAL_STATES = new Set<PaintJobState>(["completed", "failed", "cancelled"]);

export interface CreateJobInput {
  id?: string;
  backend: ComfyBackend;
  clientId: string;
  workflow: string;
  workflowPath: string;
  promptWorkflow: Record<string, unknown>;
  outputNodeIds: string[];
  outputPrefix?: string;
  prompt?: string;
  negativePrompt?: string;
  variables?: Record<string, unknown>;
  loras?: unknown;
  sourceInputPaths: string[];
  warnings: string[];
  uploadedInputs?: UploadedInput[];
  appliedLoras?: unknown[];
}

export function isTerminalJobState(state: PaintJobState): boolean {
  return TERMINAL_STATES.has(state);
}

function recordPath(jobDir: string): string {
  return path.join(jobDir, JOB_RECORD);
}

function hasValidStoragePaths(job: PaintJobRecord, jobDir: string): boolean {
  const directoryMatch = JOB_DIR_PATTERN.exec(path.basename(jobDir));
  return (
    directoryMatch?.[1] === job.id &&
    path.resolve(job.workflowSnapshotPath) === path.resolve(jobDir, WORKFLOW_SNAPSHOT) &&
    path.resolve(job.outputDir) === path.resolve(jobDir, "outputs")
  );
}

function writePrivateJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function hashWorkflow(workflow: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

/** Generate a short agent-friendly job ID. Timestamp IDs are UTC and sortable. */
export function generatePaintJobId(
  style: "timestamp" | "uuid" = "timestamp",
  now = new Date(),
): string {
  if (style === "uuid") return crypto.randomUUID();
  const timestamp = now.toISOString().replace(/^(-?\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\..*$/, "$1$2$3-$4$5$6Z");
  return `${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function createJob(config: PaintConfig, input: CreateJobInput): PaintJobRecord {
  const id = input.id ?? generatePaintJobId(config.jobIdStyle);
  const storage = createJobOutputDir(
    config.outputDir,
    id,
    config.outputRetentionHours,
    config.outputDirIsDefault,
  );
  const now = new Date().toISOString();
  const workflowSnapshotPath = path.join(storage.jobDir, WORKFLOW_SNAPSHOT);
  writePrivateJson(workflowSnapshotPath, input.promptWorkflow);

  const job: PaintJobRecord = {
    version: 1,
    id,
    state: "preparing",
    createdAt: now,
    updatedAt: now,
    backend: input.backend,
    clientId: input.clientId,
    workflow: input.workflow,
    workflowPath: input.workflowPath,
    workflowHash: hashWorkflow(input.promptWorkflow),
    workflowSnapshotPath,
    outputDir: storage.outputDir,
    outputNodeIds: input.outputNodeIds,
    outputPrefix: input.outputPrefix,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    variables: input.variables,
    loras: input.loras,
    sourceInputPaths: input.sourceInputPaths,
    uploadedInputs: input.uploadedInputs ?? [],
    appliedLoras: input.appliedLoras ?? [],
    warnings: input.warnings,
    files: [],
  };
  writePrivateJson(recordPath(storage.jobDir), job);
  return job;
}

export function jobDirectory(outputRoot: string, jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error(`Invalid paint job ID: ${jobId}`);
  return path.join(outputRoot, `job-${jobId}`);
}

export function saveJob(job: PaintJobRecord): PaintJobRecord {
  const jobDir = path.dirname(job.workflowSnapshotPath);
  if (!hasValidStoragePaths(job, jobDir)) {
    throw new Error(`Invalid storage metadata for paint job ${job.id}`);
  }
  const next: PaintJobRecord = { ...job, updatedAt: new Date().toISOString() };
  writePrivateJson(recordPath(jobDir), next);
  return next;
}

export function updateJob(
  job: PaintJobRecord,
  patch: Partial<Omit<PaintJobRecord, "id" | "version" | "createdAt">>,
): PaintJobRecord {
  const nextState = patch.state ?? job.state;
  const terminalAt = isTerminalJobState(nextState)
    ? patch.terminalAt ?? (isTerminalJobState(job.state) ? job.terminalAt : undefined) ?? new Date().toISOString()
    : undefined;
  return saveJob({ ...job, ...patch, terminalAt });
}

function parseJobRecord(filePath: string): PaintJobRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PaintJobRecord;
    if (
      value.version !== 1 ||
      !value.id ||
      !value.backend?.url ||
      !hasValidStoragePaths(value, path.dirname(filePath))
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function loadJob(outputRoot: string, jobId: string): PaintJobRecord {
  const job = parseJobRecord(recordPath(jobDirectory(outputRoot, jobId)));
  if (!job || job.id !== jobId) throw new Error(`Paint job not found: ${jobId}`);
  return job;
}

export function listJobs(outputRoot: string, limit = 20): PaintJobRecord[] {
  if (!fs.existsSync(outputRoot)) return [];
  const jobs: PaintJobRecord[] = [];
  for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_DIR_PATTERN.test(entry.name)) continue;
    const job = parseJobRecord(recordPath(path.join(outputRoot, entry.name)));
    if (job) jobs.push(job);
  }
  return jobs
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function rewriteWorkflowSnapshot(
  job: PaintJobRecord,
  workflow: Record<string, unknown>,
): PaintJobRecord {
  writePrivateJson(job.workflowSnapshotPath, workflow);
  return updateJob(job, { workflowHash: hashWorkflow(workflow) });
}
