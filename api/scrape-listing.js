// Otto — Dealership Listing Scraper (Vercel serverless function, Node 18+ ESM)
// POST /api/scrape-listing  { url: "https://dealership.com/inventory/..." }
// Returns { ok, vehicle: {...}, images: [...], image_count }
//
// Extraction strategy (most reliable first):
//   1. JSON-LD structured data (schema.org Vehicle/Car/Product) — present on most dealer sites
//   2. Open Graph / meta tags
//   3. Page title + URL patterns
//   4. Regex fallbacks for price/mileage, scoped near keywords to avoid false matches
//
// Security:
//   - Requires Supabase auth (same pattern as generate.js)
//   - SSRF guard: only http(s); hostname AND resolved IP must be public;
//     redirects followed manually and each hop re-validated
//   - Fetch timeout via AbortController; response size capped

import { createClient } from '@supabase/supabase-js';
import dns from 'node:dns/promises';

const FETCH_TIMEOUT_MS = 9000;
const MAX_HTML_BYTES = 3 * 1024 * 1024; // 3 MB cap
const MAX_IMAGES = 12;

const KNOWN_MAKES = [
  'Mercedes-Benz', 'Alfa Romeo', 'Aston Martin', 'Land Rover', 'Rolls-Royce',
  'Acura', 'Audi', 'Bentley', 'BMW', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler',
  'Dodge', 'Ferrari', 'Fiat', 'Ford', 'Genesis', 'GMC', 'Honda', 'Hyundai',
  'Infiniti', 'Jaguar', 'Jeep', 'Kia', 'Lamborghini', 'Lexus', 'Lincoln', 'Lucid',
  'Maserati', 'Mazda', 'McLaren', 'Mini', 'Mitsubishi', 'Nissan', 'Polestar',
  'Porsche', 'Ram', 'Rivian', 'Subaru', 'Tesla', 'Toyota', 'Volkswagen', 'Volvo'
];

// ---------- auth ----------
async function authedUser(req) {
  const url = process.env.SUPABASE_URL, secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return { configured: false, user: null };
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return { configured: true, user: null };
  try {
    const supa = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supa.auth.getUser(token);
    if (error || !data || !data.user) return { configured: true, user: null };
    return { configured: true, user: data.user };
  } catch (e) { return { configured: true, user: null }; }
}

// ---------- helpers ----------
function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function toNumber(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function resolveUrl(src, baseUrl) {
  try {
    let u = String(src).trim();
    if (!u) return null;
    if (u.startsWith('//')) u = 'https:' + u;
    return new URL(u, baseUrl).href;
  } catch (e) { return null; }
}

function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // Block raw IPv6 literals outright
  if (host.includes(':')) return false;
  // If it's a raw IPv4 literal, check it directly
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 && isPrivateIpv4(host)) return false;
  return true;
}

function isPrivateIpv4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    a >= 224; // multicast / reserved
}

// Resolve the hostname and confirm no A/AAAA record points at a private range.
// Defends against DNS-rebinding where a public name resolves to an internal IP.
async function hostResolvesPublic(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) return false;
    for (const r of records) {
      if (r.family === 6) return false; // be strict: reject IPv6 targets
      if (isPrivateIpv4(r.address)) return false;
    }
    return true;
  } catch (e) {
    return false; // unresolvable → treat as unsafe
  }
}

// ---------- JSON-LD ----------
function parseJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      blocks.push(parsed);
    } catch (e) { /* malformed block — skip */ }
  }
  // Flatten @graph and arrays into a single list of nodes
  const nodes = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    nodes.push(n);
    if (n['@graph']) visit(n['@graph']);
  };
  blocks.forEach(visit);
  return nodes;
}

function typeMatches(node, names) {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list.some(x => typeof x === 'string' && names.includes(x.toLowerCase()));
}

function firstString(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) { for (const x of v) { const s = firstString(x); if (s) return s; } return null; }
  if (v && typeof v === 'object') return firstString(v.name || v['@value'] || v.url || v.contentUrl);
  return null;
}

