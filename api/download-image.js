// Otto — Image download proxy (Vercel serverless function, Node 18+ ESM)
// GET /api/download-image?src=<image url>
// Lets the salesperson save dealership photos with one click: the browser
// can't download cross-origin images directly, so we stream them through
// with a Content-Disposition: attachment header.
//
// Security:
//  - Requires Supabase auth (same pattern as the other endpoints)
//  - Same SSRF guards as the scraper (public http(s) only, DNS-checked)
//  - Only serves image/* responses, capped at 8 MB

import { createClient } from '@supabase/supabase-js';
import dns from 'node:dns/promises';

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 9000;

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

function isPrivateIpv4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    a >= 224;
}

function isPrivateIpv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const mapped = v.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.includes(':')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isPrivateIpv4(host)) return false;
  return true;
}

async function hostResolvesPublic(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) return false;
    for (const r of records) {
      if (r.family === 4 && isPrivateIpv4(r.address)) return false;
      if (r.family === 6 && isPrivateIpv6(r.address)) return false;
    }
    return true;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await authedUser(req);
  if (auth.configured && !auth.user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const src = String((req.query && req.query.src) || '').trim();
    if (!isPublicHttpUrl(src) || !(await hostResolvesPublic(new URL(src).hostname))) {
      res.status(400).json({ ok: false, error: 'invalid_url' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let imgRes;
    try {
      imgRes = await fetch(src, {
        signal: controller.signal,
        redirect: 'manual', // no redirect following — the URL came from our own scraper
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
    } finally {
      clearTimeout(timer);
    }

    const ctype = (imgRes.headers.get('content-type') || '').toLowerCase();
    if (!imgRes.ok || !ctype.startsWith('image/')) {
      res.status(422).json({ ok: false, error: 'not_an_image' });
      return;
    }

    const reader = imgRes.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        reader.cancel();
        res.status(413).json({ ok: false, error: 'image_too_large' });
        return;
      }
      chunks.push(value);
    }

    const ext = ctype.includes('png') ? 'png' : ctype.includes('webp') ? 'webp' : 'jpg';
    res.setHeader('Content-Type', ctype);
    res.setHeader('Content-Disposition', `attachment; filename="car-photo.${ext}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).send(Buffer.concat(chunks));
  } catch (e) {
    console.error('download-image error:', e && e.message);
    res.status(500).json({ ok: false, error: 'download_failed' });
  }
}
