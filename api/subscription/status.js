// Otto — Subscription Status Endpoint (Vercel serverless function, Node 18+ ESM)
// Checks the current user's subscription status and tier.
// Returns subscription_status, plan_tier, and subscription data.
//
// Security/flow notes:
//  - Requires valid authorization header with JWT token from Supabase.
//  - Only accepts GET requests.
//  - Returns subscription status and plan tier on success.
//  - Returns 401 if not authenticated or subscription not found.
//  - No rate limiting here; apply at infrastructure level (Vercel, WAF, etc).

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Only GET allowed
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, message: 'method_not_allowed' });
    return;
  }

  // Check Supabase configuration — use the secret key like the other endpoints
  // so the profiles query isn't blocked by RLS.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase keys not configured');
    res.status(503).json({ ok: false, message: 'service_unavailable' });
    return;
  }

  try {
    // Get authorization header
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (!token) {
      res.status(401).json({ ok: false, message: 'unauthorized' });
      return;
    }

    // Create Supabase client (service role) and verify the user's token
    const supa = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Get user from token
    const { data: { user }, error: userError } = await supa.auth.getUser(token);

    if (userError || !user) {
      console.warn(`Get user failed: ${userError?.message}`);
      res.status(401).json({ ok: false, message: 'unauthorized' });
      return;
    }

    // Query the user's profile — the webhook and checkout write subscription
    // data to `profiles` (plan_tier, subscription_status, stripe_* columns).
    const { data: profile, error: subError } = await supa
      .from('profiles')
      .select('id, plan_tier, subscription_status, stripe_subscription_id, stripe_customer_id, current_period_end, email')
      .eq('id', user.id)
      .single();

    if (subError && subError.code !== 'PGRST116') {
      // PGRST116 = "no rows returned"
      console.warn(`Profile query failed: ${subError?.message}`);
      res.status(500).json({ ok: false, message: 'server_error' });
      return;
    }

    // If no profile or no active subscription, return free tier
    if (!profile || !profile.plan_tier || profile.subscription_status !== 'active') {
      res.status(200).json({
        ok: true,
        plan_tier: null,
        status: 'free',
        email: (profile && profile.email) || user.email || null,
        subscription: null
      });
      return;
    }

    // Return subscription data
    res.status(200).json({
      ok: true,
      plan_tier: profile.plan_tier,
      status: profile.subscription_status,
      email: profile.email || user.email || null,
      subscription: {
        user_id: profile.id,
        plan_tier: profile.plan_tier,
        subscription_status: profile.subscription_status,
        stripe_subscription_id: profile.stripe_subscription_id,
        stripe_customer_id: profile.stripe_customer_id,
        current_period_end: profile.current_period_end
      }
    });
  } catch (e) {
    console.error('Subscription status error:', e.message);
    res.status(500).json({ ok: false, message: 'server_error' });
  }
}
