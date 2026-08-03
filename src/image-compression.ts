/**
 * Build bounded image previews for tool content.
 *
 * Generated originals stay untouched on disk. Previews are resized and encoded
 * as JPEG, progressively reducing quality and dimensions until both the image
 * dimension and base64 payload limits are satisfied.
 */

import sharp from "sharp";

export interface CompressedImagePreview {
  data: string;
  mimeType: "image/jpeg";
  encodedBytes: number;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
}

const MIN_DIMENSION = 1;

function qualitySteps(initialQuality: number): number[] {
  const normalized = Math.min(Math.max(Math.round(initialQuality), 1), 100);
  return [...new Set([normalized, 85, 70, 55, 40, 25])]
    .filter((quality) => quality <= normalized);
}

function fitDimensions(
  width: number | undefined,
  height: number | undefined,
  maxDimension: number,
): { width?: number; height?: number } {
  if (!width || !height) return {};
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(MIN_DIMENSION, Math.round(width * scale)),
    height: Math.max(MIN_DIMENSION, Math.round(height * scale)),
  };
}

/**
 * Compress an image into a provider-safe inline preview.
 * Throws when the bytes are not a decodable image or cannot be encoded.
 */
export async function compressImageForLLM(
  input: Buffer | string,
  quality: number,
  maxDimension: number,
  maxEncodedBytes: number,
): Promise<CompressedImagePreview> {
  const metadata = await sharp(input, { animated: false }).metadata();
  const originalWidth = metadata.width;
  const originalHeight = metadata.height;
  const fitted = fitDimensions(originalWidth, originalHeight, Math.max(maxDimension, 1));

  let width = fitted.width;
  let height = fitted.height;

  while (true) {
    for (const candidateQuality of qualitySteps(quality)) {
      let pipeline = sharp(input, { animated: false }).rotate();
      if (width && height) {
        pipeline = pipeline.resize({
          width,
          height,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      const encoded = await pipeline
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: candidateQuality })
        .toBuffer({ resolveWithObject: true });
      const data = encoded.data.toString("base64");
      const encodedBytes = Buffer.byteLength(data, "utf-8");

      if (encodedBytes <= maxEncodedBytes) {
        return {
          data,
          mimeType: "image/jpeg",
          encodedBytes,
          originalWidth,
          originalHeight,
          width: encoded.info.width,
          height: encoded.info.height,
        };
      }
    }

    if (!width || !height || (width === MIN_DIMENSION && height === MIN_DIMENSION)) {
      throw new Error(`could not reduce preview below ${maxEncodedBytes} encoded bytes`);
    }

    const nextWidth = width === MIN_DIMENSION
      ? MIN_DIMENSION
      : Math.max(MIN_DIMENSION, Math.floor(width * 0.75));
    const nextHeight = height === MIN_DIMENSION
      ? MIN_DIMENSION
      : Math.max(MIN_DIMENSION, Math.floor(height * 0.75));
    if (nextWidth === width && nextHeight === height) {
      throw new Error(`could not reduce preview below ${maxEncodedBytes} encoded bytes`);
    }
    width = nextWidth;
    height = nextHeight;
  }
}
