// catalog.js — everything to do with the product catalog (data/catalog.json).
// The server's tools call these functions; Claude never reads the file directly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(here, "data", "catalog.json");

// Load once when the server starts. (Restart the server after editing the catalog.)
export const products = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")).products;

export const CATEGORIES = [...new Set(products.map((p) => p.category))];

// The TV sizes a product relates to, as [smallest, largest] inches, or null.
//   TVs:       their own screen size (one number, so smallest = largest)
//   Soundbars: the TV sizes they suit ("fits_tv_in")
//   Mounts:    the TV sizes they hold ("specs.tv_size_in")
function sizeRange(p) {
  if (typeof p.specs?.screen_in === "number") return [p.specs.screen_in, p.specs.screen_in];
  if (Array.isArray(p.fits_tv_in)) return p.fits_tv_in;
  if (Array.isArray(p.specs?.tv_size_in)) return p.specs.tv_size_in;
  return null;
}

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);

// Filter the catalog. Every filter is optional.
export function searchProducts(filters = {}) {
  const { category, min_price, max_price, min_screen_in, max_screen_in, keywords } = filters;

  // Keyword words of 3+ letters, lower-case ("for", "a", "tv" are skipped as too vague).
  const words =
    typeof keywords === "string"
      ? keywords.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
      : [];

  const results = [];
  for (const p of products) {
    if (category && p.category !== category) continue;
    if (isNumber(min_price) && p.price < min_price) continue;
    if (isNumber(max_price) && p.price > max_price) continue;

    // Size filter: keep the product if its size range overlaps the requested range.
    // Products with no size info (streaming sticks, cables) aren't filtered by size.
    if (isNumber(min_screen_in) || isNumber(max_screen_in)) {
      const range = sizeRange(p);
      if (range) {
        const lo = isNumber(min_screen_in) ? min_screen_in : 0;
        const hi = isNumber(max_screen_in) ? max_screen_in : Infinity;
        if (range[1] < lo || range[0] > hi) continue;
      }
    }

    // Keywords: count how many words appear in the name, best_for or description.
    let hits = 0;
    if (words.length) {
      const text = [p.name, ...(p.best_for || []), p.description].join(" ").toLowerCase();
      hits = words.filter((w) => text.includes(w)).length;
      if (hits === 0) continue;
    }
    results.push({ p, hits });
  }

  // Best keyword matches first, then highest rated.
  results.sort((a, b) => b.hits - a.hits || b.rating - a.rating);
  return results.slice(0, 10).map((r) => r.p);
}

// Look up products by id. Unknown ids are reported back, not guessed.
export function getProductsByIds(ids) {
  const found = [];
  const notFound = [];
  for (const id of ids) {
    const p = products.find((x) => x.id === id);
    if (p) found.push(p);
    else notFound.push(id);
  }
  return { found, notFound };
}
