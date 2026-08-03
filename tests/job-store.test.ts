import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupExpiredOutputs } from "../src/output-storage.js";
import {
  createJob,
  listJobs,
  loadJob,
  rewriteWorkflowSnapshot,
  updateJob,
} from "../src/job-store.js";
import type { PaintConfig } from "../src/types.js";

describe("durable job store", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup(): { root: string; config: PaintConfig } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paint-jobs-test-"));
    roots.push(root);
    return {
      root,
      config: {
        backends: [{ id: "default", url: "http://comfy.test" }],
        serverAddress: "http://comfy.test",
        workflowDir: root,
        projectWorkflowDir: root,
        bundledWorkflowDir: root,
        outputDir: root,
        outputDirIsDefault: false,
        outputRetentionHours: 168,
        syncTimeoutMs: 600_000,
        clientId: "client",
        interruptOnAbort: false,
        inlineImageLimit: 1,
        imageQuality: 80,
        imageMaxDimension: 2000,
        imageMaxBytes: 4_718_592,
        imageTotalMaxBytes: 8_388_608,
      },
    };
  }

  function newJob(config: PaintConfig) {
    return createJob(config, {
      backend: config.backends[0],
      clientId: config.clientId,
      workflow: "test.json",
      workflowPath: "/workflows/test.json",
      promptWorkflow: { "1": { class_type: "SaveImage", inputs: {} } },
      outputNodeIds: ["1"],
      prompt: "test",
      sourceInputPaths: [],
      warnings: [],
    });
  }

  it("creates private records that survive a fresh load", () => {
    const { config } = setup();
    let job = newJob(config);
    job = updateJob(job, { state: "submitted", promptId: "prompt-1" });
    expect(loadJob(config.outputDir, job.id)).toMatchObject({
      id: job.id,
      state: "submitted",
      promptId: "prompt-1",
      backend: config.backends[0],
    });
    expect(listJobs(config.outputDir)).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(path.dirname(job.workflowSnapshotPath), "job.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("atomically rewrites the workflow snapshot and hash", () => {
    const { config } = setup();
    const job = newJob(config);
    const next = rewriteWorkflowSnapshot(job, { changed: true });
    expect(next.workflowHash).not.toBe(job.workflowHash);
    expect(JSON.parse(fs.readFileSync(next.workflowSnapshotPath, "utf-8"))).toEqual({ changed: true });
  });

  it("never expires active jobs but removes old terminal jobs", () => {
    const { config, root } = setup();
    const active = updateJob(newJob(config), { state: "running" });
    const completed = updateJob(newJob(config), {
      state: "completed",
      completedAt: "2020-01-01T00:00:00.000Z",
      terminalAt: "2020-01-01T00:00:00.000Z",
    });

    const removed = cleanupExpiredOutputs(root, 1, Date.parse("2020-01-02T00:00:00.000Z"));
    expect(removed).toContain(path.dirname(completed.workflowSnapshotPath));
    expect(fs.existsSync(path.dirname(active.workflowSnapshotPath))).toBe(true);
  });

  it("rejects path traversal in job IDs", () => {
    const { config } = setup();
    expect(() => loadJob(config.outputDir, "../escape")).toThrow("Invalid paint job ID");
  });

  it("rejects job records whose persisted storage paths escape their job directory", () => {
    const { config } = setup();
    const job = newJob(config);
    const recordPath = path.join(path.dirname(job.workflowSnapshotPath), "job.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    record.outputDir = path.join(config.outputDir, "elsewhere");
    fs.writeFileSync(recordPath, JSON.stringify(record));
    expect(() => loadJob(config.outputDir, job.id)).toThrow(`Paint job not found: ${job.id}`);
  });
});
