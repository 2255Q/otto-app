# Otto App - Handoff to Opus

**Date:** June 6, 2026  
**Status:** Haiku 4.5 switching to Opus  
**Current Deployment:** https://otto-app-seven.vercel.app/ (PRODUCTION)

---

## PROJECT OVERVIEW

**Otto** is an AI-powered social media content generator for automotive salespeople. Salespeople paste dealership car listings → Otto auto-fills vehicle data + photos → generates social media copy for Facebook, Instagram, TikTok, etc.

**Business Model:** Tiered SaaS subscription ($49 Starter, $99 Professional, $149 Elite)

---

## COMPLETED (OPUS BUILT)

✅ Full authentication system (Supabase)
✅ User signup/signin endpoints
✅ Subscription payment integration (Stripe)
✅ Pricing modal & checkout flow
✅ Subscription gating (subscription_status endpoint)
✅ Vehicle listing generation (Claude Haiku + Anthropic API)
✅ Social media post generation (Facebook, Instagram, TikTok, Craigslist, LinkedIn)
✅ Stripe webhook for payment confirmation
✅ Environment variable configuration (Vercel)
✅ Frontend UI (responsive, professional design)
✅ Database schema (Supabase PostgreSQL)

---

## IN PROGRESS (HAIKU STARTED, INCOMPLETE)

⏳ **Dealership Web Scraper** (NEW FEATURE)
- Created `/api/scrape-listing.js` - extracts car data + images from dealership URLs
- Updated frontend with URL input + "Auto-fill from URL" button
- Integrated image display (shows real dealership photos instead of AI-generated)
- **Status:** Code written, NOT YET DEPLOYED to production

---

## WHAT NEEDS TO BE DONE

