import type { Candidate } from "./types.js";

/** Locate the `_init_data_ = { data: {...} }` blob embedded in an AliExpress search page and return the parsed object. */
export function extractInitData(html: string): any | null {
  // The marker also appears in unrelated bootstrap code (`_init_data_&&(...)`), and a browser-serialised DOM can
  // put that code first, so try every assignment-shaped occurrence until one parses.
  const re = /_init_data_\s*=\s*\{\s*data\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const braceStart = m.index + m[0].length - 1;
    const parsed = parseBalancedJson(html, braceStart);
    if (parsed) return parsed;
  }
  return null;
}

/** Parse the JSON object whose opening brace is at `start`. Balanced-brace scan that respects JSON strings. */
function parseBalancedJson(html: string, start: number): any | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseSold(desc: string | undefined): number | null {
  if (!desc) return null;
  const m = desc.replace(/,/g, "").match(/([\d.]+)\s*(k)?/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Pure parser: search-page HTML -> candidates. */
export function parseSearchHtml(html: string): Candidate[] {
  const data = extractInitData(html);
  const list: any[] = data?.data?.root?.fields?.mods?.itemList?.content ?? [];
  const out: Candidate[] = [];
  for (const it of list) {
    const productId = String(it.productId ?? "");
    const title = it.title?.displayTitle ?? "";
    const price = Number(it.prices?.salePrice?.minPrice);
    if (!productId || !title || !Number.isFinite(price)) continue;
    const img: string = it.image?.imgUrl ?? "";
    out.push({
      productId,
      title,
      price,
      currency: it.prices?.salePrice?.currencyCode ?? "USD",
      rating: typeof it.evaluation?.starRating === "number" ? it.evaluation.starRating : null,
      sold: parseSold(it.trade?.tradeDesc),
      isAd: Boolean(it.p4p),
      imageUrl: img.startsWith("//") ? `https:${img}` : img,
      url: `https://www.aliexpress.com/item/${productId}.html`,
    });
  }
  return out;
}

export function searchUrl(query: string, opts: { sort?: "default" | "price_asc"; page?: number } = {}): string {
  const slug = encodeURIComponent(query.trim().replace(/\s+/g, "-"));
  const u = new URL(`https://www.aliexpress.com/w/wholesale-${slug}.html`);
  if (opts.sort === "price_asc") u.searchParams.set("SortType", "price_asc");
  if (opts.page && opts.page > 1) u.searchParams.set("page", String(opts.page));
  return u.toString();
}

export function mergeCandidates(...lists: Candidate[][]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const list of lists) for (const c of list) if (!seen.has(c.productId)) seen.set(c.productId, c);
  return [...seen.values()];
}
