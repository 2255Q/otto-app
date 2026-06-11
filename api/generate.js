// Otto — AI post-pack generator (Vercel serverless function, powered by Claude)
// Security/cost notes:
//  - The API key lives ONLY in process.env.ANTHROPIC_API_KEY (set in Vercel, never sent to the browser).
//  - Inputs are length-capped to bound token usage; output is capped via max_tokens.
//  - On any error or missing key we return {ok:true, fallback:true} so the frontend
//    gracefully uses its built-in template engine instead of breaking.

import { createClient } from '@supabase/supabase-js';

const FIELD_MAX = 200;
const MODEL = 'claude-haiku-4-5-20251001'; // cheap, fast, excellent copy — ~$0.007 per generation
const MAX_TOKENS = 900;                    // hard cap on output cost per call

// Verify the caller's Supabase login. Returns {configured, user}.
// If SUPABASE env vars aren't set yet, auth is treated as "not configured" (open) for rollout.
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

function extractJSON(t) {
  if (!t) return null;
  let s = String(t).trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  // Optional origin lock: set ALLOWED_ORIGIN in Vercel (e.g. https://app.leadotto.com) to enable.
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed) {
    const origin = req.headers.origin || '';
    if (origin && origin !== allowed) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  }

  // Reject oversized request bodies (bounds parse + token cost from abuse).
  const len = Number(req.headers['content-length'] || 0);
  if (len > 4096) { res.status(413).json({ ok: false, error: 'too_large' }); return; }

  // Require a logged-in customer (once Supabase is configured).
  const auth = await authedUser(req);
  if (auth.configured && !auth.user) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // No key configured yet → tell the frontend to use its built-in engine.
    res.status(200).json({ ok: true, fallback: true });
    return;
  }

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const f = k => String(body[k] == null ? '' : body[k]).slice(0, FIELD_MAX);
    const v = {
      year: f('year'), make: f('make'), model: f('model'), trim: f('trim'),
      miles: f('miles'), price: f('price'), color: f('color'), cond: f('cond'),
      features: f('features'), rep: f('rep'), phone: f('phone'),
      booking: f('booking'), city: f('city'), tone: f('tone') || 'friendly'
    };
    // Only treat booking as usable if it's a real http(s) link with no chars
    // that could break out of the prompt/JSON (defense-in-depth on self-input)
    const bookingUrl = (/^https?:\/\/\S+$/i.test(v.booking) && !/["'{}<>]/.test(v.booking)) ? v.booking : '';

    if (!(v.year || v.make || v.model)) {
      res.status(400).json({ ok: false, error: 'missing_vehicle' });
      return;
    }

    const system = "You are an expert automotive social-media copywriter writing on behalf of an individual car salesperson. Write punchy, authentic, ready-to-post marketing copy that sounds like a real person, not a brochure. Rules: never invent specs, features, or claims that were not provided; stay honest and compliant (no guarantees, no false urgency about safety, no discriminatory language); keep it concise. Respond with ONLY a single valid JSON object and nothing else — no markdown, no code fences, no commentary.";

    const user = `Write a social-media post pack for this vehicle. Desired tone: ${v.tone}.

Vehicle: ${[v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')}
Mileage: ${v.miles || 'n/a'}
Price: ${v.price || 'n/a'}
Color: ${v.color || 'n/a'}
Condition: ${v.cond || 'n/a'}
Features: ${v.features || 'n/a'}
Salesperson name: ${v.rep || 'n/a'}
Contact (phone/text): ${v.phone || 'n/a'}
Booking link: ${bookingUrl || 'n/a'}
Market/City: ${v.city || 'n/a'}

Return a JSON object with EXACTLY these keys:
- "marketplaceTitle": short Facebook Marketplace title (year/make/model/trim + price if given)
- "marketplace": Facebook Marketplace description — a few short lines, a bulleted feature list (use "- "), a clear call to action, and a sign-off with the salesperson's name/contact if provided
- "facebook": Facebook/Instagram feed caption — a hook line, key details, a call to action, sign-off; a few tasteful emojis
- "reel": a very short Reel/Story caption (1-3 punchy lines)
- "tiktok": a TikTok caption — casual, hook-first, emojis ok
- "craigslist": a plain-text Craigslist post — NO emojis, include contact info
- "hashtags": an array of 8-12 relevant hashtag strings (include the make, model, and city if given, plus common car-sales tags)

Only use the contact info that was provided. Do not fabricate anything not listed above.${bookingUrl ? ` IMPORTANT: A booking link was provided (${bookingUrl}). In the call-to-action of "marketplace", "facebook", and "craigslist", invite the buyer to book a test drive at that exact link (e.g. "Book a test drive: ${bookingUrl}"). Use the URL verbatim — do not alter, shorten, or invent a different link. Keep "reel" and "tiktok" short; mentioning the link there is optional.` : ''}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.8,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });

    if (!aiRes.ok) {
      res.status(200).json({ ok: true, fallback: true, error: 'ai_upstream' });
      return;
    }

    const j = await aiRes.json();
    const text = j && j.content && j.content[0] && j.content[0].text;
    const result = extractJSON(text);
    if (!result) { res.status(200).json({ ok: true, fallback: true }); return; }

    res.status(200).json({ ok: true, result });
  } catch (e) {
    // Never leak internals; frontend falls back cleanly.
    res.status(200).json({ ok: true, fallback: true });
  }
}
