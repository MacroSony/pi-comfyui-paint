/**
 * Image compression for LLM provider.
 *
 * Compresses images before sending to the LLM to reduce token usage.
 * Original files on disk are never modified.
 */

import sharp from "sharp";

/**
 * Compress an image buffer for sending to the LLM provider.
 * - If quality is 0, returns the raw PNG data unchanged.
 * - Otherwise resizes (if maxDimension > 0) and converts to JPEG at the given quality.
 * Returns { data: base64 string, mimeType: string }.
 */
export async function compressImageForLLM(
  buf: Buffer,
  mimeType: string,
  quality: number,
  maxDimension: number,
): Promise<{ data: string; mimeType: string }> {
  // No compression requested — pass through as-is
  if (quality === 0) {
    return { data: buf.toString("base64"), mimeType };
  }

  let pipeline = sharp(buf);
  const metadata = await pipeline.metadata();

  // Resize if the image exceeds maxDimension on its longest side
  if (maxDimension > 0 && metadata.width && metadata.height) {
    const longest = Math.max(metadata.width, metadata.height);
    if (longest > maxDimension) {
      pipeline = pipeline.resize({
        width: maxDimension,
        height: maxDimension,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
  }

  // Convert to JPEG at the configured quality
  const compressed = await pipeline.jpeg({ quality }).toBuffer();
  return { data: compressed.toString("base64"), mimeType: "image/jpeg" };
}
