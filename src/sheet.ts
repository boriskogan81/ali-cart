import type { Priority, SheetRow } from "./types.js";
import { PRIORITIES } from "./types.js";

/** Extract the spreadsheet id from any docs.google.com/spreadsheets URL (or accept a bare id). */
export function parseSheetId(input: string): string {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(input.trim())) return input.trim();
  throw new Error(`Not a Google Sheets URL: ${input}`);
}

export function csvExportUrl(sheetId: string, tab: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
  return tab ? `${base}&sheet=${encodeURIComponent(tab)}` : base;
}

/** Minimal RFC-4180 CSV parser (handles quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HEADER_ALIASES: Record<keyof Omit<SheetRow, "rowNumber" | "section">, RegExp> = {
  part: /^part/i,
  product: /^product/i,
  notes: /^note/i,
  qty: /^(qty|quantity)/i,
  estPrice: /price/i,
  priority: /^priority/i,
  link: /^(link|url)/i,
};

function normalisePriority(v: string): Priority | "" {
  const t = v.trim().toLowerCase();
  return PRIORITIES.find((p) => p.toLowerCase() === t) ?? "";
}

/** Turn raw CSV rows into shopping-list rows. Section headers become the `section` of the rows below them. */
export function rowsFromCsv(csv: string[][]): SheetRow[] {
  if (csv.length === 0) return [];
  const header = csv[0].map((h) => h.trim());
  const col: Partial<Record<keyof typeof HEADER_ALIASES, number>> = {};
  for (const [key, re] of Object.entries(HEADER_ALIASES) as [keyof typeof HEADER_ALIASES, RegExp][]) {
    const idx = header.findIndex((h) => re.test(h));
    if (idx >= 0) col[key] = idx;
  }
  for (const required of ["product", "link"] as const) {
    if (col[required] === undefined) throw new Error(`Sheet is missing a "${required}" column. Headers: ${header.join(" | ")}`);
  }
  const get = (r: string[], key: keyof typeof HEADER_ALIASES) => (col[key] === undefined ? "" : (r[col[key]!] ?? "").trim());

  const out: SheetRow[] = [];
  let section = "";
  csv.slice(1).forEach((r, i) => {
    const product = get(r, "product");
    const part = get(r, "part");
    const link = get(r, "link");
    if (!product && !link) {
      // Section header rows carry text only in the first column; total rows carry only a number.
      if (part && !/^[\d.,\s$]+$/.test(part)) section = part;
      return;
    }
    const qtyRaw = get(r, "qty");
    const qty = Math.max(1, Math.round(Number(qtyRaw) || 1));
    const priceRaw = get(r, "estPrice").replace(/[^0-9.]/g, "");
    out.push({
      rowNumber: i + 2,
      section,
      part,
      product,
      notes: get(r, "notes"),
      qty,
      estPrice: priceRaw ? Number(priceRaw) : null,
      priority: normalisePriority(get(r, "priority")),
      link,
    });
  });
  return out;
}

export async function fetchSheetRows(sheetUrl: string, tab: string | null): Promise<SheetRow[]> {
  const id = parseSheetId(sheetUrl);
  const url = csvExportUrl(id, tab);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status} for ${url}. Is the sheet shared as "anyone with the link"?`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error("Google Sheets returned HTML instead of CSV. Check sharing settings and the tab name.");
  return rowsFromCsv(parseCsv(text));
}
