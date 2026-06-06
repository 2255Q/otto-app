// Otto — AI post-pack generator (Vercel serverless function)
// Security/cost notes:
//  - The API key lives ONLY in process.env.OPENAI_API_KEY (set in Vercel, never sent to the browser).
//  - Inputs are length-capped to bound token usage; output is capped via max_tokens.
//  - On any error or missing key we return {ok:true, fallback:true} so the frontend
//    gracefully uses its built-in template engine instead of breaking.

const FIELD_MAX = 200;
const MODEL = 'gpt-4o-mini';   // cheapest capable model — ~$0.001 per generation
const MAX_TOKENS = 900;        // hard cap on output cost per call

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

  const key = process.env.OPENAI_API_KEY;
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
      city: f('city'), tone: f('tone') || 'friendly'
    };

    if (!(v.year || v.make || v.model)) {
      res.status(400).json({ ok: false, error: 'missing_vehicle' });
      return;
    }

    const system = "You are an expert automotive social-media copywriter writing on behalf of an individual car salesperson. Write punchy, authentic, ready-to-post marketing copy that sounds like a real person, not a brochure. Rules: never invent specs, features, or claims that were not provided; stay honest and compliant (no guarantees, no false urgency about safety, no discriminatory language); keep it concise. Respond with ONLY a valid JSON object.";

    const user = `Write a social-media post pack for this vehicle. Desired tone: ${v.tone}.

Vehicle: ${[v.year, v.make, v.model, v.trim].filter(Boolean).join(' ')}
Mileage: ${v.miles || 'n/a'}
Price: ${v.price || 'n/a'}
Color: ${v.color || 'n/a'}
Condition: ${v.cond || 'n/a'}
Features: ${v.features || 'n/a'}
Salesperson name: ${v.rep || 'n/a'}
Contact (phone/text): ${v.phone || 'n/a'}
Market/City: ${v.city || 'n/a'}

Return a JSON object with EXACTLY these keys:
- "marketplaceTitle": short Facebook Marketplace title (year/make/model/trim + price if given)
- "marketplace": Facebook Marketplace description — a few short lines, a bulleted feature list (use "- "), a clear call to action, and a sign-off with the salesperson's name/contact if provided
- "facebook": Facebook/Instagram feed caption — a hook line, key details, a call to action, sign-off; a few tasteful emojis
- "reel": a very short Reel/Story caption (1-3 punchy lines)
- "tiktok": a TikTok caption — casual, hook-first, emojis ok
- "craigslist": a plain-text Craigslist post — NO emojis, include contact info
- "hashtags": an array of 8-12 relevant hashtag strings (include the make, model, and city if given, plus common car-sales tags)

Only use the contact info that was provided. Do not fabricate anything not listed above.`;

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.8,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' }
      })
    });

    if (!aiRes.ok) {
      res.status(200).json({ ok: true, fallback: true, error: 'ai_upstream' });
      return;
    }

    const j = await aiRes.json();
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    let result;
    try { result = JSON.parse(content || '{}'); }
    catch (e) { res.status(200).json({ ok: true, fallback: true }); return; }

    res.status(200).json({ ok: true, result });
  } catch (e) {
    // Never leak internals; frontend falls back cleanly.
    res.status(200).json({ ok: true, fallback: true });
  }
}
