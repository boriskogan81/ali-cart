import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";

export type BrowserChannel = "chrome" | "msedge" | "chromium";

/**
 * A single persistent, headed browser context. The profile directory keeps the user's AliExpress login
 * between runs. System Chrome is preferred (looks like a normal browser to AliExpress), then Edge, then the
 * Playwright-bundled Chromium.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  const order: BrowserChannel[] = (process.env.BROWSER_CHANNEL as BrowserChannel | undefined)
    ? [process.env.BROWSER_CHANNEL as BrowserChannel]
    : ["chrome", "msedge", "chromium"];
  let lastErr: unknown;
  for (const channel of order) {
    try {
      const ctx = await chromium.launchPersistentContext(config.profileDir, {
        headless: false,
        channel: channel === "chromium" ? undefined : channel,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        ignoreDefaultArgs: ["--enable-automation", "--no-sandbox"],
      });
      // tsx/esbuild wraps inner functions of page.evaluate callbacks in a `__name` helper that does not exist
      // inside the page; define a no-op so those callbacks run.
      await ctx.addInitScript("window.__name = window.__name || function (fn) { return fn; };");
      await ctx.addCookies([
        { name: "aep_usuc_f", value: `site=glo&c_tp=${config.currency}&region=${config.shipTo}&b_locale=en_US`, domain: ".aliexpress.com", path: "/" },
        { name: "intl_locale", value: "en_US", domain: ".aliexpress.com", path: "/" },
      ]);
      return ctx;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Could not launch a browser (tried ${order.join(", ")}): ${(lastErr as Error)?.message}`);
}

export async function getPage(ctx: BrowserContext): Promise<Page> {
  return ctx.pages()[0] ?? (await ctx.newPage());
}

/** True when the page is an AliExpress bot-check / slider captcha / "punish" page. */
export async function isCaptcha(page: Page): Promise<boolean> {
  const url = page.url();
  if (/punish|_____tmd_____|captcha/i.test(url)) return true;
  return page
    .evaluate(() => !!document.querySelector("#nc_1_n1z, .nc-container, #baxia-dialog-content, .baxia-dialog, [id^='baxia']"))
    .catch(() => false);
}

/** True when the AliExpress header shows an account rather than "Sign in". */
export async function isLoggedIn(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const header = (document.querySelector("header") ?? document.body).innerText;
      if (/Sign in \/ Register|Sign in|Register/i.test(header)) return false;
      return /Welcome|Account|Hi,/i.test(header) || !!document.cookie.match(/(^|;\s*)xman_t=/);
    })
    .catch(() => false);
}

/** "We have detected unusual traffic from your network" - a temporary rate limit, not a puzzle the user can solve. */
export async function isRateLimited(page: Page): Promise<boolean> {
  return page.evaluate(() => /unusual traffic from your network/i.test(document.body?.innerText ?? "")).catch(() => false);
}

const BACKOFF_MS = [120_000, 300_000, 600_000, 900_000];

export async function gotoWithChecks(page: Page, url: string, onBlocked: (kind: "captcha" | "rate-limit", waitMs: number) => Promise<void>): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(800);
  let backoff = 0;
  for (;;) {
    if (await isRateLimited(page)) {
      if (backoff >= BACKOFF_MS.length) throw new Error("AliExpress is rate-limiting this network; try again in an hour");
      const wait = BACKOFF_MS[backoff++];
      await onBlocked("rate-limit", wait);
      await page.waitForTimeout(wait);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }
    if (await isCaptcha(page)) {
      await onBlocked("captcha", 3000);
      await page.waitForTimeout(3000);
      continue;
    }
    return;
  }
}

/** Robust check: the account page redirects to the login page when signed out. */
export async function checkLoggedIn(page: Page): Promise<boolean> {
  await page.goto("https://www.aliexpress.com/p/account/index.html", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (/login|passport|ug-login/i.test(page.url())) return false;
  if (/\/p\/account/i.test(page.url())) return true;
  await page.goto("https://www.aliexpress.com/", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return isLoggedIn(page);
}

const CHROME_PATHS: Record<Exclude<BrowserChannel, "chromium">, string[]> = {
  chrome: [
    `${process.env["ProgramFiles"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  msedge: [
    `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env["ProgramFiles"] ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
};

export function findPlainBrowser(): string | null {
  const order: ("chrome" | "msedge")[] = process.env.BROWSER_CHANNEL === "msedge" ? ["msedge", "chrome"] : ["chrome", "msedge"];
  for (const ch of order) for (const p of CHROME_PATHS[ch]) if (existsSync(p)) return p;
  return null;
}

/**
 * AliExpress's login slider refuses to pass inside an automated browser. So for the sign-in itself we open the
 * SAME profile folder in plain, non-automated Chrome, let the user log in by hand, and wait for that window to
 * close. The cookies then carry over to the automated session. The Playwright context must be closed first,
 * because Chrome will not open a profile that is already in use.
 */
export async function manualLogin(): Promise<void> {
  const exe = findPlainBrowser();
  if (!exe) throw new Error("Could not find Google Chrome or Microsoft Edge to open the sign-in window.");
  const child = spawn(
    exe,
    [`--user-data-dir=${config.profileDir}`, "--no-first-run", "--no-default-browser-check", "--new-window", "https://login.aliexpress.com/"],
    { detached: false, stdio: "ignore" },
  );
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

/** Human-ish pause between AliExpress requests, scaled by PACE (default 1; 2 = twice as slow). */
export function pause(min = 2500, max = 6000): Promise<void> {
  const scale = Number(process.env.PACE) || 1;
  return new Promise((r) => setTimeout(r, scale * (min + Math.random() * (max - min))));
}
