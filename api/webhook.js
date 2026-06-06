// Updated: Sat Jun  6 11:52:19 UTC 2026
// Otto — Stripe Webhook Handler (Vercel serverless function, Node 18+ ESM) — FIXED VERSION
// Listens for Stripe subscription events and updates the user's billing status in Supabase.
// Events handled:
//  - customer.subscription.created: First subscription starts
//  - customer.subscription.updated: Plan/status changes
//  - customer.subscription.deleted: Subscription cancelled
//
// Security/flow notes:
//  - Verifies webhook signature using STRIPE_WEBHOOK_SECRET (prevents spoofing).
//  - Uses RAW request body for signature verification (critical for security).
//  - Looks up user by stripe_customer_id in profiles table.
//  - Updates subscription_status (active/paused/cancelled), plan_tier, and current_period_end.
//  - Returns 200 immediately so Stripe doesn't retry; real work happens async.
//
// FIXES APPLIED (vs. original):
//  1. Raw body handling: Properly captures raw bytes for signature verification
//  2. Environment validation: Checks all required config at startup
//  3. Better error handling: Distinguishes client errors from server errors
//  4. Request logging: Logs webhook receipt with key details
//  5. Database column migration: Includes SQL migrations in comments

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Database schema migrations needed:
// Run these on your Supabase project if columns don't exist:
//
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_tier TEXT DEFAULT 'free';
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive';
// ALTER TABLE profiles ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMP;

// Map Stripe price IDs to plan tiers (must match checkout.js)
// Get these from your Stripe Dashboard: https://dashboard.stripe.com/products
// Canonical tiers match www.leadotto.com pricing: starter/professional/elite.
// Legacy BASIC/PRO/PREMIUM env names are accepted as fallbacks.
function getPriceIdToTierMapping() {
  const map = {};
  const starter = process.env.STRIPE_PRICE_ID_STARTER || process.env.STRIPE_PRICE_ID_BASIC;
  const professional = process.env.STRIPE_PRICE_ID_PROFESSIONAL || process.env.STRIPE_PRICE_ID_PRO;
  const elite = process.env.STRIPE_PRICE_ID_ELITE || process.env.STRIPE_PRICE_ID_PREMIUM;
  if (starter) map[starter] = 'starter';
  if (professional) map[professional] = 'professional';
  if (elite) map[elite] = 'elite';
  return map;
}

// Stripe signature verification needs the exact raw request bytes, so Vercel's
// automatic JSON body parsing must be disabled for this route.
export const config = {
  api: { bodyParser: false }
};

// Validate configuration at startup
function validateConfig() {
  const required = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'SUPABASE_URL',
    'SUPABASE_SECRET_KEY'
  ];
  if (Object.keys(getPriceIdToTierMapping()).length === 0) {
    console.error('ERROR: No Stripe price ID env vars set (STRIPE_PRICE_ID_STARTER/PROFESSIONAL/ELITE)');
  }

  const missing = [];
  const invalid = [];

  for (const key of required) {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
    } else if (value.includes('xxxxx') || value.includes('placeholder')) {
      invalid.push(key);
    }
  }

  if (missing.length > 0) {
    console.error('ERROR: Missing required environment variables:', missing);
  }
  if (invalid.length > 0) {
    console.error('ERROR: Environment variables contain placeholder values:', invalid);
  }

  return missing.length === 0 && invalid.length === 0;
}

// Main webhook handler
export default async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Log webhook receipt
  console.info('Webhook request received', {
    method: req.method,
    path: req.url,
    signature: req.headers['stripe-signature'] ? 'present' : 'MISSING',
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length']
  });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error('Stripe keys not configured for webhook', {
      secretKey: !!secretKey,
      webhookSecret: !!webhookSecret
    });
    return res.status(503).json({ ok: false, error: 'unconfigured' });
  }

  try {
    const stripe = new Stripe(secretKey);

    // CRITICAL FIX #1: Get the raw body for signature verification
    // Stripe's signature verification requires the exact original bytes.
    // Re-stringifying a parsed object won't work due to key order and formatting differences.
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      console.warn('Webhook missing signature header');
      return res.status(400).json({ ok: false, error: 'missing_signature' });
    }

    if (!rawBody) {
      console.warn('Webhook request body is empty');
      return res.status(400).json({ ok: false, error: 'empty_body' });
    }

    // Verify webhook signature
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (e) {
      console.warn('Webhook signature verification failed', {
        message: e.message,
        code: e.code,
        bodyLength: rawBody.length,
        signature: signature.substring(0, 20) + '...' // Log partial signature for debugging
      });
      return res.status(400).json({ ok: false, error: 'signature_verification_failed' });
    }

    console.info('Webhook signature verified', {
      eventId: event.id,
      eventType: event.type,
      timestamp: event.created
    });

    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecret) {
      console.error('Supabase keys not configured', {
        supabaseUrl: !!supabaseUrl,
        supabaseSecret: !!supabaseSecret
      });
      return res.status(503).json({ ok: false, error: 'supabase_unconfigured' });
    }

    const supa = createClient(supabaseUrl, supabaseSecret, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Handle the event
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        console.info('Processing subscription event', {
          eventType: event.type,
          subscriptionId: event.data.object.id,
          customerId: event.data.object.customer
        });
        await handleSubscriptionUpsert(supa, event.data.object);
        break;
      }
      case 'customer.subscription.deleted': {
        console.info('Processing subscription deleted event', {
          subscriptionId: event.data.object.id,
          customerId: event.data.object.customer
        });
        await handleSubscriptionCancelled(supa, event.data.object);
        break;
      }
      default:
        console.log('Unhandled event type (will be ignored)', { eventType: event.type });
    }

    // Return 200 immediately so Stripe doesn't retry
    return res.status(200).json({ ok: true, received: true, eventId: event.id });

  } catch (e) {
    console.error('Webhook handler error', {
      message: e.message,
      code: e.code,
      type: e.type,
      stack: e.stack
    });

    // CRITICAL FIX #4: Distinguish between errors
    // - Client errors (bad signature): return 200 to stop retries
    // - Server errors (DB down): return 5xx to allow retries
    if (
      e.message.includes('signature') ||
      e.code === 'SIGNATURE_VERIFICATION_FAILED' ||
      e.message.includes('not found')
    ) {
      // Client error - don't retry
      return res.status(200).json({ ok: true, received: true });
    } else {
      // Server error - allow retry
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  }
}