function extractFromJsonLd(nodes, data, images) {
  const vehicles = nodes.filter(n => typeMatches(n, ['vehicle', 'car', 'motorcycle', 'product']));
  // Prefer Vehicle/Car over generic Product
  vehicles.sort((a, b) =>
    (typeMatches(a, ['vehicle', 'car']) ? 0 : 1) - (typeMatches(b, ['vehicle', 'car']) ? 0 : 1));

  for (const v of vehicles) {
    if (!data.make) data.make = firstString(v.brand) || firstString(v.manufacturer);
    if (!data.model) data.model = firstString(v.model);
    if (!data.trim) data.trim = firstString(v.vehicleConfiguration) || firstString(v.trim);
    if (!data.year) {
      const y = firstString(v.vehicleModelDate) || firstString(v.productionDate) || firstString(v.modelDate);
      const ym = y && y.match(/\b(19|20)\d{2}\b/);
      if (ym) data.year = ym[0];
    }
    if (!data.vin) data.vin = firstString(v.vehicleIdentificationNumber);
    if (!data.color) data.color = firstString(v.color);
    if (!data.mileage) {
      const mo = v.mileageFromOdometer;
      data.mileage = toNumber(mo && typeof mo === 'object' ? mo.value : mo);
    }
    if (!data.price) {
      const offers = Array.isArray(v.offers) ? v.offers : (v.offers ? [v.offers] : []);
      for (const o of offers) {
        const p = toNumber(o && (o.price || (o.priceSpecification && o.priceSpecification.price)));
        if (p) { data.price = p; break; }
      }
    }
    if (!data.description) {
      const d = firstString(v.description);
      if (d && d.length > 20) data.description = d.slice(0, 600);
    }
    if (!data.year || !data.make || !data.model) {
      // Try the name field: "2025 Mercedes-Benz GLC 300 4MATIC"
      const name = firstString(v.name);
      if (name) parseTitleString(name, data);
    }
    const imgs = Array.isArray(v.image) ? v.image : (v.image ? [v.image] : []);
    imgs.forEach(i => { const s = firstString(i); if (s) images.push(s); });
  }
}

// ---------- inline vehicle JSON (dealer.com / DDC and similar platforms) ----------
// Dealer.com powers a large share of US dealership sites. Their raw HTML embeds a
// vehicle object like: "modelYear": "2025", "make": "Mercedes\-Benz", "odometer": 2355, ...
function inlineJsonField(html, key) {
  const m = html.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.){0,120}"|[\\d.]+)`));
  if (!m) return null;
  let v = m[1];
  if (v.startsWith('"')) {
    v = v.slice(1, -1).replace(/\\(.)/g, '$1').trim();
    if (!v || v.toLowerCase() === 'null') return null;
  }
  return v;
}

// Hidden form inputs, e.g. cars.com: <input type="hidden" name="list_price" value="29220">
function hiddenInputField(html, key) {
  const m = html.match(new RegExp(
    `<input[^>]+name=["']${key}["'][^>]+value=["']([^"']{1,120})["']` +
    `|<input[^>]+value=["']([^"']{1,120})["'][^>]+name=["']${key}["']`, 'i'));
  const v = m && decodeEntities((m[1] || m[2]).trim());
  return v && v.toLowerCase() !== 'null' ? v : null;
}

function embeddedField(html, keys) {
  for (const k of keys) {
    const v = inlineJsonField(html, k) || hiddenInputField(html, k);
    if (v) return v;
  }
  return null;
}

