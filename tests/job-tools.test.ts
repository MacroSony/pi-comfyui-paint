import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createJob, loadJob, updateJob } from "../src/job-store.js";
import { createJobCancelTool } from "../src/tools/job-cancel.js";
import { createJobStatusTool } from "../src/tools/job-status.js";
import type { PaintConfig } from "../src/types.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("durable job tools", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup(): { config: PaintConfig; job: ReturnType<typeof createJob> } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paint-job-tools-"));
    roots.push(root);
    const config: PaintConfig = {
      backends: [{ id: "gpu-a", url: "http://gpu-a.test:8188" }],
      serverAddress: "http://gpu-a.test:8188",
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
    };
    let job = createJob(config, {
      backend: config.backends[0],
      clientId: config.clientId,
      workflow: "video.json",
      workflowPath: "/workflows/video.json",
      promptWorkflow: { "2": { class_type: "SaveImage", inputs: {} } },
      outputNodeIds: ["2"],
      prompt: "test",
      sourceInputPaths: [],
      warnings: [],
    });
    job = updateJob(job, {
      state: "submitted",
      promptId: "prompt-1",
      submittedAt: new Date().toISOString(),
    });
    return { config, job };
  }

  it("recovers a completed job from disk and finalizes its outputs only once", async () => {
    const { config, job } = setup();
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#123456" },
    }).png().toBuffer();
    let viewRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/history/")) {
        return jsonResponse({
          "prompt-1": {
            status: { status_str: "success", completed: true, messages: [] },
            outputs: {
              "2": {
                images: [{ filename: "result.png", subfolder: "", type: "output" }],
              },
            },
          },
        });
      }
      if (url.pathname === "/view") {
        viewRequests++;
        return new Response(png);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const tool = createJobStatusTool(config);
    const first = await tool.execute({ job_id: job.id }, new AbortController().signal);
    expect(first.details).toMatchObject({ jobId: job.id, state: "completed" });
    expect(first.content.some((item) => item.type === "image")).toBe(true);
    expect(viewRequests).toBe(1);

    // A fresh disk load represents a later Pi session; completed files are reused.
    expect(loadJob(config.outputDir, job.id).state).toBe("completed");
    const second = await tool.execute({ job_id: job.id }, new AbortController().signal);
    expect(second.details).toMatchObject({ state: "completed" });
    expect(viewRequests).toBe(1);
  });

  it("keeps output failures retryable instead of losing the completed generation", async () => {
    const { config, job } = setup();
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#654321" },
    }).png().toBuffer();
    let viewAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/history/")) {
        return jsonResponse({
          "prompt-1": {
            status: { status_str: "success", completed: true, messages: [] },
            outputs: {
              "2": { images: [{ filename: "result.png", subfolder: "", type: "output" }] },
            },
          },
        });
      }
      if (url.pathname === "/view") {
        viewAttempts++;
        return viewAttempts === 1
          ? new Response("temporary failure", { status: 503 })
          : new Response(png);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const tool = createJobStatusTool(config);
    const failed = await tool.execute({ job_id: job.id }, new AbortController().signal);
    expect(failed.details).toMatchObject({ state: "finalization_failed" });
    expect((failed.content[0] as { text: string }).text).toContain("retry output retrieval");

    const retried = await tool.execute({ job_id: job.id }, new AbortController().signal);
    expect(retried.details).toMatchObject({ state: "completed" });
    expect(viewAttempts).toBe(2);
  });

  it("lists recent durable jobs without contacting ComfyUI", async () => {
    const { config, job } = setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await createJobStatusTool(config).execute({}, new AbortController().signal);
    expect((result.content[0] as { text: string }).text).toContain(job.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not claim an ambiguous submission was cancelled without a prompt ID", async () => {
    const { config, job: submitted } = setup();
    const job = updateJob(submitted, {
      state: "submission_unknown",
      promptId: undefined,
      error: "Prompt response was lost.",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createJobCancelTool(config).execute(
      { job_id: job.id },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({ state: "submission_unknown" });
    expect((result.content[0] as { text: string }).text).toContain("cannot be targeted safely");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes an exact queued prompt without interrupting the backend", async () => {
    const { config, job } = setup();
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname.startsWith("/history/")) return jsonResponse({});
      if (url.pathname.startsWith("/api/jobs/")) {
        return new Response("missing route", { status: 404 });
      }
      if (url.pathname === "/queue" && method === "GET") {
        return jsonResponse({ queue_running: [], queue_pending: [[0, "prompt-1"]] });
      }
      if (url.pathname === "/queue" && method === "POST") return new Response(null);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await createJobCancelTool(config).execute(
      { job_id: job.id },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({ state: "cancelled" });
    expect(requests).toContainEqual({ path: "/queue", method: "POST" });
    expect(requests.some((request) => request.path === "/interrupt")).toBe(false);
  });

  it("uses atomic targeted cancellation for a running prompt", async () => {
    const { config, job } = setup();
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname.startsWith("/history/")) return jsonResponse({});
      if (url.pathname === "/api/jobs/prompt-1/cancel") {
        return jsonResponse({ cancelled: true });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await createJobCancelTool(config).execute(
      { job_id: job.id },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({ state: "cancelled" });
    expect(requests).toContainEqual({ path: "/api/jobs/prompt-1/cancel", method: "POST" });
    expect(requests.some((request) => request.path === "/interrupt")).toBe(false);
  });

  it("leaves a legacy backend's running prompt untouched", async () => {
    const { config, job } = setup();
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ path: url.pathname, method });
      if (url.pathname.startsWith("/history/")) return jsonResponse({});
      if (url.pathname.startsWith("/api/jobs/")) {
        return new Response("missing route", { status: 404 });
      }
      if (url.pathname === "/queue") {
        return jsonResponse({ queue_running: [[0, "prompt-1"]], queue_pending: [] });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const result = await createJobCancelTool(config).execute(
      { job_id: job.id },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({ state: "running" });
    expect((result.content[0] as { text: string }).text).toContain("too old");
    expect(requests.some((request) => request.path === "/interrupt")).toBe(false);
  });

  it("does not interrupt when the prompt cannot be found", async () => {
    const { config, job } = setup();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.startsWith("/history/")) return jsonResponse({});
      if (url.pathname.startsWith("/api/jobs/")) return jsonResponse({ cancelled: false });
      if (url.pathname === "/queue") {
        return jsonResponse({ queue_running: [[0, "someone-else"]], queue_pending: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await createJobCancelTool(config).execute(
      { job_id: job.id },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({ state: "unknown" });
    expect(requests).not.toContain("/interrupt");
  });

  it("restores the prior state when a cancellation request fails", async () => {
    const { config, job } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("backend offline");
    }));

    await expect(createJobCancelTool(config).execute(
      { job_id: job.id },
      new AbortController().signal,
    )).rejects.toThrow("backend offline");
    expect(loadJob(config.outputDir, job.id)).toMatchObject({
      state: "submitted",
      diagnostic: "Cancellation attempt failed: backend offline",
    });
  });
});
