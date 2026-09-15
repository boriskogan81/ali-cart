import type { Page } from "playwright";
import { config } from "./config.js";
import type { Candidate, MatchDecision, Priced } from "./types.js";

export interface PageSnapshot {
  price: number | null;
  shipping: number | null;
  shippingNote: string;
  storeName: string | null;
  storePositiveRate: number | null;
  soldCount: number | null;
  storeSold: number | null;
  storeFollowers: number | null;
  skuGroups: { title: string; options: { label: string; selected: boolean; selector: string }[] }[];
  skuId: string | null;
  unavailable: string | null;
}

export function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function parseShipping(text: string): { shipping: number | null; note: string } {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return { shipping: null, note: "no shipping info" };
  if (/free shipping|shipping:\s*free|free\b/i.test(t) && !/\$\s*\d/.test(t.split(/delivery/i)[0])) return { shipping: 0, note: t };
  if (/can't be shipped|cannot be shipped|not available|doesn't ship|does not ship|unavailable/i.test(t)) return { shipping: null, note: t };
  const head = t.split(/delivery/i)[0];
  const money = parseMoney(head);
  return { shipping: money, note: t };
}

export function parsePositiveRate(text: string | null): number | null {
  const m = text?.match(/(\d+(?:\.\d+)?)\s*%\s*positive/i);
  return m ? Number(m[1]) : null;
}

