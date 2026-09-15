import type { ResolvedLink } from "./types.js";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Cookies that make aliexpress.com serve English titles, the chosen currency, and prices for the chosen ship-to. */
export function localeCookie(shipTo: string, currency: string): string {
  return `aep_usuc_f=site=glo&c_tp=${currency}&region=${shipTo}&b_locale=en_US; intl_locale=en_US; xman_us_f=x_locale=en_US&x_l=0&region=${shipTo}&b_locale=en_US`;
}

function slugToQuery(slug: string): string {
  return decodeURIComponent(slug)
    .replace(/\.html?$/i, "")
    .replace(/^wholesale-/i, "")
    .replace(/[-_+]+/g, " ")
    .trim();
}

/** Classify a final (post-redirect) URL. Pure; no network. */
export function classifyUrl(finalUrl: string): ResolvedLink {
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    return { kind: "none" };
  }
  if (!/(^|\.)aliexpress\.(com|us|ru)$/i.test(u.hostname)) return { kind: "external", finalUrl };

  const item = u.pathname.match(/\/item\/(?:[^/]+\/)?(\d{6,})\.html/i) || u.pathname.match(/\/i\/(\d{6,})\.html/i);
  if (item) return { kind: "item", itemId: item[1], finalUrl };

  const search = u.pathname.match(/^\/(?:[a-z]{2}\/)?(?:w|af)\/([^/]+?)\.html/i);
  if (search) return { kind: "search", query: slugToQuery(search[1]), finalUrl };

  const text = u.searchParams.get("SearchText") || u.searchParams.get("keywords") || u.searchParams.get("q");
  if (text) return { kind: "search", query: text.replace(/\+/g, " ").trim(), finalUrl };

  return { kind: "external", finalUrl };
}

/** Follow affiliate/short links to their destination and classify it. */
export async function resolveLink(link: string, shipTo = "IL", currency = "USD"): Promise<ResolvedLink> {
  const trimmed = link.trim();
  if (!trimmed) return { kind: "none" };
  let current = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
  // Follow redirects manually so we can stop as soon as we can classify, and never fetch a full item page.
  for (let hop = 0; hop < 8; hop++) {
    const direct = classifyUrl(current);
    if (direct.kind === "item" || direct.kind === "search") return direct;
    if (direct.kind === "none") return direct;
    if (!/aliexpress\./i.test(current) && !/s\.click\./i.test(current) && hop === 0) return direct; // plain external link
    const res = await fetch(current, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": UA, Cookie: localeCookie(shipTo, currency) },
    }).catch(() => null);
    if (!res) return { kind: "external", finalUrl: current };
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return classifyUrl(current);
  }
  return { kind: "external", finalUrl: current };
}
