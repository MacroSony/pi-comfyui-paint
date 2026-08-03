/** Inspect durable paint jobs and retrieve completed outputs. */

import { listJobs, loadJob } from "../job-store.js";
import { formatJobResult, reconcileJob } from "../job-runner.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createJobStatusTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_job_status",
    label: "Paint Job Status",
    description:
      "Check a durable background paint job and retrieve its outputs when complete. " +
      "Omit job_id to list recent jobs.",
    promptSnippet: "Check or list durable ComfyUI paint jobs",
    promptGuidelines: [
      "Use paint_job_status after paint(background=true). Completed jobs return paths and bounded image previews.",
    ],
    parameters: {
      job_id: { type: "optional", valueType: "string", description: "Paint job ID. Omit to list recent jobs." },
      limit: { type: "optional", valueType: "number", description: "Maximum recent jobs to list (default 20, maximum 100)." },
    },
    async execute(params, signal) {
      const jobId = params?.job_id as string | undefined;
      if (jobId) {
        let job = loadJob(config.outputDir, jobId);
        job = await reconcileJob(config, job, signal);
        return formatJobResult(config, job);
      }

      const requestedLimit = typeof params?.limit === "number" ? params.limit : 20;
      const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 100);
      const jobs = listJobs(config.outputDir, limit);
      const lines = jobs.length === 0
        ? ["No durable paint jobs found."]
        : [
            `Recent paint jobs (${jobs.length}):`,
            ...jobs.map((job) =>
              `- ${job.id} | ${job.state} | ${job.backend.id} | ${job.workflow} | ${job.createdAt}`,
            ),
          ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          jobs: jobs.map((job) => ({
            jobId: job.id,
            state: job.state,
            backend: job.backend,
            promptId: job.promptId,
            workflow: job.workflow,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            files: job.files,
            error: job.error,
            diagnostic: job.diagnostic,
          })),
        },
      };
    },
  };
}
