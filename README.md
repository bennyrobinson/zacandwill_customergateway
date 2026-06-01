# Zac & Will's Lawyers — marketing site

A standalone marketing website for **Zac & Will's Lawyers**, deployed as its own
Cloudflare Pages project. It integrates with the already-deployed **Customer
Gateway** backend through a thin, server-side proxy — the browser never talks to
the gateway directly.

## Architecture

```
Browser ──POST /api/<tool>──▶ Pages Function (functions/api/[tool].js)
  { args, turnstileToken }        │  1. allow-list the tool
                                  │  2. verify Turnstile token (server-side)
                                  │  3. add Authorization: Bearer <GATEWAY_SITE_KEY>
                                  ▼
                    https://<TENANT_SUBDOMAIN>.customer-gateway.com/api/<tool>
                                  │  body = the tool args (JSON)
                                  ▼
                          gateway JSON ──relayed back──▶ Browser
```

Three rules are non-negotiable and enforced here:

1. **The browser never calls the gateway and never sees the gateway site key.**
   Every gateway call goes through `functions/api/[tool].js`, which holds the
   key server-side.
2. **Always proxy.** The gateway has no CORS and rejects anonymous traffic by
   design, so a direct browser fetch can never succeed — that's intentional.
3. **Abuse protection lives on our edge.** Every form carries a Cloudflare
   Turnstile widget, and the token is verified server-side before anything is
   forwarded to the gateway.

The proxy only forwards an explicit allow-list of tools and requires a verified
Turnstile token for every tool that submits user data (`check_eligibility`,
`create_enquiry`, `book_consultation`, `request_booking_change`,
`confirm_booking_change`). Pure reads used to render the page (`list_services`,
`check_availability`) don't require a token — a Turnstile token is single-use,
and the booking flow checks availability repeatedly before the user submits.

## Project layout

```
public/                 static site (Pages build output dir)
  index.html            home
  services.html         practice areas (live list_services) + eligibility check
  book.html             booking flow: check_availability → pick slot → book_consultation
  enquiry.html          create_enquiry
  manage.html           reschedule/cancel via emailed PIN (request/confirm_booking_change)
  llms.txt              points AI assistants at the gateway's MCP endpoint
  _headers              security + caching headers (incl. CSP)
  assets/
    styles.css          design system
    app.js              gateway() client, Turnstile helper, per-page logic
functions/
  api/
    [tool].js           the proxy (Turnstile verify + bearer forward)
    config.js           returns the public Turnstile site key only
wrangler.toml           Pages config + non-secret vars
.dev.vars.example       template for local secrets
```

## Configuration

| Variable               | Where                         | Secret? | Purpose |
| ---------------------- | ----------------------------- | ------- | ------- |
| `GATEWAY_SITE_KEY`     | `wrangler pages secret put`   | **yes** | Bearer token sent to the gateway |
| `TURNSTILE_SECRET_KEY` | `wrangler pages secret put`   | **yes** | Server-side Turnstile verification |
| `TENANT_SUBDOMAIN`     | `wrangler.toml [vars]`        | no      | `zacwill` → `https://zacwill.customer-gateway.com` |
| `TURNSTILE_SITE_KEY`   | `wrangler.toml [vars]` (opt.) | no      | Public widget key; falls back to a test key |

The Turnstile **site** key is public and served to the browser by
`/api/config`. The Turnstile **secret** key and the gateway key never leave the
server.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in real keys
npm run dev                      # wrangler pages dev → http://localhost:8788
```

Out of the box, `.dev.vars.example` uses Cloudflare's "always passes" Turnstile
test keys so the forms work locally without a real Turnstile sitekey/secret. You
still need a real `GATEWAY_SITE_KEY` for the gateway calls to succeed end-to-end.

## Deploy

```bash
# one-time: set the secrets on the Pages project
wrangler pages secret put GATEWAY_SITE_KEY
wrangler pages secret put TURNSTILE_SECRET_KEY

# set the production Turnstile site key (public) in wrangler.toml [vars],
# then deploy:
npm run deploy
```

(Or connect the Git repo in the Cloudflare dashboard for push-to-deploy, and set
the variables/secrets there.)

## Gateway tools

`POST /api/<tool>` with body `{ "args": { ... }, "turnstileToken": "..." }`.
The proxy forwards `args` to the gateway and relays the JSON response.

| Tool | Args | Turnstile |
| ---- | ---- | --------- |
| `list_services` | `{}` | no |
| `check_eligibility` | `{ service, incident_date?, state?, summary? }` | yes |
| `check_availability` | `{ service, from, to }` | no |
| `book_consultation` | `{ service, start, attendee:{name,email,phoneNumber?}, notes? }` | yes |
| `create_enquiry` | `{ service, contact:{name,email,phoneNumber?}, message? }` | yes |
| `request_booking_change` | `{ booking_ref, email, action:"reschedule"\|"cancel", new_start? }` | yes |
| `confirm_booking_change` | `{ challenge_id, pin }` | yes |

Service IDs for this tenant: `personal_injury`, `workers_compensation`,
`medical_negligence`, `motor_vehicle_accident`.
