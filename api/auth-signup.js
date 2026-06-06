// Otto — Sign Up Endpoint (Vercel serverless function, Node 18+ ESM)
// Creates a new user account with email/password and initializes profile.
// Returns authenticated user and session data on success.
//
// Security/flow notes:
//  - Uses Supabase client in client mode (anon key) for signup.
//  - Creates user via signUp(), then creates a profile row in profiles table.
//  - Email confirmation is handled by Supabase (configure in dashboard).
//  - Returns user and session on success.
//  - Rejects oversized requests to prevent abuse.

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
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Supabase keys not configured');
    res.status(503).json({ ok: false, message: 'service_unavailable' });
    return;
  }

  try {
    // Parse request body
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    // Validate inputs
    if (!name || !email || !password) {
      res.status(400).json({ ok: false, message: 'name_email_and_password_required' });
      return;
    }

    // Basic email format check
    if (!email.includes('@')) {
      res.status(400).json({ ok: false, message: 'invalid_email' });
      return;
    }

    // Password minimum length (enforce 6-character minimum as per requirement)
    if (password.length < 6) {
      res.status(400).json({ ok: false, message: 'password_too_short' });
      return;
    }

    // Create Supabase client (anon key for signup)
    const supa = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Sign up with Supabase Auth
    const { data, error } = await supa.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name
        }
      }
    });

    if (error || !data || !data.user) {
      console.warn(`Sign up failed for ${email}: ${error?.message}`);

      // Provide user-friendly error messages for common cases
      if (error?.message?.includes('already registered')) {
        res.status(400).json({ ok: false, message: 'email_already_exists' });
      } else if (error?.message?.includes('invalid')) {
        res.status(400).json({ ok: false, message: 'invalid_input' });
      } else {
        res.status(400).json({ ok: false, message: 'signup_failed' });
      }
      return;
    }

    const userId = data.user.id;

    // Create profile row using secret key (service role)
    // This allows creating the profile even if auth confirmation is pending
    let supa_admin = null;
    if (supabaseSecret) {
      supa_admin = createClient(supabaseUrl, supabaseSecret, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    } else {
      // Fallback: use anon key (profile creation will depend on RLS policies)
      supa_admin = supa;
    }

    const { error: profileError } = await supa_admin
      .from('profiles')
      .insert([{
        id: userId,
        email,
        full_name: name,
        created_at: new Date().toISOString()
      }]);

    if (profileError) {
      // Log the error but don't fail signup — user auth succeeded
      console.warn(`Profile creation failed for user ${userId}: ${profileError.message}`);
      // Attempt to clean up the auth user (optional, depending on your needs)
      // For now, we continue and return the auth response
    }

    // Return user and session
    // Note: session may be null if email confirmation is required
    res.status(201).json({
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
    console.error('Sign up error:', e.message);
    res.status(500).json({ ok: false, message: 'server_error' });
  }
}
