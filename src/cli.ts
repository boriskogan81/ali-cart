import { parseArgs } from "node:util";
import { config } from "./config.js";
import { Run } from "./pipeline.js";
import { PRIORITIES, type Priority } from "./types.js";

const { values } = parseArgs({
  options: {
    sheet: { type: "string" },
    tab: { type: "string", default: "" },
    priorities: { type: "string", default: PRIORITIES.join(",") },
    "dry-run": { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
    limit: { type: "string" },
    rows: { type: "string" },
    apply: { type: "string" },
  },
});

if (values.apply) {
  // Apply mode: add the chosen listings of a saved (dry) run to the cart.
  const run = new Run({ sheetUrl: "", tab: "", priorities: PRIORITIES, dryRun: false, applyFromRunId: values.apply });
  run.on("event", (ev) => {
    if (ev.type === "row" && ev.result.status !== "skipped") console.log(`  row ${String(ev.result.row.rowNumber).padStart(3)} [${ev.result.status.padEnd(8)}] ${ev.result.row.product.slice(0, 40).padEnd(40)} ${ev.result.message}`);
    if (ev.type === "log") console.log(`[run] ${ev.message}`);
  });
  const state = await run.start();
  console.log(`\n${state.rows.filter((r) => r.cartAdded).length} listings in the cart, landed total ${config.currency} ${state.totalLanded.toFixed(2)}${state.error ? `\nError: ${state.error}` : ""}`);
  if (!values["keep-open"]) await run.close();
  process.exit(state.error ? 1 : 0);
}

if (!values.sheet) {
  console.error(`usage: pnpm cli --sheet <google-sheets-url> [--tab '5"'] [--priorities Essential,Recommended,Optional] [--dry-run] [--keep-open] [--limit N] [--rows 12,17]\n       pnpm cli --apply <run-id>   # add the chosen listings of a saved dry run to the cart`);
  process.exit(2);
}

const priorities = values.priorities!.split(",").map((s) => s.trim()).filter((p): p is Priority => (PRIORITIES as string[]).includes(p));
const run = new Run({ sheetUrl: values.sheet, tab: values.tab!, priorities, dryRun: values["dry-run"]!, limit: values.limit ? Number(values.limit) : undefined, rows: values.rows ? values.rows.split(",").map(Number) : undefined });
run.on("event", (ev) => {
  if (ev.type === "row") {
    const r = ev.result;
    const cost = r.chosen ? ` ${config.currency} ${r.chosen.landedTotal.toFixed(2)}` : "";
    console.log(`  row ${String(r.row.rowNumber).padStart(3)} [${r.status.padEnd(8)}] ${r.row.product.slice(0, 40).padEnd(40)} ${r.message}${cost}`);
  }
});
const state = await run.start();
console.log("\nSummary:");
for (const r of state.rows) {
  const line = r.chosen ? `${r.chosen.url}  ${r.chosen.variant ?? ""}  ${config.currency} ${r.chosen.landedTotal.toFixed(2)}` : r.message;
  console.log(`${r.status.padEnd(8)} ${r.row.product.slice(0, 45).padEnd(45)} ${line}`);
}
console.log(`\nLanded total: ${config.currency} ${state.totalLanded.toFixed(2)}${state.error ? `\nError: ${state.error}` : ""}`);
if (!values["keep-open"]) await run.close();
