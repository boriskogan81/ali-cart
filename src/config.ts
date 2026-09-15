import "dotenv/config";
import path from "node:path";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  shipTo: (process.env.SHIP_TO || "IL").toUpperCase(),
  currency: (process.env.CURRENCY || "USD").toUpperCase(),
  minStorePositiveRate: num("MIN_STORE_POSITIVE_RATE", 90),
  minStoreOrders: num("MIN_STORE_ORDERS", 20),
  port: num("PORT", 3000),
  profileDir: path.resolve(process.env.PROFILE_DIR || "./profile"),
  runsDir: path.resolve("./runs"),
  /** How many search result pages to pull per query (relevance sort + price sort each). */
  searchPages: 1,
  /** Cap on listings opened in the browser per row for pricing. */
  maxPricedPerRow: num("MAX_PRICED_PER_ROW", 8),
  model: "claude-opus-5",
};
