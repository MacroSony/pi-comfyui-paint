/**
 * paint_search_danbooru_tags tool — query Danbooru to confirm tags and find related tags.
 *
 * Supports multiple queries at once. Each query uses Danbooru's tags.json endpoint
 * with wildcard name-matching to find exact and partial tag matches.
 */

import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

const DANBOORU_BASE = "https://danbooru.donmai.us";

interface DanbooruTag {
  id: number;
  name: string;
  post_count: number;
  category: number;
  is_deprecated: boolean;
}

function categoryName(cat: number): string {
  const map: Record<number, string> = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
  };
  return map[cat] ?? `cat-${cat}`;
}

async function searchTags(query: string, limit: number): Promise<DanbooruTag[]> {
  const encoded = encodeURIComponent(`*${query}*`);
  const url = `${DANBOORU_BASE}/tags.json?search[name_matches]=${encoded}&search[order]=count&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-comfyui-paint/0.0.7" },
    });
    if (!res.ok) return [];
    return (await res.json()) as DanbooruTag[];
  } catch {
    return [];
  }
}

export function createSearchDanbooruTagsTool(_config: PaintConfig): ToolRegistration {
  return {
    name: "paint_search_danbooru_tags",
    label: "Paint Search Danbooru Tags",
    description:
      "Search Danbooru for tags to confirm they exist and discover related tags. " +
      "Supports multiple queries at once. Returns matching tags sorted by post count, showing " +
      "name, category, and popularity. Use this to verify tags before using them in a paint prompt.",
    promptSnippet: "Query Danbooru tag search to confirm tags and find related ones by name",
    promptGuidelines: [
      "Use paint_search_danbooru_tags when you need to verify whether a tag exists on Danbooru, or want to discover related tag names before writing a paint prompt. Supports multiple queries in a single call. Each query does a wildcard search (e.g., 'smile' matches 'smile', 'light_smile', 'evil_smile', etc.).",
    ],
    parameters: {
      queries: {
        type: "array",
        description:
          "One or more tag queries to search (e.g., ['smile', 'blonde hair']). " +
          "Each query performs a wildcard match — 'smile' also finds 'light_smile', 'evil_smile', etc.",
      },
      limit: {
        type: "optional",
        description: "Max results per query. Default: 8, max: 20.",
      },
    },
    async execute(params) {
      const queries = (params?.queries as string[]) ?? [];
      const limit = Math.min((params?.limit as number) ?? 8, 20);

      if (queries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No queries provided. Pass one or more tag names to search.",
            },
          ],
          details: {},
        };
      }

      const lines: string[] = [
        `**Danbooru tag search for ${queries.length} quer${queries.length === 1 ? "y" : "ies"}:**`,
      ];

      for (const query of queries) {
        const trimmed = query.trim();
        if (!trimmed) continue;

        const tags = await searchTags(trimmed, limit);

        lines.push(`\n### \`${trimmed}\``);

        if (tags.length === 0) {
          lines.push("*No matching tags found.*");
          continue;
        }

        for (const tag of tags.slice(0, limit)) {
          const cat = categoryName(tag.category);
          const count = tag.post_count.toLocaleString();
          const flags: string[] = [];
          if (tag.is_deprecated) flags.push("⚠ deprecated");

          const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
          lines.push(`- **${tag.name}** (${cat}, ${count} posts)${flagStr}`);
        }

        const shown = Math.min(tags.length, limit);
        if (shown < tags.length) {
          lines.push(`*…and ${tags.length - shown} more results*`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { queries, limit },
      };
    },
  };
}
