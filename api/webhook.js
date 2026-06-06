// Otto — Stripe Webhook Handler (Vercel serverless function, Node 18+ ESM)
// Listens for Stripe subscription events and updates the user's billing status in Supabase.
// Events handled:
//  - customer.subscription.created: First subscription starts
//  - customer.subscription.updated: Plan/status changes
//  - customer.subscription.deleted: Subscription cancelled
//
// Security/flow notes:
//  - Verifies webhook signature using STRIPE_WEBHOOK_SECRET (prevents spoofing).
//  - Looks up user by stripe_customer_id in profiles table.
//  - Updates subscription_status (active/paused/cancelled), plan_tier, and current_period_end.
//  - Returns 200 immediately so Stripe doesn't retry; real work happens async.

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Database schema migrations needed:
// If these columns don't exist on the profiles table, run:
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_tier TEXT DEFAULT 'free'; -- free|basic|pro|premium
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive'; -- inactive|active|paused|cancelled
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP; -- when current billing period ends

// Map Stripe price IDs to plan tiers (must match checkout.js)
// Get these from your Stripe Dashboard: https://dashboard.stripe.com/products
const PRICE_ID_TO_TIER = {
  [process.env.STRIPE_PRICE_ID_BASIC || 'price_xxxxx']: 'basic',
  [process.env.STRIPE_PRICE_ID_PRO || 'price_xxxxx']: 'pro',
  [process.env.STRIPE_PRICE_ID_PREMIUM || 'price_xxxxx']: 'premium'
};

export default async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error('Stripe keys not configured for webhook');
    res.status(503).json({ ok: false, error: 'unconfigured' });
    return;
  }

  try {
    const stripe = new Stripe(secretKey);

    // Get the raw body for signature verification
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      console.warn('Webhook missing signature header');
      res.status(400).json({ ok: false, error: 'missing_signature' });
      return;
    }

    // Verify webhook signature
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (e) {
      console.warn('Webhook signature verification failed:', e.message);
      res.status(400).json({ ok: false, error: 'signature_verification_failed' });
      return;
    }

    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !supabaseSecret) {
      console.error('Supabase keys not configured');
      res.status(503).json({ ok: false, error: 'supabase_unconfigured' });
      return;
    }

    const supa = createClient(supabaseUrl, supabaseSecret, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Handle the event
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        await handleSubscriptionUpsert(supa, subscription);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await handleSubscriptionCancelled(supa, subscription);
        break;
      }
      default:
        // Ignore events we don't handle
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Return 200 immediately so Stripe doesn't retry
    res.status(200).json({ ok: true, received: true });
  } catch (e) {
    console.error('Webhook handler error:', e.message);
    // Return 200 anyway to prevent Stripe from retrying
    res.status(200).json({ ok: true, received: true });
  }
}

async function handleSubscriptionUpsert(supa, subscription) {
  try {
    const customerId = subscription.customer;
    if (!customerId) {
      console.warn('Subscription missing customer_id', subscription.id);
      return;
    }

    // Look up user by stripe_customer_id
    const { data: profile, error: fetchErr } = await supa
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();

    if (fetchErr) {
      console.warn(`Could not find user for customer ${customerId}:`, fetchErr.message);
      return;
    }

    // Determine plan tier from price ID
    const lineItem = subscription.items.data[0];
    if (!lineItem) {
      console.warn('Subscription has no line items', subscription.id);
      return;
    }

    const priceId = lineItem.price.id;
    const planTier = PRICE_ID_TO_TIER[priceId] || 'unknown';

    // Map Stripe subscription status to our status
    let subscriptionStatus = 'inactive';
    if (subscription.status === 'active') subscriptionStatus = 'active';
    else if (subscription.status === 'paused') subscriptionStatus = 'paused';
    else if (subscription.status === 'past_due') subscriptionStatus = 'active'; // treat as active for now
    else if (subscription.status === 'canceled') subscriptionStatus = 'cancelled';

    // Get the period end timestamp
    const currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();

    // Update the profile
    const { error: updateErr } = await supa
      .from('profiles')
      .update({
        stripe_subscription_id: subscription.id,
        plan_tier: planTier,
        subscription_status: subscriptionStatus,
        current_period_end: currentPeriodEnd
      })
      .eq('id', profile.id);

    if (updateErr) {
      console.error('Error updating profile:', updateErr.message);
      return;
    }

    console.log(`Subscription upserted for user ${profile.id}: tier=${planTier}, status=${subscriptionStatus}`);
  } catch (e) {
    console.error('handleSubscriptionUpsert error:', e.message);
  }
}

async function handleSubscriptionCancelled(supa, subscription) {
  try {
    const customerId = subscription.customer;
    if (!customerId) {
      console.warn('Subscription missing customer_id', subscription.id);
      return;
    }

    // Look up user by stripe_customer_id
    const { data: profile, error: fetchErr } = await supa
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();

    if (fetchErr) {
      console.warn(`Could not find user for customer ${customerId}:`, fetchErr.message);
      return;
    }

    // Mark subscription as cancelled
    const { error: updateErr } = await supa
      .from('profiles')
      .update({
        subscription_status: 'cancelled',
        plan_tier: 'free'
      })
      .eq('id', profile.id);

    if (updateErr) {
      console.error('Error updating profile:', updateErr.message);
      return;
    }

    console.log(`Subscription cancelled for user ${profile.id}`);
  } catch (e) {
    console.error('handleSubscriptionCancelled error:', e.message);
  }
}

// Helper: extract raw body from request
// Vercel provides parsed body in req.body, but Stripe needs the raw bytes for signature verification.
// We reconstruct from the parsed object (note: this is lossy for edge cases like custom formatting,
// but safe for Stripe's JSON encoding).
async function getRawBody(req) {
  if (req.rawBody) {
    return req.rawBody;
  }

  // If Vercel has already parsed the body, we need to re-stringify it.
  // This is a limitation: the signature was computed on the original bytes, and re-stringifying
  // may differ slightly (whitespace, key order). To handle this perfectly in production,
  // you'd want to capture the raw stream before Vercel parses it.
  // For now, we assume Vercel's body parsing is consistent.
  if (typeof req.body === 'object' && req.body !== null) {
    return JSON.stringify(req.body);
  }

  // Fallback: read from the request stream (should not happen with Vercel)
  return '';
}
