// Wait until AliExpress serves item pages to this network again, then run the given CLI commands in order.
// Usage: pnpm tsx scripts/auto-resume.mjs "<cli args 1>" "<cli args 2>" ...
// Probes one item page every 30 minutes (up to 16 hours) in the signed-in profile.
import { spawn } from "node:child_process";
import { getPage, launchBrowser } from "../src/browser.ts";

const PROBE_ITEM = "https://www.aliexpress.com/item/1005012898675688.html";
const INTERVAL_MS = 30 * 60_000;
const MAX_PROBES = 32;
const commands = process.argv.slice(2);
const stamp = () => new Date().toISOString().slice(11, 19);

async function itemsLoad() {
  const ctx = await launchBrowser();
  try {
    const page = await getPage(ctx);
    await page.goto(PROBE_ITEM, { waitUntil: "domcontentloaded", timeout: 90_000 });
    return await page.waitForSelector('[class*="price-default--current"]', { timeout: 25_000 }).then(() => true).catch(() => false);
  } catch {
    return false;
  } finally {
    await ctx.close().catch(() => {});
  }
}

function run(args) {
  return new Promise((resolve) => {
    console.log(`[${stamp()}] running: pnpm cli ${args}`);
    const child = spawn("pnpm", ["cli", ...args.split(" ")], { stdio: "inherit", shell: true });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

for (let i = 1; i <= MAX_PROBES; i++) {
  const ok = await itemsLoad();
  console.log(`[${stamp()}] probe ${i}: item pages ${ok ? "LOAD" : "blocked"}`);
  if (ok) break;
  if (i === MAX_PROBES) {
    console.log("giving up: still blocked");
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

for (const args of commands) {
  const code = await run(args);
  console.log(`[${stamp()}] exit ${code}`);
  if (code !== 0) {
    console.log("stopping: command failed");
    process.exit(code);
  }
  await new Promise((r) => setTimeout(r, 60_000));
}
console.log(`[${stamp()}] all done`);
