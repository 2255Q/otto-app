// Otto — Sign In Endpoint (Vercel serverless function, Node 18+ ESM)
// Authenticates user with email and password using Supabase Auth.
// Returns authenticated user and session data on success.
//
// Security/flow notes:
//  - Uses Supabase client in client mode (anon key) for password auth.
//  - Only accepts POST requests.
//  - Returns user and session on success.
//  - Rejects oversized requests to prevent abuse.
//  - No rate limiting here; apply at infrastructure level (Vercel, WAF, etc).

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'method_not_allowed' });
    return;
  }

  // Reject oversized requests
  const len = Number(req.headers['content-length'] || 0);
  if (len > 1024) {
    res.status(413).json({ ok: false, message: 'request_too_large' });
    return;
  }

  // Check Supabase configuration
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Supabase keys not configured');
    res.status(503).json({ ok: false, message: 'service_unavailable' });
    return;
  }

  try {
    // Parse request body
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    // Validate inputs
    if (!email || !password) {
      res.status(400).json({ ok: false, message: 'email_and_password_required' });
      return;
    }

    // Basic email format check (not comprehensive, but catches obvious issues)
    if (!email.includes('@')) {
      res.status(400).json({ ok: false, message: 'invalid_email' });
      return;
    }

    // Sign in with Supabase
    const supa = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data, error } = await supa.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data || !data.user) {
      // Generic error message to avoid leaking user enumeration info
      console.warn(`Sign in failed for ${email}: ${error?.message}`);
      res.status(401).json({ ok: false, message: 'invalid_credentials' });
      return;
    }

    // Return user and session
    res.status(200).json({
      ok: true,
      user: {
        id: data.user.id,
        email: data.user.email,
        user_metadata: data.user.user_metadata || {}
      },
      session: {
        access_token: data.session?.access_token,
        refresh_token: data.session?.refresh_token,
        expires_at: data.session?.expires_at
      }
    });
  } catch (e) {
    console.error('Sign in error:', e.message);
    res.status(500).json({ ok: false, message: 'server_error' });
  }
}
