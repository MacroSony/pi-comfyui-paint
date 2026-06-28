/**
 * Tests for paint_search_danbooru_tags tool.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildExactTagUrl,
  buildRelatedTagsUrl,
  buildTagSearchUrl,
  categoryName,
  createSearchDanbooruTagsTool,
  normalizeRelatedTag,
} from "../src/tools/search-danbooru-tags.js";
import type { PaintConfig } from "../src/types.js";

describe("categoryName", () => {
  it("maps known Danbooru categories", () => {
    expect(categoryName(0)).toBe("general");
    expect(categoryName(1)).toBe("artist");
    expect(categoryName(3)).toBe("copyright");
    expect(categoryName(4)).toBe("character");
    expect(categoryName(5)).toBe("meta");
  });

  it("falls back to cat-N for unknown categories", () => {
    expect(categoryName(2)).toBe("cat-2");
    expect(categoryName(99)).toBe("cat-99");
    expect(categoryName(-1)).toBe("cat--1");
  });
});

describe("Danbooru URL builders", () => {
  it("builds wildcard tag search URLs", () => {
    const url = new URL(buildTagSearchUrl("light smile", 8));
    expect(url.pathname).toBe("/tags.json");
    expect(url.searchParams.get("search[name_matches]")).toBe("*light smile*");
    expect(url.searchParams.get("search[order]")).toBe("count");
    expect(url.searchParams.get("limit")).toBe("8");
  });

  it("builds exact tag lookup URLs with Danbooru tag spelling", () => {
    const url = new URL(buildExactTagUrl("Light Smile"));
    expect(url.pathname).toBe("/tags.json");
    expect(url.searchParams.get("search[name]")).toBe("light_smile");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("builds related tag search URLs with optional filters", () => {
    const url = new URL(buildRelatedTagsUrl("smile", 12, {
      order: "cosine",
      categories: ["general", "character"],
      searchSampleSize: 2500,
      tagSampleSize: 300,
    }));

    expect(url.pathname).toBe("/related_tag.json");
    expect(url.searchParams.get("query")).toBe("smile");
    expect(url.searchParams.get("limit")).toBe("12");
    expect(url.searchParams.get("order")).toBe("cosine");
    expect(url.searchParams.get("category")).toBe("general,character");
    expect(url.searchParams.get("search_sample_size")).toBe("2500");
    expect(url.searchParams.get("tag_sample_size")).toBe("300");
  });

  it("omits frequency order because it is Danbooru's default", () => {
    const url = new URL(buildRelatedTagsUrl("smile", 8, { order: "frequency" }));
    expect(url.searchParams.get("order")).toBeNull();
  });
});

describe("normalizeRelatedTag", () => {
  it("normalizes Danbooru related_tag.json entries", () => {
    expect(normalizeRelatedTag({
      tag: {
        id: 123,
        name: "light_smile",
        post_count: 456,
        category: 0,
        is_deprecated: false,
      },
      frequency: 0.42,
      cosine_similarity: 0.3,
      jaccard_similarity: 0.2,
      overlap_coefficient: 0.9,
    })).toEqual({
      tag: {
        id: 123,
        name: "light_smile",
        post_count: 456,
        category: 0,
        is_deprecated: false,
      },
      frequency: 0.42,
      cosineSimilarity: 0.3,
      jaccardSimilarity: 0.2,
      overlapCoefficient: 0.9,
    });
  });

  it("returns undefined for entries without a tag name", () => {
    expect(normalizeRelatedTag({ frequency: 0.1 })).toBeUndefined();
  });
});

describe("paint_search_danbooru_tags tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps wildcard tag search as the default mode", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify([
      {
        id: 1,
        name: "smile",
        post_count: 1000,
        category: 0,
        is_deprecated: false,
      },
    ])));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSearchDanbooruTagsTool({} as PaintConfig);
    const result = await tool.execute({ queries: ["smile"], limit: 1 });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/tags.json?");
    expect(result.content[0].text).toContain("**smile**");
    expect(result.details.mode).toBe("name");
  });

  it("uses related_tag.json when mode is related", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      query: "smile",
      post_count: 12000,
      tag: {
        id: 1,
        name: "smile",
        post_count: 1000,
        category: 0,
        is_deprecated: false,
      },
      related_tags: [
        {
          tag: {
            id: 2,
            name: "open_mouth",
            post_count: 500,
            category: 0,
            is_deprecated: false,
          },
          frequency: 0.25,
          cosine_similarity: 0.125,
        },
      ],
      wiki_page_tags: [
        {
          id: 3,
          name: "light_smile",
          post_count: 800,
          category: 0,
          is_deprecated: false,
        },
      ],
    })));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSearchDanbooruTagsTool({} as PaintConfig);
    const result = await tool.execute({
      queries: ["smile"],
      mode: "related",
      order: "cosine",
      categories: ["general"],
      limit: 2,
    });

    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.pathname).toBe("/related_tag.json");
    expect(requested.searchParams.get("query")).toBe("smile");
    expect(requested.searchParams.get("order")).toBe("cosine");
    expect(requested.searchParams.get("category")).toBe("general");
    expect(result.content[0].text).toContain("Posts matched: 12,000");
    expect(result.content[0].text).toContain("**open_mouth**");
    expect(result.content[0].text).toContain("freq 25.0%");
    expect(result.content[0].text).toContain("Wiki page tags:");
    expect(result.details.mode).toBe("related");
  });

  it("reports Danbooru failures instead of false no-match results", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSearchDanbooruTagsTool({} as PaintConfig);
    const result = await tool.execute({ queries: ["smile"], limit: 1 });
    const text = result.content[0].text ?? "";

    expect(text).toContain("Danbooru request failed");
    expect(text).toContain("status 429");
    expect(text).not.toContain("No matching tags found");
  });

  it("reports related-mode Danbooru failures instead of false empty related results", async () => {
    const fetchMock = vi.fn(async () => new Response("temporary outage", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSearchDanbooruTagsTool({} as PaintConfig);
    const result = await tool.execute({ queries: ["smile"], mode: "related", limit: 1 });
    const text = result.content[0].text ?? "";

    expect(text).toContain("Danbooru request failed");
    expect(text).toContain("status 503");
    expect(text).not.toContain("No related tags found");
  });

  it("warns when wildcard input is not exact Danbooru tag spelling", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify([
      {
        id: 1,
        name: "light_smile",
        post_count: 1000,
        category: 0,
        is_deprecated: false,
      },
    ])));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSearchDanbooruTagsTool({} as PaintConfig);
    const result = await tool.execute({ queries: ["light smile"], limit: 1 });
    const text = result.content[0].text ?? "";

    expect(text).toContain("Warning: `light smile` is not exact Danbooru tag spelling. Use `light_smile`.");
    expect(text).toContain("**light_smile**");
  });

  it("warns when name search input is not any exact Danbooru tag", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([])));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSearchDanbooruTagsTool({} as PaintConfig);
    const result = await tool.execute({ queries: ["not_a_real_tag_zzzzzz"], limit: 1 });
    const text = result.content[0].text ?? "";

    expect(text).toContain("Warning: `not_a_real_tag_zzzzzz` was not found as an exact Danbooru tag.");
    expect(text).toContain("No matching tags found.");
  });

  it("warns when related-mode input is not an exact Danbooru tag", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        query: "not_a_real_tag_zzzzzz",
        post_count: 5,
        related_tags: [
          {
            tag: {
              id: 2,
              name: "highres",
              post_count: 7000,
              category: 5,
              is_deprecated: false,
            },
            frequency: 0.5,
          },
        ],
        wiki_page_tags: [],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify([])));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createSearchDanbooruTagsTool({} as PaintConfig);
    const result = await tool.execute({ queries: ["not_a_real_tag_zzzzzz"], mode: "related", limit: 1 });
    const text = result.content[0].text ?? "";

    expect(text).toContain("Warning: `not_a_real_tag_zzzzzz` was not found as an exact Danbooru tag.");
    expect(text).toContain("Related tags are for the submitted search expression.");
    expect(text).toContain("**highres**");
  });
});
