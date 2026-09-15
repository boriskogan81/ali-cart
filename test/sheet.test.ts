import { describe, expect, it } from "vitest";
import { csvExportUrl, parseCsv, parseSheetId, rowsFromCsv } from "../src/sheet.js";

const CSV = `"Part AIRFRAME","Product ","Notes ","Qty ","Est. Price (USD) ","Priority ","Link "
"Frame","TBS Source One V5 (5-inch)","Cheap, ""durable""","1","30","Essential","https://s.click.aliexpress.com/e/_DEidP4J"
"FLIGHT STACK","","","","","",""
"Motors","EMAX ECO II 2207 1900KV","Buy 5","5","80","essential","https://s.click.aliexpress.com/e/_DCRMR3z"
"Flight firmware","Betaflight (free)","","1","0","Essential","https://betaflight.com"
"","","","","653","",""
`;

describe("sheet", () => {
  it("parses the spreadsheet id", () => {
    expect(parseSheetId("https://docs.google.com/spreadsheets/d/13R1QkFsH-GjK7KZ1XYbCoLzbNqxFJmgT7_Y_DR12fzU/edit?usp=sharing")).toBe(
      "13R1QkFsH-GjK7KZ1XYbCoLzbNqxFJmgT7_Y_DR12fzU",
    );
    expect(() => parseSheetId("https://example.com")).toThrow();
  });

  it("builds the csv export url with the tab name encoded", () => {
    expect(csvExportUrl("abc", '5"')).toBe("https://docs.google.com/spreadsheets/d/abc/gviz/tq?tqx=out:csv&sheet=5%22");
  });

  it("parses quoted csv with escaped quotes", () => {
    const rows = parseCsv('"a","b ""q"" c"\r\n"1","2"\n');
    expect(rows).toEqual([["a", 'b "q" c'], ["1", "2"]]);
  });

  it("turns csv into rows, carrying section headers and skipping totals", () => {
    const rows = rowsFromCsv(parseCsv(CSV));
    expect(rows.map((r) => r.part)).toEqual(["Frame", "Motors", "Flight firmware"]);
    expect(rows[0].section).toBe("");
    expect(rows[1].section).toBe("FLIGHT STACK");
    expect(rows[1].qty).toBe(5);
    expect(rows[1].priority).toBe("Essential");
    expect(rows[0].notes).toBe('Cheap, "durable"');
    expect(rows[2].rowNumber).toBe(5);
    expect(rows[0].estPrice).toBe(30);
  });
});
