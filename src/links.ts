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

/** Pull a client-side redirect target (meta refresh or `location.href = ...`) out of an HTML body, if any. */
export function redirectFromHtml(html: string): string | null {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i);
  if (meta) return meta[1];
  const js = html.match(/(?:location\.href|location\.replace\(|window\.location)\s*=?\s*["']([^"']+)["']/i);
  return js ? js[1] : null;
}

export function isAliExpressLink(link: string): boolean {
  return /aliexpress\./i.test(link) || /s\.click\./i.test(link);
}

async function fetchHop(url: string, shipTo: string, currency: string): Promise<{ status: number; location: string | null }> {
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { "User-Agent": UA, Cookie: localeCookie(shipTo, currency), Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(20_000),
  });
  let location = res.headers.get("location");
  if (!location && res.status === 200 && (res.headers.get("content-type") ?? "").includes("html")) {
    const body = await res.text().catch(() => "");
    location = redirectFromHtml(body.slice(0, 200_000));
  } else await res.body?.cancel().catch(() => {});
  return { status: res.status, location };
}

/** Follow affiliate/short links to their destination and classify it. Retries transient failures. */
export async function resolveLink(link: string, shipTo = "IL", currency = "USD"): Promise<ResolvedLink> {
  const trimmed = link.trim();
  if (!trimmed) return { kind: "none" };
  const start = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
  if (!isAliExpressLink(start)) return classifyUrl(start);
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let current = start;
    try {
      // Follow redirects by hand so we can stop as soon as the URL is classifiable and never load a full item page.
      for (let hop = 0; hop < 8; hop++) {
        const direct = classifyUrl(current);
        if (direct.kind !== "external") return direct;
        const { status, location } = await fetchHop(current, shipTo, currency);
        if (!location) {
          lastError = `HTTP ${status} without a redirect at ${current}`;
          break;
        }
        current = new URL(location, current).toString();
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  console.warn(`[links] could not resolve ${start}: ${lastError}`);
  return { kind: "external", finalUrl: start };
}
