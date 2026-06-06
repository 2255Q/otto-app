// Otto — Stripe Checkout Session Creator (Vercel serverless function, Node 18+ ESM)
// Creates a Stripe Checkout Session for subscription billing.
// Security/flow notes:
//  - Requires authenticated user (Bearer token via Supabase, same as /api/generate).
//  - Stripe keys live ONLY in process.env.STRIPE_SECRET_KEY and process.env.STRIPE_PUBLISHABLE_KEY.
//  - Looks up or creates a Stripe customer linked to the user's Supabase profile.
//  - Maps plan_tier to Stripe price IDs (set in Stripe dashboard, then saved in env vars or hardcoded).
//  - Returns the checkout session URL for the client to redirect to, or error details on failure.

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Plan tiers match www.leadotto.com pricing: Starter $49 / Professional $99 / Elite $149.
// Stripe Price IDs come from the Stripe Dashboard (https://dashboard.stripe.com/products):
// create each product with a monthly recurring price, then set env vars in Vercel:
//    - STRIPE_PRICE_ID_STARTER=price_...
//    - STRIPE_PRICE_ID_PROFESSIONAL=price_...
//    - STRIPE_PRICE_ID_ELITE=price_...
// (Legacy BASIC/PRO/PREMIUM env names are accepted as fallbacks.)
const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_ID_STARTER || process.env.STRIPE_PRICE_ID_BASIC || '',
  professional: process.env.STRIPE_PRICE_ID_PROFESSIONAL || process.env.STRIPE_PRICE_ID_PRO || '',
  elite: process.env.STRIPE_PRICE_ID_ELITE || process.env.STRIPE_PRICE_ID_PREMIUM || ''
};

// Verify the caller's Supabase login. Returns {configured, user}.
async function authedUser(req) {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return { configured: false, user: null };

  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return { configured: true, user: null };

  try {
    const supa = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await supa.auth.getUser(token);
    if (error || !data || !data.user) return { configured: true, user: null };
    return { configured: true, user: data.user };
  } catch (e) {
    console.error('Auth error:', e.message);
    return { configured: true, user: null };
  }
}

// Get or create a Stripe customer for the given user.
// Returns {stripe_customer_id, success: true} or {success: false, error: "..."}
async function getOrCreateStripeCustomer(stripe, supa, user) {
  try {
    // Fetch user's profile to check for existing stripe_customer_id.
    // `profile` is reassigned in the missing-profile branch below, so it must be `let`.
    let { data: profile, error: fetchErr } = await supa
      .from('profiles')
      .select('id, stripe_customer_id, email')
      .eq('id', user.id)
      .single();

    if (fetchErr) {
      // If profile doesn't exist, create one
      if (fetchErr.code === 'PGRST116') {
        const { data: newProfile, error: createErr } = await supa
          .from('profiles')
          .insert([{ id: user.id, email: user.email }])
          .select('id, stripe_customer_id')
          .single();

        if (createErr) {
          console.error('Profile creation error:', createErr.message);
          return { success: false, error: 'Could not create profile' };
        }
        profile = newProfile;
      } else {
        console.error('Profile fetch error:', fetchErr.message);
        return { success: false, error: 'Could not fetch profile' };
      }
    }

    // If customer already exists, return it
    if (profile.stripe_customer_id) {
      return { stripe_customer_id: profile.stripe_customer_id, success: true };
    }

    // Create a new Stripe customer
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      metadata: {
        supabase_user_id: user.id
      }
    });

    // Update profile with stripe_customer_id
    const { error: updateErr } = await supa
      .from('profiles')
      .update({ stripe_customer_id: customer.id })
      .eq('id', user.id);

    if (updateErr) {
      console.error('Profile update error:', updateErr.message);
      return { success: false, error: 'Could not link Stripe customer' };
    }

    return { stripe_customer_id: customer.id, success: true };
  } catch (e) {
    console.error('Stripe customer error:', e.message);
    return { success: false, error: 'Stripe customer error' };
  }
}

export default async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  // Optional origin lock
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed) {
    const origin = req.headers.origin || '';
    if (origin && origin !== allowed) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }
  }

  // Reject oversized requests
  const len = Number(req.headers['content-length'] || 0);
  if (len > 2048) {
    res.status(413).json({ ok: false, error: 'request_too_large' });
    return;
  }

  // Require authentication
  const auth = await authedUser(req);
  if (auth.configured && !auth.user) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  // Check Stripe key (only the secret key is needed server-side)
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('Stripe secret key not configured');
    res.status(503).json({ ok: false, error: 'stripe_unconfigured' });
    return;
  }

  try {
    const stripe = new Stripe(secretKey);
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const planTier = String(body.plan_tier || '').toLowerCase();

    // Validate plan tier (canonical: starter/professional/elite; accept legacy names)
    const TIER_ALIASES = { basic: 'starter', pro: 'professional', premium: 'elite' };
    const tier = TIER_ALIASES[planTier] || planTier;
    if (!['starter', 'professional', 'elite'].includes(tier)) {
      res.status(400).json({ ok: false, error: 'invalid_plan_tier' });
      return;
    }

    const priceId = PRICE_IDS[tier];
    if (!priceId || priceId.includes('xxxxx')) {
      console.error(`Price ID not configured for tier: ${tier}`);
      res.status(503).json({ ok: false, error: 'price_id_not_configured' });
      return;
    }

    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
    const supa = createClient(supabaseUrl, supabaseSecret, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Get or create Stripe customer
    const customerResult = await getOrCreateStripeCustomer(stripe, supa, auth.user);
    if (!customerResult.success) {
      res.status(400).json({ ok: false, error: customerResult.error });
      return;
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerResult.stripe_customer_id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      // App is a single static page — send users back to / (a /billing path would 404)
      success_url: `${process.env.APP_URL || 'https://app.leadotto.com'}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'https://app.leadotto.com'}/?checkout=cancelled`,
      metadata: {
        plan_tier: tier,
        supabase_user_id: auth.user.id
      }
    });

    // checkout_url is what the frontend reads; url kept for compatibility
    res.status(200).json({ ok: true, url: session.url, checkout_url: session.url });
  } catch (e) {
    console.error('Checkout error:', e.message);
    if (e.type === 'StripeInvalidRequestError') {
      res.status(400).json({ ok: false, error: 'stripe_error', message: e.message });
    } else {
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  }
}
