// Quick price survey over plain HTTP: for each query, fetch the AliExpress search page (relevance + price sort),
// parse the embedded JSON, and print the cheapest listings whose title matches the given keywords.
// Usage: pnpm tsx scripts/quote.mjs "query|must,have,keywords" ...
import { parseSearchHtml, searchUrl, mergeCandidates } from "../src/search.ts";
import { UA, localeCookie } from "../src/links.ts";

const shipTo = process.env.SHIP_TO || "IL";
const currency = process.env.CURRENCY || "USD";

async function fetchSearch(query, sort) {
  const res = await fetch(searchUrl(query, { sort }), {
    headers: { "User-Agent": UA, Cookie: localeCookie(shipTo, currency), Accept: "text/html" },
    signal: AbortSignal.timeout(60_000),
  });
  return parseSearchHtml(await res.text());
}

for (const spec of process.argv.slice(2)) {
  const [query, kw = ""] = spec.split("|");
  const keys = kw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  try {
    const all = mergeCandidates(await fetchSearch(query, "default"), await fetchSearch(query, "price_asc"));
    const hits = all.filter((c) => keys.every((k) => c.title.toLowerCase().includes(k)));
    console.log(`\n== ${query}  (${all.length} results, ${hits.length} match "${kw}")`);
    for (const c of hits.sort((a, b) => a.price - b.price).slice(0, 8))
      console.log(`  ${c.productId} ${currency} ${c.price.toFixed(2).padStart(7)} | sold ${String(c.sold ?? "-").padStart(5)} | ${c.rating ?? "-"}★ | ${c.title.slice(0, 80)}`);
  } catch (err) {
    console.log(`\n== ${query}: ERROR ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
}
