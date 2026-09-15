import type { Page } from "playwright";
import { selectVariant } from "./pricing.js";
import type { Priced } from "./types.js";

export const CART_URL = "https://www.aliexpress.com/p/shoppingcart/index.html";

async function setQuantity(page: Page, qty: number): Promise<void> {
  const input = page.locator('[class*="quantity--picker"] input').first();
  if ((await input.count()) === 0) return;
  await input.click({ clickCount: 3 });
  await input.fill(String(qty));
  await input.press("Tab");
  await page.waitForTimeout(600);
}

/** Add the currently chosen listing to the cart. Assumes the page is already on the item URL. */
export async function addToCart(page: Page, chosen: Priced, qty: number, goto: (url: string) => Promise<void>): Promise<void> {
  if (page.url().split("?")[0] !== chosen.url) await goto(chosen.url);
  await page.waitForSelector('button[class*="add-to-cart--addtocart"]', { timeout: 20_000 });
  if (chosen.variant) await selectVariant(page, chosen.variant);
  await setQuantity(page, qty);
  const before = await cartCount(page);
  await page.click('button[class*="add-to-cart--addtocart"]');
  // Success shows a "Added to cart" toast / side cart, and the header count goes up.
  const ok = await Promise.race([
    page.waitForSelector("text=/added to (your )?cart/i", { timeout: 15_000 }).then(() => true),
    page.waitForFunction((b) => {
      const el = document.querySelector('[class*="shop-cart--number"]') as HTMLElement | null;
      return el && Number(el.innerText.replace(/\D/g, "")) > b;
    }, before, { timeout: 15_000 }).then(() => true),
    page.waitForURL(/login\.aliexpress/i, { timeout: 15_000 }).then(() => "login" as const),
  ]).catch(() => false);
  if (ok === "login") throw new Error("AliExpress asked for login while adding to cart");
  if (!ok) {
    // Some variants require every option to be chosen; surface the page's own complaint if there is one.
    const complaint = await page.evaluate(() => document.body.innerText.match(/please select[^\n]*/i)?.[0] ?? null).catch(() => null);
    throw new Error(complaint ?? "Add to cart gave no confirmation");
  }
  await page.waitForTimeout(800);
}

export async function cartCount(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const el = document.querySelector('[class*="shop-cart--number"]') as HTMLElement | null;
      return el ? Number(el.innerText.replace(/\D/g, "")) || 0 : 0;
    })
    .catch(() => 0);
}
