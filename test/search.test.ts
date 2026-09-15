import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeCandidates, parseSearchHtml, searchUrl } from "../src/search.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, "fixtures/search-source-one-v5.html"), "utf8");

describe("search parser", () => {
  it("extracts candidates from a saved search page", () => {
    const c = parseSearchHtml(html);
    expect(c.length).toBeGreaterThan(40);
    const first = c[0];
    expect(first.productId).toMatch(/^\d+$/);
    expect(first.title).toMatch(/source one/i);
    expect(first.currency).toBe("USD");
    expect(first.price).toBeGreaterThan(0);
    expect(first.url).toBe(`https://www.aliexpress.com/item/${first.productId}.html`);
    expect(c.some((x) => x.isAd)).toBe(true);
    expect(c.some((x) => x.sold !== null)).toBe(true);
  });
  it("returns nothing for non-search html", () => {
    expect(parseSearchHtml("<html></html>")).toEqual([]);
  });
  it("builds search urls", () => {
    expect(searchUrl("emax eco ii 2207")).toBe("https://www.aliexpress.com/w/wholesale-emax-eco-ii-2207.html");
    expect(searchUrl("x y", { sort: "price_asc", page: 2 })).toContain("SortType=price_asc");
  });
  it("dedupes merged candidate lists", () => {
    const c = parseSearchHtml(html);
    expect(mergeCandidates(c, c).length).toBe(c.length);
  });
});
