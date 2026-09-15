import { describe, expect, it } from "vitest";
import { pickForPricing, shortenTitle } from "../src/pipeline.js";
import { parseMoney, parsePositiveRate, parseShipping, parseSold, variantScore } from "../src/pricing.js";
import type { Candidate, MatchDecision } from "../src/types.js";

describe("pricing parsers", () => {
  it("reads money", () => {
    expect(parseMoney("US $59.27")).toBe(59.27);
    expect(parseMoney("US $1,234.50")).toBe(1234.5);
    expect(parseMoney("")).toBeNull();
  });
  it("reads shipping lines", () => {
    expect(parseShipping("Standard: US $8.39 \nDelivery: Sep. 24 - Oct. 09")).toMatchObject({ shipping: 8.39 });
    expect(parseShipping("Free shipping\nDelivery: Sep. 24 - Oct. 09")).toMatchObject({ shipping: 0 });
    expect(parseShipping("This item can't be shipped to Israel")).toMatchObject({ shipping: null });
    expect(parseShipping("")).toMatchObject({ shipping: null });
  });
  it("reads store feedback and sold counts", () => {
    expect(parsePositiveRate("SkyNova Drone Parts Store\n96.4% Positive Feedback | 8 Followers")).toBe(96.4);
    expect(parsePositiveRate(null)).toBeNull();
    expect(parseSold("by Small Digital World ... (4.8 | 2,000+ sold )")).toBe(2000);
    expect(parseSold("16 sold")).toBe(16);
    expect(parseSold("1.2k sold")).toBe(1200);
  });
  it("scores variant labels", () => {
    expect(variantScore("1900KV", "1900KV")).toBe(100);
    expect(variantScore("2207 1900KV 4PCS", "1900KV")).toBe(60);
    expect(variantScore("2400KV", "1900KV")).toBe(0);
    expect(variantScore("RHCP SMA Black", "SMA RHCP")).toBeGreaterThan(0);
  });
});

describe("pipeline helpers", () => {
  const c = (id: string, price: number): Candidate => ({ productId: id, title: id, price, currency: "USD", rating: null, sold: null, isAd: false, imageUrl: "", url: "" });
  const m = (id: string, confidence: "high" | "medium"): MatchDecision => ({ productId: id, confidence, variant: null, reason: "" });
  it("prices high-confidence matches first, cheapest first, capped", () => {
    const picks = pickForPricing([c("a", 30), c("b", 10), c("c", 20), c("d", 5)], [m("a", "high"), m("b", "medium"), m("c", "high"), m("d", "medium"), m("zzz", "high")], 3);
    expect(picks.map(([x]) => x.productId)).toEqual(["c", "a", "d"]);
  });
  it("shortens titles into search queries", () => {
    expect(shortenTitle("EMAX ECO II Series 2207/2306 FPV Brushless Motor 1700KV 1900KV, for RC Drone")).toBe("EMAX ECO II Series 2207/2306 FPV Brushless Motor");
  });
});

describe("store-level stats", () => {
  it("reads store sales and followers", async () => {
    const { parseFollowers, parseStoreSold } = await import("../src/pricing.js");
    expect(parseStoreSold("by Small Digital World ... (4.8 | 2,000+ sold )")).toBe(2000);
    expect(parseStoreSold("1 sold")).toBeNull();
    expect(parseFollowers("SkyNova Drone Parts Store\n0.0% Positive Feedback | 8 Followers")).toBe(8);
    expect(parseFollowers("93.6% Positive Feedback | 2,308 Followers")).toBe(2308);
  });
});