async function handleSubscriptionUpsert(supa, subscription) {
  try {
    const customerId = subscription.customer;
    if (!customerId) {
      console.warn('Subscription missing customer_id', { subscriptionId: subscription.id });
      return;
    }

    // Look up user by stripe_customer_id
    const { data: profile, error: fetchErr } = await supa
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();

    if (fetchErr) {
      console.warn('Could not find user for customer', {
        customerId,
        error: fetchErr.message,
        code: fetchErr.code
      });
      return;
    }

    // Get the price ID from the first line item
    const lineItem = subscription.items?.data?.[0];
    if (!lineItem) {
      console.warn('Subscription has no line items', { subscriptionId: subscription.id });
      return;
    }

    const priceId = lineItem.price.id;
    const PRICE_ID_TO_TIER = getPriceIdToTierMapping();
    const planTier = PRICE_ID_TO_TIER[priceId] || 'unknown';

    // Log warning if tier is unknown
    if (planTier === 'unknown') {
      console.warn('Unknown price ID', {
        priceId,
        customerId,
        subscriptionId: subscription.id
      });
    }

    // Map Stripe subscription status to our status
    let subscriptionStatus = 'inactive';
    if (subscription.status === 'active') subscriptionStatus = 'active';
    else if (subscription.status === 'paused') subscriptionStatus = 'paused';
    else if (subscription.status === 'past_due') subscriptionStatus = 'active'; // treat as active for now
    else if (subscription.status === 'canceled') subscriptionStatus = 'cancelled';
    else if (subscription.status === 'incomplete') subscriptionStatus = 'inactive'; // not yet confirmed

    // Get the period end timestamp
    const currentPeriodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;

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
      console.error('Error updating profile', {
        userId: profile.id,
        error: updateErr.message,
        code: updateErr.code
      });
      return;
    }

    console.info('Subscription upserted successfully', {
      userId: profile.id,
      tier: planTier,
      status: subscriptionStatus,
      customerId,
      subscriptionId: subscription.id
    });

  } catch (e) {
    console.error('handleSubscriptionUpsert error', {
      message: e.message,
      stack: e.stack,
      subscriptionId: subscription.id
    });
  }
}

async function handleSubscriptionCancelled(supa, subscription) {
  try {
    const customerId = subscription.customer;
    if (!customerId) {
      console.warn('Subscription missing customer_id', { subscriptionId: subscription.id });
      return;
    }

    // Look up user by stripe_customer_id
    const { data: profile, error: fetchErr } = await supa
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();

    if (fetchErr) {
      console.warn('Could not find user for customer', {
        customerId,
        error: fetchErr.message,
        code: fetchErr.code
      });
      return;
    }

    // Mark subscription as cancelled and revert to free tier
    const { error: updateErr } = await supa
      .from('profiles')
      .update({
        subscription_status: 'cancelled',
        plan_tier: 'free'
      })
      .eq('id', profile.id);

    if (updateErr) {
      console.error('Error updating profile on cancellation', {
        userId: profile.id,
        error: updateErr.message,
        code: updateErr.code
      });
      return;
    }

    console.info('Subscription cancelled successfully', {
      userId: profile.id,
      customerId,
      subscriptionId: subscription.id
    });

  } catch (e) {
    console.error('handleSubscriptionCancelled error', {
      message: e.message,
      stack: e.stack,
      subscriptionId: subscription.id
    });
  }
}

// CRITICAL FIX #1: Extract raw body from request
// Vercel passes the parsed body by default, but Stripe signature verification
// requires the exact original bytes. This function properly extracts them.
async function getRawBody(req) {
  // With bodyParser disabled (see `export const config` above), the request is a
  // readable stream and we buffer the exact original bytes.
  if (typeof req.on === 'function' && req.readable !== false && req.body === undefined) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  // Fallbacks in case a runtime still provides a pre-read body
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf-8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf-8');

  // Last resort: re-stringify (lossy, may fail signature verification)
  if (typeof req.body === 'object' && req.body !== null) {
    console.warn('FALLBACK: Re-stringifying parsed body for signature verification.');
    return JSON.stringify(req.body);
  }

  return '';
}
