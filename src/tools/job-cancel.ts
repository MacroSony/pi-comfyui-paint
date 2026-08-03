/** Cancel one durable paint job without interrupting unrelated backend work. */

import { loadJob } from "../job-store.js";
import { cancelJob } from "../job-runner.js";
import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

export function createJobCancelTool(config: PaintConfig): ToolRegistration {
  return {
    name: "paint_job_cancel",
    label: "Paint Job Cancel",
    description:
      "Cancel a specific durable paint job through ComfyUI's targeted API when available. " +
      "Legacy backends can safely remove pending prompts but leave running work untouched.",
    promptSnippet: "Cancel one durable ComfyUI paint job by ID",
    promptGuidelines: [
      "Use paint_job_cancel for a job returned by paint. It avoids interrupting unrelated prompts.",
    ],
    parameters: {
      job_id: { type: "string", description: "Durable paint job ID." },
    },
    async execute(params, signal) {
      const jobId = params?.job_id as string;
      const initialJob = loadJob(config.outputDir, jobId);
      const { job, outcome } = await cancelJob(config, initialJob, signal);
      return {
        content: [
          {
            type: "text",
            text: `${outcome}\nJob: ${job.id}\nState: ${job.state}\nBackend: ${job.backend.id}`,
          },
        ],
        details: {
          jobId: job.id,
          state: job.state,
          backend: job.backend,
          promptId: job.promptId,
          outcome,
        },
      };
    },
  };
}
