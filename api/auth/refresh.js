// Otto — Session refresh endpoint (Vercel serverless function, Node 18+ ESM)
// POST /api/auth/refresh  { refresh_token }
// Supabase access tokens expire after ~1 hour. The frontend calls this to get
// a fresh session instead of forcing the salesperson to sign in again.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    res.status(503).json({ ok: false, error: 'service_unavailable' });
    return;
  }

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const refreshToken = String(body.refresh_token || '').trim();
    if (!refreshToken) {
      res.status(400).json({ ok: false, error: 'missing_refresh_token' });
      return;
    }

    const supa = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await supa.auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data || !data.session) {
      res.status(401).json({ ok: false, error: 'refresh_failed' });
      return;
    }

    res.status(200).json({ ok: true, user: data.user, session: data.session });
  } catch (e) {
    console.error('Refresh error:', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
}
