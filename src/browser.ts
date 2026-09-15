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
        ignoreDefaultArgs: ["--enable-automation"],
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

export async function gotoWithChecks(page: Page, url: string, onBlocked: (kind: "captcha") => Promise<void>): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(800);
  while (await isCaptcha(page)) {
    await onBlocked("captcha");
    await page.waitForTimeout(3000);
  }
}

export async function waitForLogin(page: Page, onWaiting: () => Promise<void>, pollMs = 3000): Promise<void> {
  await page.goto("https://www.aliexpress.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2000);
  if (await isLoggedIn(page)) return;
  await onWaiting();
  // Take the user straight to the login screen; they finish it by hand in the visible window.
  await page.goto("https://login.aliexpress.com/", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  for (;;) {
    await page.waitForTimeout(pollMs);
    if (/login\.aliexpress/i.test(page.url())) continue;
    if (await isLoggedIn(page)) return;
  }
}

/** Human-ish pause between AliExpress requests. */
export function pause(min = 1200, max = 3200): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}
