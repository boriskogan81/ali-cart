export type Priority = "Essential" | "Recommended" | "Optional";
export const PRIORITIES: Priority[] = ["Essential", "Recommended", "Optional"];

export interface SheetRow {
  /** 1-based row number in the sheet (header is row 1). */
  rowNumber: number;
  section: string;
  part: string;
  product: string;
  notes: string;
  qty: number;
  estPrice: number | null;
  priority: Priority | "";
  link: string;
}

export type ResolvedLink =
  | { kind: "search"; query: string; finalUrl: string }
  | { kind: "item"; itemId: string; finalUrl: string }
  | { kind: "external"; finalUrl: string }
  | { kind: "none" };

export interface Candidate {
  productId: string;
  title: string;
  price: number;
  currency: string;
  rating: number | null;
  sold: number | null;
  isAd: boolean;
  imageUrl: string;
  url: string;
}

export interface MatchDecision {
  productId: string;
  confidence: "high" | "medium";
  variant: string | null;
  reason: string;
}

export interface Priced {
  productId: string;
  url: string;
  title: string;
  variant: string | null;
  skuId: string | null;
  unitPrice: number;
  shipping: number | null;
  shippingNote: string;
  landedPerUnit: number;
  landedTotal: number;
  storeName: string | null;
  storePositiveRate: number | null;
  storeOrders: number | null;
  storeFollowers: number | null;
  rejected: string | null;
}

export type RowStatus = "pending" | "running" | "ok" | "skipped" | "no-match" | "error";

export interface RowResult {
  row: SheetRow;
  status: RowStatus;
  message: string;
  resolved: ResolvedLink | null;
  query: string | null;
  candidates: Candidate[];
  matches: MatchDecision[];
  priced: Priced[];
  chosen: Priced | null;
  cartAdded: boolean;
}

export interface RunOptions {
  sheetUrl: string;
  tab: string;
  priorities: Priority[];
  dryRun: boolean;
  /** Process at most this many rows (testing aid). */
  limit?: number;
  /** Only process these sheet row numbers (testing / re-running a few rows). */
  rows?: number[];
}

export interface RunState {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  options: RunOptions;
  phase: "starting" | "login" | "captcha" | "running" | "done" | "failed";
  rows: RowResult[];
  totalLanded: number;
  error: string | null;
}

export type RunEvent =
  | { type: "phase"; phase: RunState["phase"]; message: string }
  | { type: "row"; index: number; result: RowResult }
  | { type: "log"; message: string }
  | { type: "done"; state: RunState };
