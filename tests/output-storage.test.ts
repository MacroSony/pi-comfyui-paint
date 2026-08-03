import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredOutputs,
  createGenerationOutputDir,
  writeGeneratedFile,
} from "../src/output-storage.js";

describe("output storage", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paint-storage-test-"));
    roots.push(root);
    return root;
  }

  it("creates unique private generation directories and files", () => {
    const root = tempRoot();
    const first = createGenerationOutputDir(root, 168).outputDir;
    const second = createGenerationOutputDir(root, 168).outputDir;
    expect(first).not.toBe(second);

    const output = path.join(first, "image.png");
    writeGeneratedFile(output, Buffer.from("test"));
    expect(fs.readFileSync(output, "utf-8")).toBe("test");

    if (process.platform !== "win32") {
      expect(fs.statSync(first).mode & 0o777).toBe(0o700);
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    }
  });

  it("removes only expired, marked generation directories", () => {
    const root = tempRoot();
    const owned = createGenerationOutputDir(root, 0).outputDir;
    const marker = path.join(owned, ".pi-comfyui-paint-output");
    const oldTime = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(marker, oldTime, oldTime);

    const unowned = path.join(root, "generation-unowned");
    fs.mkdirSync(unowned);
    const removed = cleanupExpiredOutputs(root, 1, Date.parse("2020-01-02T00:00:00Z"));

    expect(removed).toEqual([owned]);
    expect(fs.existsSync(owned)).toBe(false);
    expect(fs.existsSync(unowned)).toBe(true);
  });

  it("does not clean outputs when retention is disabled", () => {
    const root = tempRoot();
    const owned = createGenerationOutputDir(root, 0).outputDir;
    expect(cleanupExpiredOutputs(root, 0, Date.now() + 10_000)).toEqual([]);
    expect(fs.existsSync(owned)).toBe(true);
  });
});
