// Vercel API Middleware for Raw Body Capture
// This middleware captures the raw request body for Stripe webhook signature verification.
// Without this, Stripe signature verification will always fail.
//
// To use this:
// 1. Save this file as: api/_middleware.js (in your project root's api/ folder)
// 2. Restart your development server or redeploy to Vercel
// 3. All requests to api/ will now have access to the raw body

export const config = {
  matcher: ['/api/:path*'],
};

export default async function middleware(req) {
  // Only capture raw body for POST requests (where we expect JSON)
  if (req.method === 'POST') {
    // Clone the request to avoid issues
    const contentType = req.headers.get('content-type') || '';

    // For JSON requests, capture the raw body
    if (contentType.includes('application/json')) {
      const rawBody = await req.text();

      // Store the raw body in the request for the handler to use
      // Different Vercel versions may require different approaches:
      // 1. Via custom header (most compatible)
      const headers = new Headers(req.headers);
      headers.set('X-Raw-Body', Buffer.from(rawBody).toString('base64'));

      // 2. Via request cloning with modified body
      const newReq = new Request(req, {
        headers: headers,
        body: rawBody,
      });

      return newReq;
    }
  }
}
