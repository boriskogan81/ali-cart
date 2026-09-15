import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { checkLoggedIn, gotoWithChecks, launchBrowser, getPage, manualLogin, pause } from "./browser.js";
import { CART_URL, addToCart } from "./cart.js";
import { config } from "./config.js";
import { isAliExpressLink, resolveLink } from "./links.js";
import { matchCandidates } from "./match.js";
import { notify } from "./notify.js";
import { priceListing } from "./pricing.js";
import { mergeCandidates, parseSearchHtml, searchUrl } from "./search.js";
import { fetchSheetRows } from "./sheet.js";
import type { Candidate, MatchDecision, Priced, RowResult, RunEvent, RunOptions, RunState, SheetRow } from "./types.js";

export class Run extends EventEmitter {
  state: RunState;
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private captchaNotified = false;

  constructor(options: RunOptions) {
    super();
    this.state = {
      id: new Date().toISOString().replace(/[:.]/g, "-"),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      options,
      phase: "starting",
      rows: [],
      totalLanded: 0,
      error: null,
    };
  }

  private emitEvent(ev: RunEvent) {
    this.emit("event", ev);
  }
  private log(message: string) {
    console.log(`[run] ${message}`);
    this.emitEvent({ type: "log", message });
  }
  private setPhase(phase: RunState["phase"], message: string) {
    this.state.phase = phase;
    this.log(message);
    this.emitEvent({ type: "phase", phase, message });
  }
  private updateRow(i: number, patch: Partial<RowResult>) {
    Object.assign(this.state.rows[i], patch);
    this.emitEvent({ type: "row", index: i, result: this.state.rows[i] });
    this.persist();
  }
  private persist() {
    mkdirSync(config.runsDir, { recursive: true });
    writeFileSync(path.join(config.runsDir, `${this.state.id}.json`), JSON.stringify(this.state, null, 2));
  }

  private goto = async (url: string) => {
    if (!this.page) throw new Error("browser not started");
    await gotoWithChecks(this.page, url, async () => {
      if (this.state.phase !== "captcha") this.setPhase("captcha", "AliExpress is showing a bot check. Solve it in the browser window; the run resumes automatically.");
      if (!this.captchaNotified) {
        this.captchaNotified = true;
        notify("ali-cart needs you", "Solve the AliExpress captcha in the browser window.");
      }
    });
    if (this.state.phase === "captcha") {
      this.captchaNotified = false;
      this.setPhase("running", "Bot check cleared, continuing.");
    }
  };

  async start(): Promise<RunState> {
    try {
      await this.execute();
      this.state.phase = "done";
    } catch (err) {
      this.state.error = (err as Error).message;
      this.state.phase = "failed";
      this.log(`Run failed: ${this.state.error}`);
    } finally {
      this.state.finishedAt = new Date().toISOString();
      this.persist();
      this.emitEvent({ type: "done", state: this.state });
    }
    return this.state;
  }

