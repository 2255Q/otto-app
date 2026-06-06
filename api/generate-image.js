// Otto — AI Image Generator (Vercel serverless function)
// Generates AI car images using DALL-E 3 based on vehicle description.
// Security notes:
//  - Requires valid Supabase auth token
//  - API key for DALL-E lives in process.env.OPENAI_API_KEY
//  - Returns image URL on success or fallback placeholder on error

import { createClient } from '@supabase/supabase-js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  // Require authentication
  const auth = await authedUser(req);
  if (auth.configured && !auth.user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    // No key configured → return fallback placeholder
    res.status(200).json({
      ok: true,
      fallback: true,
      image_url: 'https://images.unsplash.com/photo-1552820728-8ac41f1ce891?w=800&q=80'
    });
    return;
  }

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const year = String(body.year || '').slice(0, 4);
    const make = String(body.make || '').slice(0, 50);
    const model = String(body.model || '').slice(0, 50);
    const color = String(body.color || '').slice(0, 30);
    const trim = String(body.trim || '').slice(0, 30);

    if (!year || !make || !model) {
      res.status(400).json({ ok: false, error: 'missing_vehicle_info' });
      return;
    }

    // Build a descriptive prompt for DALL-E
    const colorText = color ? ` in ${color}` : '';
    const trimText = trim ? ` ${trim}` : '';
    const prompt = `Professional product photo of a ${year} ${make} ${model}${trimText}${colorText}. Clean, well-lit showroom setting. High quality photography. Focus on front 3/4 view. No watermarks.`;

    // Call DALL-E 3 API
    const dalleRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'url'
      })
    });

    if (!dalleRes.ok) {
      console.warn(`DALL-E API error: ${dalleRes.status}`);
      // Fallback on API error
      res.status(200).json({
        ok: true,
        fallback: true,
        image_url: 'https://images.unsplash.com/photo-1552820728-8ac41f1ce891?w=800&q=80'
      });
      return;
    }

    const dalleData = await dalleRes.json();
    const imageUrl = dalleData.data && dalleData.data[0] && dalleData.data[0].url;

    if (!imageUrl) {
      res.status(200).json({
        ok: true,
        fallback: true,
        image_url: 'https://images.unsplash.com/photo-1552820728-8ac41f1ce891?w=800&q=80'
      });
      return;
    }

    res.status(200).json({
      ok: true,
      fallback: false,
      image_url: imageUrl
    });
  } catch (e) {
    console.error('Image generation error:', e.message);
    // Graceful fallback
    res.status(200).json({
      ok: true,
      fallback: true,
      image_url: 'https://images.unsplash.com/photo-1552820728-8ac41f1ce891?w=800&q=80'
    });
  }
}