function extractFromInlineJson(html, data) {
  // Only trust this if the page really looks like a vehicle payload
  if (!/"(modelYear|model_year|internetPrice|list_price)"|name=["'](list_price|model_year)["']/.test(html)) return;
  if (!data.year) {
    const y = embeddedField(html, ['modelYear', 'model_year', 'year']);
    if (y && /^(19|20)\d{2}$/.test(y)) data.year = y;
  }
  if (!data.make) data.make = embeddedField(html, ['make']);
  if (!data.model) data.model = embeddedField(html, ['model']);
  if (!data.trim) data.trim = embeddedField(html, ['trim']);
  if (!data.vin) {
    const vin = embeddedField(html, ['vin']);
    if (vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) data.vin = vin;
  }
  if (!data.color) data.color = embeddedField(html, ['exteriorColor', 'exterior_color', 'normalExteriorColor']);
  if (!data.mileage) data.mileage = toNumber(embeddedField(html, ['odometer', 'mileage']));
  if (!data.price) {
    // askingPrice is what dealer.com displays first; the others are platform variants
    data.price = toNumber(embeddedField(html, ['askingPrice', 'internetPrice', 'salePrice', 'list_price', 'listPrice']));
  }
}

// ---------- title / URL parsing ----------
function parseTitleString(title, data) {
  if (!title) return;
  const t = decodeEntities(title).replace(/\s+/g, ' ').trim();
  const ym = t.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  if (ym && !data.year) data.year = ym[0];
  if (data.make && data.model) return;
  // Find the make in the title (use the known one if already set), then take the model after it
  const makesToTry = data.make ? [data.make, ...KNOWN_MAKES] : KNOWN_MAKES;
  for (const make of makesToTry) {
    const idx = t.toLowerCase().indexOf(make.toLowerCase());
    if (idx !== -1) {
      if (!data.make) data.make = make;
      if (!data.model) {
        // Model = text right after the make, up to a separator
        const after = t.slice(idx + make.length).replace(/^[\s\-–|:]+/, '');
        const model = after.split(/\s+(?:for sale|near|in|at|\||–|-{2,})/i)[0]
          .replace(/\b(certified|pre-?owned|used|new)\b/gi, '')
          .replace(/\s+/g, ' ').trim();
        if (model && model.length >= 1 && model.length <= 40) data.model = model;
      }
      break;
    }
  }
}

function parseFromUrl(url, data) {
  // e.g. /certified/Mercedes-Benz/2025-Mercedes-Benz-GLC-300-...
  const m = url.match(/(19[5-9]\d|20[0-4]\d)-([A-Za-z][A-Za-z]+(?:-[A-Za-z]+)?)-([A-Za-z0-9][A-Za-z0-9-]*)/);
  if (m) {
    if (!data.year) data.year = m[1];
    if (!data.make) {
      const candidate = m[2].replace(/-/g, ' ');
      const known = KNOWN_MAKES.find(k => k.toLowerCase().replace(/[^a-z]/g, '') === candidate.toLowerCase().replace(/[^a-z]/g, ''));
      data.make = known || candidate;
      if (!data.model) data.model = m[3].replace(/-/g, ' ');
    }
  }
}

// ---------- meta tags ----------
function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name.replace(/[:.]/g, '\\$&')}["'][^>]+content=["']([^"']+)["']` +
      `|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name.replace(/[:.]/g, '\\$&')}["']`, 'i');
    const m = html.match(re);
    if (m) return decodeEntities(m[1] || m[2]);
  }
  return null;
}

// ---------- regex fallbacks ----------
function extractPriceFallback(html) {
  // Look for $ amounts near price-ish keywords; ignore small numbers (monthly payments < $1000)
  const candidates = [];
  const re = /(price|msrp|asking|internet|sale|our|dealer)[^<>$]{0,80}\$\s*([\d,]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = toNumber(m[2]);
    if (n && n >= 1500 && n < 1000000) candidates.push(n);
  }
  if (candidates.length) return candidates[0];
  // Last resort: any plausible vehicle-priced $ amount
  const re2 = /\$\s*([\d]{2,3},[\d]{3})\b/g;
  while ((m = re2.exec(html)) !== null) {
    const n = toNumber(m[1]);
    if (n && n >= 5000 && n < 1000000) return n;
  }
  return null;
}

function extractMileageFallback(html) {
  const re = /([\d]{1,3}(?:,[\d]{3})+|[\d]{4,6})\s*(?:miles|mi\.?)\b/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = toNumber(m[1]);
    if (n && n >= 1 && n < 400000) return n;
  }
  const re2 = /(?:mileage|odometer)[^0-9]{0,40}([\d,]+)/i;
  const m2 = html.match(re2);
  if (m2) { const n = toNumber(m2[1]); if (n && n < 400000) return n; }
  return null;
}

// ---------- images ----------
const IMG_JUNK = /logo|icon|sprite|badge|banner|button|captcha|placeholder|blank|pixel|favicon|avatar|header|footer|nav|arrow|star|rating|award|certif|carfax|kbb|map|flag|social|facebook|instagram|twitter|youtube|tiktok|loading|spinner|1x1|wp-content|og-img|opengraph|\.svg|\.gif/i;

