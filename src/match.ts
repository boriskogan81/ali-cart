import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import type { Candidate, MatchDecision, SheetRow } from "./types.js";

const MatchSchema = z.object({
  matches: z.array(
    z.object({
      productId: z.string(),
      confidence: z.enum(["high", "medium"]),
      variant: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  betterQuery: z.string().nullable(),
});

const SYSTEM = `You match rows of an FPV drone parts shopping list against AliExpress search results.

You are given one shopping-list row (part, product, notes, quantity) and a numbered list of AliExpress listings (id, price, title).
Decide which listings sell the SAME product the row asks for: same brand, same model, same spec (e.g. KV, size, voltage rating, count in a set, connector type).
Rules:
- Only include a listing when the title clearly identifies the requested product. Generic or unbranded lookalikes do not match a branded request (e.g. "TBS Source One V5" also matches "Source One V5" clones only if the row's notes say clones are acceptable; the Source One is open-source hardware, so unbranded Source One V5 frames DO match).
- If the requested product is a specification rather than a brand (e.g. "Low-ESR 1000uF 35V+ electrolytic capacitor", "63/37 rosin-core solder 0.8mm", "20mm x 250mm battery straps"), match listings that satisfy the spec.
- Many listings sell several variants in one page (e.g. "1700KV 1900KV 2400KV", "with/without receiver", "1pc/4pcs"). Include those and put the variant the row needs into "variant" as a short label the buyer would pick on the page (e.g. "1900KV", "RHCP SMA", "4pcs", "6S 1300mAh").
- If a listing's title makes the price look like it is for a single piece when the row wants a set (or vice versa), still include it but say so in "reason".
- Exclude accessories, spare parts, cases, cables, or stickers for the product unless the row asks for those.
- confidence "high" = certain it is the product; "medium" = probably, title is ambiguous.
- If nothing matches, return an empty list and, when a different search phrase would likely find the product, suggest it in "betterQuery" (otherwise null).
Be strict: a wrong match costs the buyer money; a missed match only costs a manual search.`;

export function buildMatchPrompt(row: SheetRow, query: string, candidates: Candidate[]): string {
  const lines = candidates.map((c) => `${c.productId} | ${c.currency} ${c.price.toFixed(2)} | ${c.title}`);
  return [
    `Shopping-list row (section: ${row.section || "n/a"}):`,
    `Part: ${row.part}`,
    `Product: ${row.product}`,
    `Notes: ${row.notes || "none"}`,
    `Quantity wanted: ${row.qty}`,
    `Search query used: ${query}`,
    ``,
    `Listings (id | price | title):`,
    ...lines,
  ].join("\n");
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Fallback matcher used when ALI_CART_MATCHER=keyword (no API key): every listing whose title contains all the
 * distinctive tokens of the product name (model numbers, brand) counts as a medium-confidence match.
 * It is much dumber than the Claude matcher; use it only to exercise the pipeline.
 */
export function keywordMatch(row: SheetRow, candidates: Candidate[]): MatchDecision[] {
  const tokens = row.product
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
  const key = tokens.filter((t) => /\d/.test(t) || t.length >= 4).slice(0, 4);
  if (key.length === 0) return [];
  return candidates
    .filter((c) => {
      const title = c.title.toLowerCase();
      return key.every((t) => title.includes(t));
    })
    .map((c) => ({ productId: c.productId, confidence: "medium" as const, variant: null, reason: `title contains ${key.join(", ")}` }));
}
const STOP = new Set(["the", "and", "with", "for", "set", "pack", "kit", "inch", "buy", "pcs", "piece", "pieces"]);

export async function matchCandidates(row: SheetRow, query: string, candidates: Candidate[]): Promise<{ matches: MatchDecision[]; betterQuery: string | null }> {
  if (candidates.length === 0) return { matches: [], betterQuery: null };
  if (process.env.ALI_CART_MATCHER === "keyword") return { matches: keywordMatch(row, candidates), betterQuery: null };
  const response = await getClient().messages.parse({
    model: config.model,
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildMatchPrompt(row, query, candidates) }],
    output_config: { format: zodOutputFormat(MatchSchema), effort: "medium" },
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`Matcher returned no parseable output (stop_reason=${response.stop_reason})`);
  const known = new Set(candidates.map((c) => c.productId));
  return {
    matches: parsed.matches.filter((m) => known.has(m.productId)),
    betterQuery: parsed.betterQuery,
  };
}
