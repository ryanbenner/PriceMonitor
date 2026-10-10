import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const url = process.env.PRODUCT_URL;
const target = parseFloat(process.env.TARGET_PRICE);
// optional: regex whose first capture group is the price, for sites without structured data
const priceRegex = process.env.PRICE_REGEX;
const stateFile = "state.json";

if (!url || isNaN(target)) {
  console.error("set PRODUCT_URL and TARGET_PRICE");
  process.exit(1);
}

function toNumber(v) {
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

// look for price in json-ld product data (lowPrice first, for marketplace listings)
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
      if (p != null && toNumber(p) != null) return toNumber(p);
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

let price = null;
if (priceRegex) {
  const m = html.match(new RegExp(priceRegex, "i"));
  price = m ? toNumber(m[1]) : null;
} else {
  price = fromJsonLd(html) ?? fromMeta(html);
}

// fail loudly so github sends a failure email instead of silently missing a drop
if (price == null) {
  console.error("could not find a price on the page");
  process.exit(1);
}

const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { alertedAt: null };

// alert once when price crosses below target, again only if it drops further
let alert = false;
if (price < target) {
  if (state.alertedAt == null || price < state.alertedAt) {
    alert = true;
    state.alertedAt = price;
  }
} else {
  state.alertedAt = null;
}

writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
console.log(`price: ${price} target: ${target} alert: ${alert}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `price=${price}\nalert=${alert}\n`);
}
