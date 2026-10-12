import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const url = process.env.PRODUCT_URL;
const target = parseFloat(process.env.TARGET_PRICE);
// optional: regex whose first capture group is the price, for sites without structured data
const priceRegex = process.env.PRICE_REGEX;
// optional: same idea for shipping cost, if the page shows it but not in structured data
const shippingRegex = process.env.SHIPPING_REGEX;
// optional: fixed shipping cost to use when none can be found on the page
const shippingFallback = parseFloat(process.env.SHIPPING_COST);
const stateFile = "state.json";

if (!url || isNaN(target)) {
  console.error("set PRODUCT_URL and TARGET_PRICE");
  process.exit(1);
}

function toNumber(v) {
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

// cheapest shipping rate from an offer's shippingDetails, or null if it doesn't list any
function shippingOf(offer) {
  const rates = [offer.shippingDetails].flat()
    .flatMap((d) => [d?.shippingRate].flat())
    .map((r) => toNumber(r?.value ?? r?.price ?? ""))
    .filter((n) => n != null);
  return rates.length ? Math.min(...rates) : null;
}

// look for price + shipping in json-ld product data.
// for marketplace listings (lowPrice) with individual offers, pick the cheapest offer by total
function fromJsonLd(html) {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    let data;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { stack.push(...node); continue; }
      const p = node.lowPrice ?? node.price;
      if (p != null && toNumber(p) != null) {
        if (node.lowPrice != null) {
          const offers = [node.offers].flat()
            .filter((o) => o && toNumber(o.price ?? "") != null)
            .map((o) => ({ price: toNumber(o.price), shipping: shippingOf(o) }));
          if (offers.some((o) => o.shipping != null)) {
            return offers.reduce((best, o) =>
              o.price + (o.shipping ?? 0) < best.price + (best.shipping ?? 0) ? o : best);
          }
        }
        return { price: toNumber(p), shipping: shippingOf(node) };
      }
      stack.push(...Object.values(node));
    }
  }
  return null;
}

// look for price in meta tags (either attribute order)
function fromMeta(html) {
  const names = "(?:product:price:amount|og:price:amount|price)";
  const a = html.match(new RegExp(`<meta[^>]+(?:property|itemprop|name)=["']${names}["'][^>]*content=["']([^"']+)["']`, "i"));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|itemprop|name)=["']${names}["']`, "i"));
  return toNumber((a || b)?.[1] ?? "");
}

const res = await fetch(url, {
  headers: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
  },
});
if (!res.ok) {
  console.error(`fetch failed: ${res.status}`);
  process.exit(1);
}
const html = await res.text();

const jsonLd = fromJsonLd(html);

let price = null;
if (priceRegex) {
  const m = html.match(new RegExp(priceRegex, "i"));
  price = m ? toNumber(m[1]) : null;
} else {
  price = jsonLd?.price ?? fromMeta(html);
}

// fail loudly so github sends a failure email instead of silently missing a drop
if (price == null) {
  console.error("could not find a price on the page");
  process.exit(1);
}

// shipping: SHIPPING_REGEX, then json-ld, then SHIPPING_COST, then assume free
let shipping = null;
if (shippingRegex) {
  const m = html.match(new RegExp(shippingRegex, "i"));
  shipping = m ? toNumber(m[1]) : null;
}
shipping ??= jsonLd?.shipping ?? (isNaN(shippingFallback) ? null : shippingFallback);
if (shipping == null) {
  console.log("no shipping cost found, assuming free (set SHIPPING_COST or SHIPPING_REGEX to override)");
  shipping = 0;
}

const total = Math.round((price + shipping) * 100) / 100;

const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { alertedAt: null };

// alert once when total crosses below target, again only if it drops further
let alert = false;
if (total < target) {
  if (state.alertedAt == null || total < state.alertedAt) {
    alert = true;
    state.alertedAt = total;
  }
} else {
  state.alertedAt = null;
}

writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
console.log(`price: ${price} shipping: ${shipping} total: ${total} target: ${target} alert: ${alert}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `price=${price}\nshipping=${shipping}\ntotal=${total}\nalert=${alert}\n`);
}
