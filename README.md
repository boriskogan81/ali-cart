# ali-cart

Give it a Google Sheet of parts with AliExpress links. It finds the cheapest listing of each product, shipping to your address included, puts them all in your AliExpress cart, and pings you to check out. It never checks out for you.

Built for an FPV drone parts list, but any sheet with **Product**, **Qty**, **Priority** and **Link** columns works.

## How it works

1. **Read the sheet.** The tab is pulled as CSV through Google's public export, so the sheet must be shared as "anyone with the link". Section-header rows and total rows are skipped.
2. **Resolve each link.** Affiliate short links (`s.click.aliexpress.com`) and `wholesale-…` links are search pages, not products. The search phrase is taken from the link; a direct item link seeds the search with that item's title.
3. **Search AliExpress** in a visible Chrome window, once by relevance and once by price, and collect the listings.
4. **Match.** Claude reads the row's product, notes and quantity plus the candidate titles and says which listings are the same product and which variant to pick (for example `1900KV`, `RHCP SMA`, `4pcs`).
5. **Price with shipping.** Each matched listing is opened, the variant selected, and the item price, shipping cost to your country, store feedback and sales count read off the page. Stores under the feedback or sales floor are dropped.
6. **Add the cheapest** landed option to the cart with the sheet's quantity.
7. **Alert.** Windows toast plus a sound when the cart is ready, or when AliExpress wants you to sign in or solve a captcha. The app never tries to get around captchas; it waits for you.

Every run is saved to `runs/<timestamp>.json` with every candidate, every priced listing, the chosen one and the reason for any rejection, so you can audit before paying.

## Setup

Requires Node 22+, pnpm 11, and Google Chrome or Microsoft Edge installed (the bundled Chromium is used as a last resort).

```bash
pnpm install
cp .env.example .env   # then put your ANTHROPIC_API_KEY in .env
pnpm start
```

Open http://localhost:3000, paste the sheet link, type the tab name, pick priorities, press **Run**.

The first real run opens a Chrome window and asks you to sign in to AliExpress. Your login lives in the `profile/` folder (gitignored) and is reused afterwards. Make sure your AliExpress account has your delivery address set; the ship-to country in `.env` must match it.

### Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Needed for the matching step |
| `SHIP_TO` | `IL` | Country whose shipping cost is read |
| `CURRENCY` | `USD` | Display currency for prices |
| `MIN_STORE_POSITIVE_RATE` | `90` | Listings from stores below this feedback % are rejected |
| `MIN_STORE_ORDERS` | `20` | Listings with fewer sales are rejected |
| `MAX_PRICED_PER_ROW` | `8` | How many matched listings to open per row (cheapest first) |
| `BROWSER_CHANNEL` | | Force `chrome`, `msedge` or `chromium` |
| `PORT` | `3000` | Local server port |

### Command line

```bash
pnpm cli --sheet "https://docs.google.com/spreadsheets/d/…/edit" --tab '5"' --dry-run
```

Flags: `--priorities Essential,Recommended`, `--limit 3` (first N rows), `--rows 12,17` (only those sheet rows), `--keep-open` (leave the browser up).

A dry run does everything except add to cart and does not need an AliExpress login. Set `ALI_CART_MATCHER=keyword` to replace Claude with a crude title-keyword matcher when you have no API key; expect worse matches.

## Tests

```bash
pnpm test
```

The parsers are tested against saved AliExpress HTML in `test/fixtures`. When AliExpress changes its markup, refresh the fixture and the selectors in `src/search.ts`, `src/pricing.ts` and `src/cart.ts`.

## Caveats

- This scrapes AliExpress. It will break when they change their pages, and heavy use can trigger bot checks. The app paces itself and stops for captchas.
- "Same product" is a judgement call made from listing titles. Review the chosen listings in the results table before you pay; the alternatives are listed under each row.
- Shipping is read once per listing and assumed not to scale with quantity, which is how AliExpress usually prices small parts. Check the cart total.
- Prices shown by AliExpress can differ between signed-out and signed-in sessions, and between search cards and item pages. The item page price is the one used.
