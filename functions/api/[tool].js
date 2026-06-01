/**
 * Customer Gateway proxy — Cloudflare Pages Function.
 *
 * This is the ONLY thing that ever talks to the gateway. The browser posts
 *   { args: {...}, turnstileToken }
 * to /api/<tool>. We verify the Turnstile token (for any tool that submits
 * data), then forward the args to the gateway with the secret bearer key the
 * browser never sees, and relay the gateway's JSON straight back.
 *
 * The gateway has no CORS and rejects anonymous traffic by design, so a direct
 * browser fetch can never work — everything goes through here.
 *
 * Required environment:
 *   GATEWAY_SITE_KEY       (secret) bearer token for the gateway
 *   TURNSTILE_SECRET_KEY   (secret) Cloudflare Turnstile secret
 *   TENANT_SUBDOMAIN       e.g. "zacwill" -> https://zacwill.customer-gateway.com
 */

// Only these tools may be proxied. Anything else is rejected outright so the
// proxy can never become an open relay to arbitrary gateway endpoints.
const ALLOWED_TOOLS = new Set([
  "list_services",
  "get_business_info",
  "check_eligibility",
  "check_availability",
  "book_consultation",
  "create_enquiry",
  "request_booking_change",
  "confirm_booking_change",
]);

// Tools that submit user/personal data must carry a verified Turnstile token.
// Pure reads used to render the page (service list, availability lookup) do not
// — a Turnstile token is single-use and the booking flow checks availability
// repeatedly before the user ever submits anything.
const TURNSTILE_REQUIRED = new Set([
  "check_eligibility",
  "book_consultation",
  "create_enquiry",
  "request_booking_change",
  "confirm_booking_change",
]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

async function verifyTurnstile(token, secret, remoteip) {
  if (!token) return { ok: false, reason: "missing-token" };
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteip) form.append("remoteip", remoteip);

  let res;
  try {
    res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );
  } catch {
    return { ok: false, errored: true };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: data.success === true, data };
}

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const tool = params.tool;

  if (!ALLOWED_TOOLS.has(tool)) {
    return json({ error: "Unknown tool." }, 404);
  }

  // Guard against oversized payloads before parsing.
  const raw = await request.text();
  if (raw.length > 100_000) {
    return json({ error: "Payload too large." }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const args = payload.args ?? {};
  const turnstileToken = payload.turnstileToken;

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return json({ error: "`args` must be an object." }, 400);
  }

  // Verify abuse protection at our edge before anything reaches the gateway.
  if (TURNSTILE_REQUIRED.has(tool)) {
    if (!env.TURNSTILE_SECRET_KEY) {
      return json({ error: "Turnstile is not configured on the server." }, 500);
    }
    const remoteip = request.headers.get("CF-Connecting-IP") || undefined;
    const result = await verifyTurnstile(
      turnstileToken,
      env.TURNSTILE_SECRET_KEY,
      remoteip
    );
    if (result.errored) {
      return json(
        { error: "Couldn't run the security check. Please try again." },
        502
      );
    }
    if (!result.ok) {
      return json(
        { error: "Verification failed. Please refresh and try again." },
        403
      );
    }
  }

  if (!env.GATEWAY_SITE_KEY || !env.TENANT_SUBDOMAIN) {
    return json({ error: "Gateway is not configured on the server." }, 500);
  }

  const gatewayUrl = `https://${env.TENANT_SUBDOMAIN}.customer-gateway.com/api/${tool}`;

  let gatewayRes;
  try {
    gatewayRes = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.GATEWAY_SITE_KEY}`,
      },
      body: JSON.stringify(args),
    });
  } catch {
    return json(
      { error: "Could not reach the booking service. Please try again." },
      502
    );
  }

  // Relay the gateway's JSON (and status) straight back to the browser.
  const text = await gatewayRes.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: "Unexpected response from the booking service." };
  }
  return json(body, gatewayRes.status);
}

// POST is handled by onRequestPost above; this catches every other method.
export async function onRequest() {
  return json({ error: "Method not allowed." }, 405);
}
