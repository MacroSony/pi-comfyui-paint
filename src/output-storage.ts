/**
 * Private, collision-free storage for generated media.
 *
 * Each generation receives its own directory. A marker file lets retention
 * cleanup distinguish directories created by this extension from unrelated
 * files that may live under a user-configured output root.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const GENERATION_PREFIX = "generation-";
const OUTPUT_MARKER = ".pi-comfyui-paint-output";

function ensureOutputRoot(outputRoot: string, managedRoot: boolean): void {
  if (!fs.existsSync(outputRoot)) {
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    return;
  }

  const stat = fs.lstatSync(outputRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Output root must be a real directory: ${outputRoot}`);
  }
  if (managedRoot && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Default output root is not owned by the current user: ${outputRoot}`);
  }
  if (managedRoot) {
    fs.chmodSync(outputRoot, 0o700);
  }
}

/** Remove expired generation directories previously created by this extension. */
export function cleanupExpiredOutputs(
  outputRoot: string,
  retentionHours: number,
  nowMs = Date.now(),
): string[] {
  if (retentionHours <= 0 || !fs.existsSync(outputRoot)) return [];

  const cutoffMs = nowMs - retentionHours * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(GENERATION_PREFIX)) continue;

    const candidate = path.join(outputRoot, entry.name);
    const marker = path.join(candidate, OUTPUT_MARKER);
    try {
      const markerStat = fs.lstatSync(marker);
      if (!markerStat.isFile() || markerStat.mtimeMs >= cutoffMs) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch {
      // Retention is best-effort and must never block a generation.
    }
  }

  return removed;
}

/** Create a private, unique directory for one generation. */
export function createGenerationOutputDir(
  outputRoot: string,
  retentionHours: number,
  managedRoot = false,
): { outputDir: string; removedExpired: string[] } {
  ensureOutputRoot(outputRoot, managedRoot);
  const removedExpired = cleanupExpiredOutputs(outputRoot, retentionHours);
  const outputDir = fs.mkdtempSync(path.join(outputRoot, GENERATION_PREFIX));
  fs.chmodSync(outputDir, 0o700);
  fs.writeFileSync(
    path.join(outputDir, OUTPUT_MARKER),
    JSON.stringify({ createdAt: new Date().toISOString() }),
    { encoding: "utf-8", mode: 0o600 },
  );
  return { outputDir, removedExpired };
}

/** Write one generated file with user-only permissions. */
export function writeGeneratedFile(filePath: string, data: Buffer): void {
  fs.writeFileSync(filePath, data, { mode: 0o600 });
}