  private async execute() {
    const { sheetUrl, tab, priorities, dryRun } = this.state.options;
    this.log(`Reading sheet tab "${tab}"`);
    const rows = await fetchSheetRows(sheetUrl, tab || null);
    if (rows.length === 0) throw new Error("The sheet tab has no rows with a product and a link.");
    this.state.rows = rows.map((row) => blankResult(row));
    rows.forEach((row, i) => {
      const only = this.state.options.rows;
      if (only && only.length && !only.includes(row.rowNumber)) this.state.rows[i] = { ...this.state.rows[i], status: "skipped", message: "not in the selected rows" };
      else if (row.priority && !priorities.includes(row.priority)) this.state.rows[i] = { ...this.state.rows[i], status: "skipped", message: `priority ${row.priority} not selected` };
      else if (!/aliexpress\./i.test(row.link) && !/s\.click\./i.test(row.link)) this.state.rows[i] = { ...this.state.rows[i], status: "skipped", message: "not an AliExpress link" };
    });
    this.persist();
    this.state.rows.forEach((r, i) => this.emitEvent({ type: "row", index: i, result: r }));

    this.setPhase("starting", "Launching browser");
    this.ctx = await launchBrowser();
    this.page = await getPage(this.ctx);
    if (dryRun) this.log("Dry run: not waiting for AliExpress login (search, matching and pricing work signed out).");
    else await this.ensureLoggedIn();
    this.setPhase("running", `${dryRun ? "Browser ready" : "Signed in"}. Processing ${this.state.rows.filter((r) => r.status === "pending").length} rows${dryRun ? " (dry run, nothing is added to the cart)" : ""}.`);

    let processed = 0;
    for (let i = 0; i < this.state.rows.length; i++) {
      if (this.state.rows[i].status !== "pending") continue;
      if (this.state.options.limit && processed >= this.state.options.limit) {
        this.updateRow(i, { status: "skipped", message: `row limit ${this.state.options.limit} reached` });
        continue;
      }
      await this.processRow(i);
      processed++;
      await pause();
    }

    this.state.totalLanded = this.state.rows.reduce((sum, r) => sum + (r.chosen?.landedTotal ?? 0), 0);
    const ok = this.state.rows.filter((r) => r.status === "ok").length;
    const problems = this.state.rows.filter((r) => r.status === "no-match" || r.status === "error").length;
    if (!dryRun) {
      await this.goto(CART_URL).catch(() => {});
      notify("ali-cart: cart is ready", `${ok} items added, ${problems} need attention. Total about ${config.currency} ${this.state.totalLanded.toFixed(2)}. Review and check out.`);
    } else {
      notify("ali-cart: dry run finished", `${ok} matched, ${problems} need attention. Nothing was added to the cart.`);
    }
    this.log(`Finished. ${ok} ok, ${problems} need attention, landed total ${config.currency} ${this.state.totalLanded.toFixed(2)}.`);
  }