function extractImages(html, baseUrl, seed) {
  const found = [];
  const push = (raw) => {
    const u = resolveUrl(raw, baseUrl);
    if (!u) return;
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(u) && !/\/(photo|image|img|inventory|vehicle)/i.test(u)) return;
    if (IMG_JUNK.test(u)) return;
    found.push(u);
  };

  (seed || []).forEach(push);

  const patterns = [
    /<img[^>]+(?:data-src|data-lazy-src|data-original)=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']+)["']/gi,
    /"(?:imageUrl|image_url|photoUrl|photo_url)"\s*:\s*"([^"]+)"/gi,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(html)) !== null) push(m[1]);
  }

  // Dedupe, preferring larger-looking variants (strip size params for the key)
  const seen = new Set();
  const out = [];
  for (const u of found) {
    const key = u.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

// ---------- main extraction (pure, testable) ----------
export function extractListing(html, url) {
  const data = {
    year: null, make: null, model: null, trim: null,
    price: null, mileage: null, color: null, vin: null,
    features: [], description: null, source_url: url
  };
  const seedImages = [];

  extractFromJsonLd(parseJsonLdBlocks(html), data, seedImages);
  extractFromInlineJson(html, data);

  const ogTitle = metaContent(html, ['og:title', 'twitter:title']);
  if (ogTitle) parseTitleString(ogTitle, data);
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) parseTitleString(titleMatch[1], data);
  parseFromUrl(url, data);

  if (!data.description) {
    const ogDesc = metaContent(html, ['og:description', 'description']);
    if (ogDesc && ogDesc.length > 20) data.description = ogDesc.slice(0, 600);
  }
  if (!data.price) data.price = extractPriceFallback(html);
  if (!data.mileage) data.mileage = extractMileageFallback(html);

  // Normalize numbers (frontend uses <input type="number">)
  data.price = toNumber(data.price);
  data.mileage = toNumber(data.mileage);
  if (data.year) data.year = String(data.year).slice(0, 4);
  if (data.color) data.color = String(data.color).slice(0, 40);

  // Features: derive a few short selling points from the description
  if (data.description) {
    data.features = data.description
      .split(/[•|]|\. /)
      .map(s => s.trim())
      .filter(s => s.length > 8 && s.length < 90)
      .slice(0, 5);
  }

  const ogImage = metaContent(html, ['og:image']);
  if (ogImage) seedImages.unshift(ogImage);
  const images = extractImages(html, url, seedImages);

  return { vehicle: data, images };
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await authedUser(req);
  if (auth.configured && !auth.user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const listingUrl = String(body.url || '').trim();

    if (!isPublicHttpUrl(listingUrl) || !(await hostResolvesPublic(new URL(listingUrl).hostname))) {
      res.status(400).json({ ok: false, error: 'invalid_url', message: 'Please paste a full dealership listing URL (https://...)' });
      return;
    }

    // Manual redirect loop: each hop's URL is re-validated (host + resolved IP)
    // so a public page can't bounce us to an internal/metadata address.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let fetchRes;
    let currentUrl = listingUrl;
    try {
      for (let hop = 0; hop < 5; hop++) {
        fetchRes = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
        if (![301, 302, 303, 307, 308].includes(fetchRes.status)) break;
        const loc = fetchRes.headers.get('location');
        if (!loc) break;
        const next = new URL(loc, currentUrl).href;
        if (!isPublicHttpUrl(next) || !(await hostResolvesPublic(new URL(next).hostname))) {
          res.status(400).json({ ok: false, error: 'unsafe_redirect', message: 'That link redirected somewhere we can\'t fetch. Please fill in details manually.' });
          return;
        }
        currentUrl = next;
        if (hop === 4) { // too many redirects
          res.status(422).json({ ok: false, error: 'too_many_redirects', message: 'That page redirected too many times. Please fill in details manually.' });
          return;
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (!fetchRes || !fetchRes.ok) {
      const status = fetchRes ? fetchRes.status : 0;
      const blocked = [403, 429, 503].includes(status);
      res.status(422).json({
        ok: false,
        error: blocked ? 'site_blocked_request' : 'failed_to_fetch_listing',
        message: blocked
          ? 'This dealership site blocked automated access. Please fill in the details manually.'
          : `Could not load that page (HTTP ${status}). Check the URL and try again.`
      });
      return;
    }

    // Read with a size cap
    const reader = fetchRes.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_HTML_BYTES) { reader.cancel(); break; }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString('utf8');

    const { vehicle, images } = extractListing(html, listingUrl);

    const gotSomething = vehicle.year || vehicle.make || vehicle.model || vehicle.price || images.length;
    if (!gotSomething) {
      res.status(422).json({
        ok: false,
        error: 'no_vehicle_data_found',
        message: 'Could not find vehicle details on that page. Make sure the link points to a single vehicle listing.'
      });
      return;
    }

    res.status(200).json({ ok: true, vehicle, images, image_count: images.length });
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    console.error('Scrape error:', e && e.message);
    res.status(timedOut ? 422 : 500).json({
      ok: false,
      error: timedOut ? 'timeout' : 'scraping_failed',
      message: timedOut ? 'The dealership site took too long to respond. Try again or fill in details manually.' : 'Something went wrong while reading that page.'
    });
  }
}
