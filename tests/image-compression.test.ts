import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { compressImageForLLM } from "../src/image-compression.js";

describe("compressImageForLLM", () => {
  it("resizes previews to the configured maximum dimension", async () => {
    const input = await sharp({
      create: {
        width: 1200,
        height: 600,
        channels: 3,
        background: { r: 120, g: 80, b: 40 },
      },
    }).png().toBuffer();

    const preview = await compressImageForLLM(input, 80, 300, 1024 * 1024);
    expect(preview.mimeType).toBe("image/jpeg");
    expect(preview.originalWidth).toBe(1200);
    expect(preview.originalHeight).toBe(600);
    expect(preview.width).toBeLessThanOrEqual(300);
    expect(preview.height).toBeLessThanOrEqual(300);
    expect(preview.encodedBytes).toBe(Buffer.byteLength(preview.data, "utf-8"));
  });

  it("progressively reduces a noisy image to the encoded byte cap", async () => {
    const width = 512;
    const height = 512;
    const input = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    }).png().toBuffer();

    const preview = await compressImageForLLM(input, 95, 512, 32 * 1024);
    expect(preview.encodedBytes).toBeLessThanOrEqual(32 * 1024);
    expect(preview.width).toBeLessThan(512);
    expect(preview.height).toBeLessThan(512);
  });

  it("rejects bytes that are not a decodable image", async () => {
    await expect(
      compressImageForLLM(Buffer.from("not an image"), 80, 2000, 1024 * 1024),
    ).rejects.toThrow();
  });
});
