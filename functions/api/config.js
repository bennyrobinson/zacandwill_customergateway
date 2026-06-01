/**
 * Public front-end config.
 *
 * Returns only values that are safe for the browser to see — currently the
 * Turnstile *site* key (public by design). The Turnstile secret key and the
 * gateway bearer key never leave the server. A static file (config.js) takes
 * precedence over the [tool].js dynamic route, so this never hits the proxy.
 *
 * Defaults to Cloudflare's "always passes" Turnstile test site key so local
 * development works with no configuration. Set TURNSTILE_SITE_KEY in production.
 */

const TEST_SITE_KEY = "1x00000000000000000000AA"; // Cloudflare test key (always passes)

export function onRequestGet({ env }) {
  return new Response(
    JSON.stringify({
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || TEST_SITE_KEY,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    }
  );
}
