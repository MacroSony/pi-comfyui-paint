/**
 * paint_search_danbooru_tags tool - query Danbooru to confirm tags and find related tags.
 *
 * Supports multiple queries at once. By default, each query uses Danbooru's
 * tags.json endpoint with wildcard name-matching. Pass mode="related" to query
 * related_tag.json for tags that frequently appear with a tag/search.
 */

import type { PaintConfig } from "../types.js";
import type { ToolRegistration } from "./tool-utils.js";

const DANBOORU_BASE = "https://danbooru.donmai.us";
const USER_AGENT = "pi-comfyui-paint";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const RELATED_ORDERS = new Set(["frequency", "cosine", "jaccard", "overlap"]);

interface DanbooruTag {
  id: number;
  name: string;
  post_count: number;
  category: number;
  is_deprecated: boolean;
}

interface DanbooruRelatedTag {
  tag?: unknown;
  frequency?: unknown;
  cosine_similarity?: unknown;
  jaccard_similarity?: unknown;
  overlap_coefficient?: unknown;
}

interface RelatedTagResult {
  tag: DanbooruTag;
  frequency?: number;
  cosineSimilarity?: number;
  jaccardSimilarity?: number;
  overlapCoefficient?: number;
}

interface RelatedTagsResponse {
  query?: string;
  post_count?: number;
  tag?: unknown;
  related_tags?: unknown[];
  wiki_page_tags?: unknown[];
}

interface TagSearchResult {
  tags: DanbooruTag[];
  error?: string;
  status?: number;
}

interface ExactTagCheck {
  checkedName: string;
  tag?: DanbooruTag;
  error?: string;
  status?: number;
}

interface RelatedSearchResult {
  query: string;
  postCount?: number;
  exactTag?: DanbooruTag;
  relatedTags: RelatedTagResult[];
  wikiPageTags: DanbooruTag[];
  error?: string;
  status?: number;
}

export function categoryName(cat: number): string {
  const map: Record<number, string> = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
  };
  return map[cat] ?? `cat-${cat}`;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function categoryParam(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const categories = value
      .map((entry) => stringParam(entry))
      .filter((entry): entry is string => Boolean(entry));
    return categories.length > 0 ? categories.join(",") : undefined;
  }
  return stringParam(value);
}

function numberParam(value: unknown): string | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? String(Math.floor(parsed)) : undefined;
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function normalizeTag(raw: unknown): DanbooruTag | undefined {
  const item = record(raw);
  const name = stringParam(item?.name);
  if (!item || !name) return undefined;

  const category = numeric(item.category) ?? 0;
  const postCount = numeric(item.post_count) ?? 0;
  return {
    id: numeric(item.id) ?? 0,
    name,
    post_count: postCount,
    category,
    is_deprecated: Boolean(item.is_deprecated),
  };
}

function canonicalTagName(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, "_");
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = record(error.cause);
  const causeCode = stringParam(cause?.code);
  const causeMessage = stringParam(cause?.message);
  const suffix = causeCode ?? causeMessage;
  return suffix ? `${error.message} (${suffix})` : error.message;
}

export function normalizeRelatedTag(raw: unknown): RelatedTagResult | undefined {
  const item = record(raw) as DanbooruRelatedTag | undefined;
  if (!item) return undefined;

  const tag = normalizeTag(item.tag) ?? normalizeTag(item);
  if (!tag) return undefined;

  return {
    tag,
    frequency: numeric(item.frequency),
    cosineSimilarity: numeric(item.cosine_similarity),
    jaccardSimilarity: numeric(item.jaccard_similarity),
    overlapCoefficient: numeric(item.overlap_coefficient),
  };
}

export function buildTagSearchUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    "search[name_matches]": `*${query}*`,
    "search[order]": "count",
    limit: String(limit),
  });
  return `${DANBOORU_BASE}/tags.json?${params}`;
}

export function buildExactTagUrl(query: string): string {
  const params = new URLSearchParams({
    "search[name]": canonicalTagName(query),
    limit: "1",
  });
  return `${DANBOORU_BASE}/tags.json?${params}`;
}

export function buildRelatedTagsUrl(
  query: string,
  limit: number,
  options: {
    order?: unknown;
    categories?: unknown;
    searchSampleSize?: unknown;
    tagSampleSize?: unknown;
  } = {},
): string {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
  });

  const order = stringParam(options.order)?.toLowerCase();
  if (order && RELATED_ORDERS.has(order) && order !== "frequency") {
    params.set("order", order);
  }

  const categories = categoryParam(options.categories);
  if (categories) params.set("category", categories);

  const searchSampleSize = numberParam(options.searchSampleSize);
  if (searchSampleSize) params.set("search_sample_size", searchSampleSize);

  const tagSampleSize = numberParam(options.tagSampleSize);
  if (tagSampleSize) params.set("tag_sample_size", tagSampleSize);

  return `${DANBOORU_BASE}/related_tag.json?${params}`;
}

