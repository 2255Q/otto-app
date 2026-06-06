// Otto — Import a vehicle from a dealer listing URL (Vercel serverless function).
// Flow: validate URL -> fetch page (SSRF-hardened) -> strip to text -> Claude extracts fields -> return JSON.
// Security:
//  - ANTHROPIC_API_KEY stays server-side only.
//  - SSRF defense: every hop's hostname is DNS-resolved and ALL resolved IPs are checked against
//    private/loopback/link-local/metadata ranges; redirects are followed manually and re-validated.
//  - Network failures collapse to one generic error so the endpoint can't be used to map internal hosts.
//  - Only Claude-extracted fields are ever returned — never the raw fetched body.

import { lookup } from 'node:dns/promises';

const MODEL = 'claude-haiku-4-5-20251001';
const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_CHARS = 60000;
const MAX_TEXT_CHARS = 12000;
const MAX_TOKENS = 500;
const MAX_HOPS = 4;

function ipIsPrivate(ip) {
  ip = String(ip || '').toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];
  if (ip.includes(':')) { // IPv6
    if (ip === '::1' || ip === '::') return true;
    if (/^fe80:/.test(ip)) return true;                 // link-local
    if (/^(fc|fd)[0-9a-f]{2}:/.test(ip)) return true;   // unique-local
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → unsafe
  const [a, b] = p;
  if (a === 0 || a === 127 || a === 10 || a === 255) return true;
  if (a === 169 && b === 254) return true;              // link-local incl. cloud metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
  return false;
}

function badHostString(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || /\.local$/.test(host) || /\.internal$/.test(host)) return true;
  if (/^[0-9]+$/.test(host)) return true;        // decimal-encoded IP (e.g. 2130706433)
  if (/^0x[0-9a-f]+$/i.test(host)) return true;  // hex-encoded IP
  return false;
}

function parseSafe(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && !['', '80', '443'].includes(u.port)) return null;
  if (badHostString(u.hostname)) return null;
  return u;
}

async function hostResolvesSafe(host) {
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return false;
    return addrs.every(a => !ipIsPrivate(a.address));
  } catch (e) { return false; }
}

async function fetchGuarded(rawUrl) {
  let u = parseSafe(rawUrl);
  if (!u) return { error: true };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let i = 0; i < MAX_HOPS; i++) {
      if (!(await hostResolvesSafe(u.hostname))) return { error: true };
      const r = await fetch(u.toString(), {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OttoBot/0.1; +https://leadotto.com)' }
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return { error: true };
        const next = parseSafe(new URL(loc, u).toString());
        if (!next) return { error: true };
        u = next;
        continue;
      }
      const ctype = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok || !/text\/html|text\/plain|application\/xhtml/.test(ctype)) return { error: true };
      const html = (await r.text()).slice(0, MAX_HTML_CHARS);
      return { html };
    }
    return { error: true }; // too many redirects
  } catch (e) {
    return { error: true };
  } finally {
    clearTimeout(to);
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJSON(t) {
  if (!t) return null;
  let s = String(t).trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const len = Number(req.headers['content-length'] || 0);
  if (len > 4096) { res.status(413).json({ ok: false, error: 'too_large' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(503).json({ ok: false, error: 'ai_unconfigured' }); return; }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!parseSafe(body.url)) { res.status(400).json({ ok: false, error: 'invalid_or_blocked_url' }); return; }

  // Generic failure for ANY network/redirect/content problem → no internal-network probing oracle.
  const fetched = await fetchGuarded(body.url);
  if (fetched.error) { res.status(422).json({ ok: false, error: 'could_not_import' }); return; }

  const text = htmlToText(fetched.html).slice(0, MAX_TEXT_CHARS);
  if (text.length < 40) { res.status(422).json({ ok: false, error: 'could_not_import' }); return; }

  try {
    const system = "You extract structured car-listing data from raw web page text. Respond with ONLY a single valid JSON object, no markdown or commentary. Never invent values that are not present in the text — use an empty string for anything you cannot find.";
    const user = `From the following car-listing page text, extract the vehicle's details.

Return a JSON object with EXACTLY these keys (all string values):
- "year", "make", "model", "trim"
- "miles" (digits only, no commas)
- "price" (digits only, no commas or $)
- "color" (exterior color)
- "condition" (e.g. New, Used, Certified — or "")
- "features" (a comma-separated list of notable features/options found, e.g. "Backup camera, Apple CarPlay, sunroof")

Use "" for any field not clearly present. Do not guess.

PAGE TEXT:
${text}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] })
    });
    if (!aiRes.ok) { res.status(502).json({ ok: false, error: 'ai_upstream' }); return; }
    const j = await aiRes.json();
    const vehicle = extractJSON(j && j.content && j.content[0] && j.content[0].text);
    if (!vehicle) { res.status(422).json({ ok: false, error: 'could_not_import' }); return; }
    res.status(200).json({ ok: true, vehicle });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