  /** Sign-in happens in a plain (non-automated) Chrome on the same profile, because AliExpress's slider blocks automated browsers. */
  private async ensureLoggedIn() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await checkLoggedIn(this.page!)) return;
      this.setPhase("login", "A separate Chrome window is opening. Sign in to AliExpress there, then CLOSE that window; the run continues by itself.");
      notify("ali-cart needs you", "Sign in to AliExpress in the Chrome window that just opened, then close it.");
      await this.ctx!.close();
      await manualLogin();
      this.ctx = await launchBrowser();
      this.page = await getPage(this.ctx);
    }
    throw new Error("Still not signed in to AliExpress after three attempts.");
  }

  private async processRow(i: number) {
    const result = this.state.rows[i];
    const row = result.row;
    this.updateRow(i, { status: "running", message: "resolving link" });
    try {
      let resolved = await resolveLink(row.link, config.shipTo, config.currency);
      if (resolved.kind === "external" && isAliExpressLink(row.link)) {
        // The short link would not resolve (rate limited or changed); search by the product name instead.
        this.log(`Row ${row.rowNumber}: could not resolve ${row.link}, searching by product name`);
        resolved = { kind: "search", query: row.product.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim(), finalUrl: row.link };
      }
      this.updateRow(i, { resolved });
      if (resolved.kind === "external" || resolved.kind === "none") {
        this.updateRow(i, { status: "skipped", message: "link does not lead to an AliExpress search or item" });
        return;
      }

      let seed: Candidate | null = null;
      let query: string;
      if (resolved.kind === "item") {
        seed = await this.seedFromItem(resolved.itemId);
        query = seed?.title ? shortenTitle(seed.title) : row.product;
      } else query = resolved.query;
      this.updateRow(i, { query, message: `searching "${query}"` });

      let candidates = await this.search(query);
      if (seed) candidates = mergeCandidates([seed], candidates);
      this.updateRow(i, { candidates, message: `matching ${candidates.length} listings` });

      let { matches, betterQuery } = await matchCandidates(row, query, candidates);
      if (matches.length === 0 && betterQuery && betterQuery.toLowerCase() !== query.toLowerCase()) {
        this.log(`Row ${row.rowNumber}: no match for "${query}", retrying with "${betterQuery}"`);
        query = betterQuery;
        candidates = mergeCandidates(candidates, await this.search(betterQuery));
        ({ matches } = await matchCandidates(row, query, candidates));
        this.updateRow(i, { query, candidates });
      }
      this.updateRow(i, { matches });
      if (matches.length === 0) {
        this.updateRow(i, { status: "no-match", message: "no listing matched the product; buy this one by hand" });
        return;
      }

      const toPrice = pickForPricing(candidates, matches, config.maxPricedPerRow);
      const priced: Priced[] = [];
      for (const [candidate, decision] of toPrice) {
        this.updateRow(i, { message: `pricing ${priced.length + 1}/${toPrice.length}: ${candidate.productId}` });
        try {
          priced.push(await priceListing(this.page!, candidate, decision, row.qty, row.estPrice, this.goto));
        } catch (err) {
          priced.push({
            productId: candidate.productId,
            url: candidate.url,
            title: candidate.title,
            variant: null,
            skuId: null,
            unitPrice: candidate.price,
            shipping: null,
            shippingNote: "",
            landedPerUnit: candidate.price,
            landedTotal: candidate.price * row.qty,
            storeName: null,
            storePositiveRate: null,
            storeOrders: candidate.sold,
            storeFollowers: null,
            rejected: `page error: ${(err as Error).message.split("\n")[0]}`,
          });
        }
        this.updateRow(i, { priced: [...priced] });
        await pause(600, 1500);
      }
      const eligible = priced.filter((p) => !p.rejected).sort((a, b) => a.landedTotal - b.landedTotal);
      const chosen = eligible[0] ?? null;
      if (!chosen) {
        this.updateRow(i, { status: "no-match", message: `all ${priced.length} matched listings were rejected by guardrails` });
        return;
      }
      this.updateRow(i, { chosen, message: `cheapest: ${config.currency} ${chosen.landedTotal.toFixed(2)} landed for ${row.qty}` });

      if (this.state.options.dryRun) {
        this.updateRow(i, { status: "ok", message: `dry run: would add ${row.qty} x ${chosen.productId}` });
        return;
      }
      this.updateRow(i, { message: "adding to cart" });
      await addToCart(this.page!, chosen, row.qty, this.goto);
      this.updateRow(i, { status: "ok", cartAdded: true, message: `added ${row.qty} x ${chosen.productId} to cart` });
    } catch (err) {
      this.updateRow(i, { status: "error", message: (err as Error).message.split("\n")[0] });
    }
  }

  private async search(query: string): Promise<Candidate[]> {
    const lists: Candidate[][] = [];
    for (const sort of ["default", "price_asc"] as const) {
      await this.goto(searchUrl(query, { sort }));
      const html = await this.page!.content();
      lists.push(parseSearchHtml(html));
      await pause(500, 1200);
    }
    return mergeCandidates(...lists);
  }

  private async seedFromItem(itemId: string): Promise<Candidate | null> {
    await this.goto(`https://www.aliexpress.com/item/${itemId}.html`);
    await this.page!.waitForSelector('h1[data-pl="product-title"], [class*="price-default--current"]', { timeout: 20_000 }).catch(() => {});
    const info = await this.page!.evaluate(() => ({
      title:
        (document.querySelector('h1[data-pl="product-title"]') as HTMLElement | null)?.innerText.trim() ||
        document.title.replace(/\s*-\s*AliExpress.*$/i, "").trim(),
      price: (document.querySelector('[class*="price-default--current"]') as HTMLElement | null)?.innerText ?? "",
    }));
    const price = Number(info.price.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
    if (!info.title || /^aliexpress$/i.test(info.title)) return null;
    return { productId: itemId, title: info.title, price: Number.isFinite(price) ? price : 0, currency: config.currency, rating: null, sold: null, isAd: false, imageUrl: "", url: `https://www.aliexpress.com/item/${itemId}.html` };
  }

  async close() {
    await this.ctx?.close().catch(() => {});
  }
}

export function blankResult(row: SheetRow): RowResult {
  return { row, status: "pending", message: "", resolved: null, query: null, candidates: [], matches: [], priced: [], chosen: null, cartAdded: false };
}

/** Cheapest-first list of (candidate, decision) pairs to open, capped. High-confidence matches go first within the cap. */
export function pickForPricing(candidates: Candidate[], matches: MatchDecision[], cap: number): [Candidate, MatchDecision][] {
  const byId = new Map(candidates.map((c) => [c.productId, c]));
  const pairs = matches.map((m) => [byId.get(m.productId)!, m] as [Candidate, MatchDecision]).filter(([c]) => !!c);
  pairs.sort((a, b) => a[0].price - b[0].price);
  const high = pairs.filter(([, m]) => m.confidence === "high");
  const medium = pairs.filter(([, m]) => m.confidence === "medium");
  return [...high, ...medium].slice(0, cap);
}

export function shortenTitle(title: string): string {
  return title.split(/[,|(\-–]/)[0].split(/\s+/).slice(0, 8).join(" ");
}