async function fetchDanbooruJson(url: string): Promise<{
  data?: unknown;
  error?: string;
  status?: number;
}> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${await res.text()}`, status: res.status };
    }
    return { data: await res.json(), status: res.status };
  } catch (error) {
    return { error: formatFetchError(error) };
  }
}

async function searchTags(query: string, limit: number): Promise<TagSearchResult> {
  const result = await fetchDanbooruJson(buildTagSearchUrl(query, limit));
  if (result.error) return { tags: [], error: result.error, status: result.status };

  const tags = Array.isArray(result.data)
    ? result.data.map(normalizeTag).filter((tag): tag is DanbooruTag => Boolean(tag))
    : [];
  return { tags, status: result.status };
}

function findExactTag(query: string, tags: DanbooruTag[]): DanbooruTag | undefined {
  const exactName = canonicalTagName(query);
  return tags.find((tag) => tag.name.toLowerCase() === exactName);
}

async function checkExactTag(query: string, knownTags: DanbooruTag[] = []): Promise<ExactTagCheck> {
  const checkedName = canonicalTagName(query);
  const known = findExactTag(query, knownTags);
  if (known) return { checkedName, tag: known };

  const result = await fetchDanbooruJson(buildExactTagUrl(query));
  if (result.error) return { checkedName, error: result.error, status: result.status };

  const tags = Array.isArray(result.data)
    ? result.data.map(normalizeTag).filter((tag): tag is DanbooruTag => Boolean(tag))
    : [];
  return { checkedName, tag: findExactTag(query, tags), status: result.status };
}

function exactTagWarning(query: string, check: ExactTagCheck, context: "name" | "related"): string | undefined {
  if (check.error) {
    return `Warning: Could not verify whether \`${query}\` is an exact Danbooru tag (${check.error}).`;
  }

  if (check.tag) {
    if (check.tag.name !== query.trim()) {
      return `Warning: \`${query}\` is not exact Danbooru tag spelling. Use \`${check.tag.name}\`.`;
    }
    return undefined;
  }

  return context === "related"
    ? `Warning: \`${query}\` was not found as an exact Danbooru tag. Related tags are for the submitted search expression.`
    : `Warning: \`${query}\` was not found as an exact Danbooru tag. Showing wildcard tag-name matches.`;
}

function pushExactTagWarning(
  lines: string[],
  query: string,
  check: ExactTagCheck,
  context: "name" | "related",
): void {
  const warning = exactTagWarning(query, check, context);
  if (warning) lines.push(warning);
}

function pushRequestFailure(lines: string[], error: string, status?: number): void {
  const statusText = status ? ` (status ${status})` : "";
  lines.push(`*Danbooru request failed${statusText}: ${error}*`);
}

async function exactCheckForRelated(query: string, result: RelatedSearchResult): Promise<ExactTagCheck> {
  const checkedName = canonicalTagName(query);
  if (result.exactTag) return { checkedName, tag: result.exactTag };
  return checkExactTag(query);
}

async function searchRelatedTags(
  query: string,
  limit: number,
  options: {
    order?: unknown;
    categories?: unknown;
    searchSampleSize?: unknown;
    tagSampleSize?: unknown;
  },
): Promise<RelatedSearchResult> {
  const result = await fetchDanbooruJson(buildRelatedTagsUrl(query, limit, options));
  if (result.error) {
    return { query, relatedTags: [], wikiPageTags: [], error: result.error, status: result.status };
  }

  const raw = record(result.data) as RelatedTagsResponse | undefined;
  if (!raw) {
    return { query, relatedTags: [], wikiPageTags: [], error: "Unexpected response shape", status: result.status };
  }

  return {
    query: raw.query ?? query,
    postCount: numeric(raw.post_count),
    exactTag: normalizeTag(raw.tag),
    relatedTags: (raw.related_tags ?? [])
      .map(normalizeRelatedTag)
      .filter((tag): tag is RelatedTagResult => Boolean(tag)),
    wikiPageTags: (raw.wiki_page_tags ?? [])
      .map(normalizeTag)
      .filter((tag): tag is DanbooruTag => Boolean(tag)),
    status: result.status,
  };
}

function metricText(tag: RelatedTagResult): string {
  const parts: string[] = [];
  if (tag.frequency != null) parts.push(`freq ${(tag.frequency * 100).toFixed(1)}%`);
  if (tag.cosineSimilarity != null) parts.push(`cos ${tag.cosineSimilarity.toFixed(3)}`);
  if (tag.jaccardSimilarity != null) parts.push(`jac ${tag.jaccardSimilarity.toFixed(3)}`);
  if (tag.overlapCoefficient != null) parts.push(`overlap ${tag.overlapCoefficient.toFixed(3)}`);
  return parts.length > 0 ? `; ${parts.join(", ")}` : "";
}