### Priority 1: Deploy Dealership Scraper
1. Review `/api/scrape-listing.js` for quality (Haiku code quality may be suboptimal)
2. Test with real dealership URLs (e.g., Mercedes-Benz Jacksonville)
3. Improve scraper for edge cases (different dealership website structures)
4. Deploy to production (https://otto-app-seven.vercel.app/)

### Priority 2: Test Complete E2E Flow
1. User signup → create account
2. Paste dealership URL → auto-fill form with car data + photos
3. Click "Generate listing" → get AI copy + real photos
4. Verify Stripe checkout works (test card: 4242 4242 4242 4242)
5. Confirm subscription gate works

### Priority 3: Bug Fixes (Optional)
- Subscription gate modal not showing visually (backend working, frontend display issue)
- GitHub webhook broken (using manual Vercel deploys as workaround)

---

## KEY FILES & STRUCTURE

```
otto-app/
├── index.html                    # Frontend (HTML/CSS/JS - all in one file)
├── package.json                  # Dependencies (Anthropic, Supabase, Stripe)
├── vercel.json                   # Vercel configuration
├── api/
│   ├── auth/
│   │   ├── signin.js            # POST /api/auth/signin
│   │   └── signup.js            # POST /api/auth/signup
│   ├── generate.js              # POST /api/generate (AI copy generation)
│   ├── generate-image.js        # POST /api/generate-image (DALL-E - NOT USED NOW)
│   ├── scrape-listing.js        # POST /api/scrape-listing (NEW - DEALERSHIP SCRAPER)
│   ├── subscription/
│   │   └── status.js            # GET /api/subscription/status
│   ├── checkout.js              # POST /api/checkout (Stripe)
│   ├── webhook.js               # POST /api/webhook (Stripe events)
│   ├── _middleware.js           # CORS/auth middleware
│   └── import.js                # File import handler
└── HANDOFF.md                   # This file
```

---

## API ENDPOINTS

### Authentication
- **POST /api/auth/signup** - Create new user (email, password, name)
- **POST /api/auth/signin** - Sign in user (email, password)
- Returns: user object + JWT session token

### Vehicle Data
- **POST /api/scrape-listing** - Scrape dealership URL
  - Input: `{ url: "https://dealership.com/car/..." }`
  - Output: `{ vehicle: {...}, images: [...] }`
- **POST /api/generate** - Generate AI copy
  - Input: `{ year, make, model, price, mileage, features, history }`
  - Output: `{ facebook, instagram, tiktok, craigslist, hashtags, pack }`

### Subscription
- **GET /api/subscription/status** - Check user's subscription
  - Returns: `{ plan_tier, status }`
- **POST /api/checkout** - Create Stripe checkout session
  - Input: `{ plan_tier: "starter"|"professional"|"elite" }`
  - Returns: `{ checkout_url: "https://stripe.com/..." }`

### Webhooks
- **POST /api/webhook** - Stripe events (payment_intent.succeeded, etc.)
  - Updates subscription_status in database to "active"

---

## ENVIRONMENT VARIABLES (Vercel)

**Required:**
```
SUPABASE_URL=https://nvaedkxlhyajomioezfp.supabase.co
SUPABASE_ANON_KEY=sb_publishable_CxLX-YyObMexmDdYUvNjxw_DbhFXoSz
SUPABASE_SECRET_KEY=[Secret key - in Supabase settings]
ANTHROPIC_API_KEY=[Anthropic API key for Claude]
STRIPE_SECRET_KEY=[Stripe secret key]
STRIPE_WEBHOOK_SECRET=[Stripe webhook signing secret]
OPENAI_API_KEY=[OpenAI API key for DALL-E - optional]
```

---

## DATABASE SCHEMA (Supabase)

**Tables:**
- `auth.users` - Supabase built-in auth table
- `public.subscriptions` - User subscription data
  - user_id, plan_tier, subscription_status, stripe_subscription_id, stripe_customer_id, current_period_start, current_period_end

---

## TESTING CHECKLIST

### Signup/Signin
- [ ] Create new account with email/password
- [ ] Sign in with credentials
- [ ] JWT token returned and stored

### Dealership Scraper
- [ ] Paste Mercedes-Benz Jacksonville URL
- [ ] Form auto-fills (year, make, model, price, mileage)
- [ ] Car images load (6+ images displayed)
- [ ] Click "Generate listing"

### Content Generation
- [ ] AI generates Facebook post
- [ ] AI generates Instagram post
- [ ] AI generates TikTok caption
- [ ] Real dealership photos display above copy
- [ ] "Copy" button works

### Subscription/Payment
- [ ] Unsubscribed users see "🔒 Upgrade" badge on Generate button
- [ ] Click badge → pricing modal appears
- [ ] Select plan → Stripe checkout page
- [ ] Use test card 4242 4242 4242 4242 (expiry: 12/25, CVC: any 3 digits)
- [ ] Payment succeeds → webhook updates subscription_status to "active"
- [ ] User can now generate listings without gate

---

## KNOWN ISSUES

1. **Subscription gate modal not displaying** - Backend subscription checking works, but frontend modal visual doesn't show. Code logic is correct but display needs refinement.

2. **GitHub webhook broken** - Auto-deploy from GitHub not working. Workaround: use Vercel CLI `npx vercel deploy --prod` or redeploy manually from Vercel UI.

3. **DALL-E image generation not integrated** - Code exists (`generate-image.js`) but not used. We're using real dealership photos instead.

---

## DEPLOYMENT

**Current:** https://otto-app-seven.vercel.app/ (PRODUCTION)
**Method:** Vercel (connected to GitHub repo)
**Deployments:** Use Vercel CLI or manual redeploy from Vercel dashboard

**To deploy new code:**
```bash
cd otto-app
npx vercel deploy --prod
```

---

## NEXT STEPS FOR OPUS

1. **Review scraper code** (`/api/scrape-listing.js`) - ensure quality
2. **Test dealership scraper** with multiple real URLs (Mercedes, BMW, Toyota, etc.)
3. **Improve scraper robustness** - handle different website structures
4. **Deploy to production** - full E2E testing
5. **Fix subscription gate display** (optional but nice to have)
6. **Prepare for customer launch**

---

## USER TEST FLOW (for your brother)

**Test URL:** https://otto-app-seven.vercel.app/

1. Sign up: test email + password
2. Paste dealership URL: https://www.mercedesbenzofjacksonville.com/certified/Mercedes-Benz/2025-Mercedes-Benz-GLC-300-...
3. Click "Auto-fill from URL" 
4. Verify: form populated + images load
5. Click "Generate listing"
6. Verify: AI copy + real photos appear
7. Copy posts to clipboard → post to personal social media

---

## CONTACT/NOTES

- **Deployment Domain:** app.leadotto.com (primary) + otto-app-seven.vercel.app (backup)
- **Tech Stack:** Vercel (serverless), Supabase (auth/DB), Stripe (payments), Anthropic Claude (AI), OpenAI DALL-E (images - optional)
- **Model Used:** Claude Haiku 4.5 (for generation) / Should be Claude Opus for development
- **Urgency:** Ready for customer launch once E2E testing complete

---

**Handed off by:** Haiku 4.5  
**Handed to:** Claude Opus  
**Status:** Ready for Opus to take over and improve/complete
