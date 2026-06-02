# Consulting marketing site

A standalone consulting marketing website deployed as its own Cloudflare Pages
project. Business-specific content (name, tagline, about, services, hours, FAQs)
is served **live from the Customer Gateway** via a thin server-side proxy — the
browser never talks to the gateway directly. Pricing plans are the only content
the gateway doesn't provide, so they live in an editable JSON file.

## Architecture

```
Browser ──POST /api/<tool>──▶ Pages Function (functions/api/[tool].js)
  { args, turnstileToken }        │  1. allow-list the tool
                                  │  2. verify Turnstile token (server-side)
                                  │  3. add Authorization: Bearer <GATEWAY_SITE_KEY>
                                  ▼
                    https://<TENANT_SUBDOMAIN>.customer-gateway.com/api/<tool>
                                  ▼
                          gateway JSON ──relayed back──▶ Browser
```

1. **The browser never calls the gateway and never sees the gateway key.**
2. **Always proxy** — the gateway has no CORS and rejects anonymous traffic.
3. **Abuse protection on our edge** — every form has a Turnstile widget; the
   token is verified server-side before anything is forwarded.

Turnstile is required for the data-submitting tools (`check_eligibility`,
`create_enquiry`, `book_consultation`, `request_booking_change`,
`confirm_booking_change`). Read tools (`list_services`, `get_business_info`,
`check_availability`) are not gated.

## Single source of truth

The site is brand-agnostic. On every page, `hydrateChrome()` fills the brand
name, page title, footer and contact details from `get_business_info`. The home
page additionally renders the about/approach copy, the "how it works" steps, the
team, and the service list live from the gateway. **Reconfigure the gateway
tenant and the site follows automatically** — no code change needed.

The two things NOT driven by the gateway:

- **Pricing plans** → `public/assets/plans.json` (edit this).
- **Structural marketing copy** → generic headings/value-props in the HTML.

## Project layout

```
public/
  index.html      home (hero + live services/approach/steps/team + plans teaser)
  services.html   services (from list_services) + fit check (check_eligibility)
  pricing.html    engagement plans (from plans.json)
  book.html       book a call: check_availability → book_consultation
  enquiry.html    create_enquiry
  manage.html     reschedule/cancel via emailed PIN
  contact.html    business info + hours + fees + FAQ (from get_business_info)
  llms.txt        points AI assistants at the gateway MCP endpoint
  _headers        security + caching headers (CSP)
  assets/
    styles.css    design system (Bricolage Grotesque + Hanken Grotesk)
    app.js        gateway client, Turnstile, chrome hydration, page logic
    plans.json    EDIT ME — pricing plans
functions/api/
  [tool].js       the proxy (Turnstile verify + bearer forward)
  config.js       returns the public Turnstile site key only
wrangler.toml     Pages config + non-secret vars
.dev.vars.example template for local secrets
```

## Cloudflare Pages variables

Set these on the Pages project (**Settings → Variables and secrets**), for both
Production and Preview. Or via CLI.

| Variable | Type | Required | Value / purpose |
| --- | --- | --- | --- |
| `GATEWAY_SITE_KEY` | **Secret** | yes | Bearer token sent to the gateway |
| `TURNSTILE_SECRET_KEY` | **Secret** | yes | Server-side Turnstile verification |
| `TENANT_SUBDOMAIN` | Plaintext | yes | Gateway subdomain (e.g. `zacwill`) — also in wrangler.toml |
| `TURNSTILE_SITE_KEY` | Plaintext | recommended | Public Turnstile widget key — also in wrangler.toml |

```bash
wrangler pages secret put GATEWAY_SITE_KEY
wrangler pages secret put TURNSTILE_SECRET_KEY
```

Plaintext vars in `wrangler.toml [vars]` are applied on deploy; dashboard values
override them. Secrets must be set in the dashboard or via `wrangler pages
secret put` — never commit them.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in a real GATEWAY_SITE_KEY
npm run dev                      # http://localhost:8788
```

Turnstile test keys are used by default so forms work locally. You need a real
`GATEWAY_SITE_KEY` for gateway-backed content (business info, services, booking)
to load; otherwise the site shows its graceful fallbacks.

## Deploy

```bash
npm run deploy            # wrangler pages deploy
```

(Or connect the Git repo in the Cloudflare dashboard for push-to-deploy.)
