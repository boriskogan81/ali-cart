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
  },
});

if (!values.sheet) {
  console.error(`usage: pnpm cli --sheet <google-sheets-url> [--tab '5"'] [--priorities Essential,Recommended,Optional] [--dry-run] [--keep-open]`);
  process.exit(2);
}

const priorities = values.priorities!.split(",").map((s) => s.trim()).filter((p): p is Priority => (PRIORITIES as string[]).includes(p));
const run = new Run({ sheetUrl: values.sheet, tab: values.tab!, priorities, dryRun: values["dry-run"]!, limit: values.limit ? Number(values.limit) : undefined });
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