function formatTagLine(tag: DanbooruTag, suffix = ""): string {
  const cat = categoryName(tag.category);
  const count = tag.post_count.toLocaleString();
  const flags: string[] = [];
  if (tag.is_deprecated) flags.push("deprecated");

  const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
  return `- **${tag.name}** (${cat}, ${count} posts${suffix})${flagStr}`;
}

export function createSearchDanbooruTagsTool(_config: PaintConfig): ToolRegistration {
  return {
    name: "paint_search_danbooru_tags",
    label: "Paint Search Danbooru Tags",
    description:
      "Search Danbooru for tags to confirm they exist, or fetch tags related to a tag/search. " +
      "Supports multiple queries at once. Name search returns matching tags sorted by post count. " +
      "Related search returns tags that frequently appear in posts matching the query.",
    promptSnippet: "Query Danbooru tags by wildcard name or related-tag search",
    promptGuidelines: [
      "Use paint_search_danbooru_tags when you need to verify whether a tag exists on Danbooru, or want to discover related tag names before writing a paint prompt. Supports multiple queries in a single call.",
      "Default mode does a wildcard name search (e.g. 'smile' matches 'smile', 'light_smile', 'evil_smile'). Use mode='related' when you already have a tag/search and want tags that commonly appear with it.",
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
      mode: {
        type: "optional",
        description: "Search mode: 'name' or 'search' for wildcard tag-name search (default), or 'related' for Danbooru related-tag search.",
      },
      categories: {
        type: "optional",
        description: "Related mode only. Optional category filter, as a string or array (e.g. 'general' or ['character', 'copyright']).",
      },
      order: {
        type: "optional",
        description: "Related mode only. Sort order: 'frequency' (default), 'cosine', 'jaccard', or 'overlap'.",
      },
      search_sample_size: {
        type: "optional",
        description: "Related mode only. Number of posts Danbooru should sample from the query.",
      },
      tag_sample_size: {
        type: "optional",
        description: "Related mode only. Number of candidate tags Danbooru should sample.",
      },
    },
    async execute(params) {
      const queries = Array.isArray(params?.queries)
        ? params.queries.filter((query): query is string => typeof query === "string")
        : [];
      const limit = clampLimit(params?.limit);
      const mode = stringParam(params?.mode)?.toLowerCase() === "related" ? "related" : "name";

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
        mode === "related"
          ? `**Danbooru related tag search for ${queries.length} quer${queries.length === 1 ? "y" : "ies"}:**`
          : `**Danbooru tag search for ${queries.length} quer${queries.length === 1 ? "y" : "ies"}:**`,
      ];
      const results: Record<string, unknown> = {};

      for (const query of queries) {
        const trimmed = query.trim();
        if (!trimmed) continue;

        lines.push(`\n### \`${trimmed}\``);

        if (mode === "related") {
          const related = await searchRelatedTags(trimmed, limit, {
            order: params?.order,
            categories: params?.categories,
            searchSampleSize: params?.search_sample_size,
            tagSampleSize: params?.tag_sample_size,
          });
          results[trimmed] = related;

          if (related.error) {
            pushRequestFailure(lines, related.error, related.status);
            continue;
          }

          const exactCheck = await exactCheckForRelated(trimmed, related);
          pushExactTagWarning(lines, trimmed, exactCheck, "related");

          if (related.postCount != null) {
            lines.push(`Posts matched: ${related.postCount.toLocaleString()}`);
          }

          if (related.relatedTags.length === 0) {
            lines.push("*No related tags found.*");
          } else {
            for (const relatedTag of related.relatedTags.slice(0, limit)) {
              lines.push(formatTagLine(relatedTag.tag, metricText(relatedTag)));
            }
          }

          if (related.wikiPageTags.length > 0) {
            lines.push("\nWiki page tags:");
            for (const tag of related.wikiPageTags.slice(0, limit)) {
              lines.push(formatTagLine(tag));
            }
          }
          continue;
        }

        const tagSearch = await searchTags(trimmed, limit);
        results[trimmed] = tagSearch;

        if (tagSearch.error) {
          pushRequestFailure(lines, tagSearch.error, tagSearch.status);
          continue;
        }

        const exactCheck = await checkExactTag(trimmed, tagSearch.tags);
        pushExactTagWarning(lines, trimmed, exactCheck, "name");

        if (tagSearch.tags.length === 0) {
          lines.push("*No matching tags found.*");
          continue;
        }

        for (const tag of tagSearch.tags.slice(0, limit)) {
          lines.push(formatTagLine(tag));
        }

        const shown = Math.min(tagSearch.tags.length, limit);
        if (shown < tagSearch.tags.length) {
          lines.push(`*…and ${tagSearch.tags.length - shown} more results*`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { queries, limit, mode, results },
      };
    },
  };
}