/** Store-level sales shown next to the store name as "(4.8 | 2,000+ sold)". */
export function parseStoreSold(text: string | null): number | null {
  const m = text?.replace(/,/g, "").match(/\(\s*[\d.]+\s*\|\s*(\d+(?:\.\d+)?)\s*(k)?\+?\s*sold\s*\)/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

export function parseFollowers(text: string | null): number | null {
  const m = text?.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k)?\+?\s*Followers/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

export function parseSold(text: string | null): number | null {
  const m = text?.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k)?\+?\s*sold/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

/** Read everything we need off the currently loaded item page. */
export async function snapshotItemPage(page: Page): Promise<PageSnapshot> {
  const raw = await page.evaluate(() => {
    const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
    const txt = (sel: string) => q(sel)?.innerText?.trim() ?? null;
    const groups = [...document.querySelectorAll('[class*="sku-item--property"]')].map((g, gi) => {
      const title = (g.querySelector('[class*="sku-item--title"]') as HTMLElement | null)?.innerText.trim() ?? "";
      const options = [...g.querySelectorAll("[data-sku-col]")].map((o) => {
        const el = o as HTMLElement;
        const label = el.getAttribute("title") || (el.querySelector("img") as HTMLImageElement | null)?.alt || el.innerText.trim();
        return {
          label,
          selected: /selected/i.test(el.className),
          selector: `[data-sku-col="${el.getAttribute("data-sku-col")}"]`,
        };
      });
      return { title, options, gi };
    });
    const bodyHead = document.body.innerText.slice(0, 4000);
    return {
      price: txt('[class*="price-default--current"]'),
      shipping: txt(".dynamic-shipping") ?? txt('[class*="shipping--content"]'),
      storeName: txt('[class*="store-detail--storeName"]') ?? txt('[class*="store-info--name"]'),
      storeInfo: txt('[class*="store-info--desc"]') ?? txt('[class*="store-info--wrap"]'),
      soldLine: bodyHead.match(/[^\n]*\bsold\b[^\n]*/i)?.[0] ?? null,
      storeLine: bodyHead.match(/\(\s*[\d.]+\s*\|[^)]*sold[^)]*\)/i)?.[0] ?? null,
      groups,
      unavailable: bodyHead.match(/(This product is no longer available|Sorry, this item is no longer available|can't be shipped to|cannot be shipped to)[^\n]*/i)?.[0] ?? null,
      skuId: new URL(location.href).searchParams.get("sku_id"),
    };
  });
  const ship = parseShipping(raw.shipping ?? "");
  return {
    price: parseMoney(raw.price),
    shipping: ship.shipping,
    shippingNote: ship.note,
    storeName: raw.storeName?.split("\n")[0].trim() ?? null,
    storePositiveRate: parsePositiveRate(raw.storeInfo),
    soldCount: parseSold(raw.soldLine),
    storeSold: parseStoreSold(raw.storeLine),
    storeFollowers: parseFollowers(raw.storeInfo),
    skuGroups: raw.groups.map((g) => ({ title: g.title.replace(/:.*$/, "").trim(), options: g.options })),
    skuId: raw.skuId,
    unavailable: raw.unavailable,
  };
}

/** Score how well an option label matches the variant hint. Higher is better; 0 means no overlap. */
export function variantScore(label: string, hint: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
  const l = norm(label);
  const h = norm(hint);
  if (!l || !h) return 0;
  if (l === h) return 100;
  if (l.includes(h) || h.includes(l)) return 60;
  const lt = new Set(l.split(" "));
  const ht = h.split(" ");
  const hits = ht.filter((t) => lt.has(t)).length;
  return hits === 0 ? 0 : (40 * hits) / ht.length;
}

/** Click the SKU options that best match the variant hint (one per option group when there is a decent match). */
export async function selectVariant(page: Page, hint: string | null): Promise<string | null> {
  if (!hint) return null;
  let snap = await snapshotItemPage(page);
  const picked: string[] = [];
  for (const group of snap.skuGroups) {
    let best: { label: string; selector: string; score: number } | null = null;
    for (const o of group.options) {
      const s = variantScore(o.label, hint);
      if (s > (best?.score ?? 0)) best = { label: o.label, selector: o.selector, score: s };
    }
    if (best && best.score >= 30) {
      const already = group.options.find((o) => o.selected)?.label === best.label;
      if (!already) {
        await page.click(best.selector, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
      picked.push(best.label);
    }
  }
  if (picked.length === 0) return null;
  snap = await snapshotItemPage(page);
  return picked.join(" / ");
}

export function guardrailReason(snap: PageSnapshot, candidate: Candidate, estPrice: number | null, qty: number): string | null {
  if (snap.unavailable) return snap.unavailable;
  if (snap.price === null) return "no price found on page";
  if (snap.shipping === null) return `no shipping to ${config.shipTo}: ${snap.shippingNote}`;
  if (snap.storePositiveRate !== null && snap.storePositiveRate < config.minStorePositiveRate)
    return `store feedback ${snap.storePositiveRate}% < ${config.minStorePositiveRate}%`;
  // Store track record: store-level sales first, then followers as a proxy, then the listing's own sales.
  const orders = snap.storeSold ?? snap.soldCount ?? candidate.sold;
  const established =
    (orders !== null && orders >= config.minStoreOrders) || (snap.storeFollowers !== null && snap.storeFollowers >= config.minStoreOrders * 10);
  if (!established) {
    if (orders === null && snap.storeFollowers === null) return "store has no visible sales or followers";
    return `store has ${orders ?? 0} sales / ${snap.storeFollowers ?? 0} followers (< ${config.minStoreOrders} sales)`;
  }
  if (estPrice && estPrice > 0) {
    const landed = snap.price * qty + snap.shipping;
    const cap = Math.max(estPrice * config.maxPriceMultiple, estPrice + 40);
    if (landed > cap) return `landed ${landed.toFixed(2)} is over ${config.maxPriceMultiple}x the sheet estimate (${estPrice})`;
  }
  return null;
}

/** Open a matched listing, select the variant, and read its landed cost. */
export async function priceListing(
  page: Page,
  candidate: Candidate,
  decision: MatchDecision,
  qty: number,
  estPrice: number | null,
  goto: (url: string) => Promise<void>,
  fallbackHint: string | null = null,
): Promise<Priced> {
  await goto(candidate.url);
  await page.waitForSelector('[class*="price-default--current"], [class*="store-detail"]', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // When the matcher gave no variant hint but the page has option pickers, fall back to the product name itself
  // (e.g. "CNHL 6S 1100-1300mAh" picks the "6S 1300mAh" option) rather than trusting the page default.
  let variant = await selectVariant(page, decision.variant);
  if (!variant && fallbackHint) {
    const groups = (await snapshotItemPage(page)).skuGroups;
    if (groups.some((g) => g.options.length > 1)) variant = await selectVariant(page, fallbackHint);
  }
  const snap = await snapshotItemPage(page);
  const rejected = guardrailReason(snap, candidate, estPrice, qty);
  const unit = snap.price ?? candidate.price;
  const ship = snap.shipping ?? 0;
  return {
    productId: candidate.productId,
    url: page.url().split("?")[0],
    title: candidate.title,
    variant,
    skuId: snap.skuId,
    unitPrice: unit,
    shipping: snap.shipping,
    shippingNote: snap.shippingNote,
    landedPerUnit: Math.round((unit + ship) * 100) / 100,
    // Shipping is charged once per listing; AliExpress usually does not scale it with quantity for small parts.
    landedTotal: Math.round((unit * qty + ship) * 100) / 100,
    storeName: snap.storeName,
    storePositiveRate: snap.storePositiveRate,
    storeOrders: snap.storeSold ?? snap.soldCount ?? candidate.sold,
    storeFollowers: snap.storeFollowers,
    rejected,
  };
}
