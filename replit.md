# VPN Cuba

A Telegram bot + Express.js web admin dashboard for managing a WireGuard VPN service in Cuba.

## Architecture

- **Runtime**: Node.js 20
- **Framework**: Express.js (serves both API and static frontend)
- **Database**: Supabase (PostgreSQL + Storage Buckets)
- **Bot**: Telegraf (Telegram bot framework, webhook mode)
- **Frontend**: Static HTML/CSS/JS in `public/` directory
- **Port**: 5000 (bound to 0.0.0.0)

## Features

- Telegram Bot with inline keyboard menus
- Admin web dashboard (`/admin.html`) protected by JWT
- User plan management (Básico, Avanzado, Premium, Anual)
- Payment processing (bank transfer screenshots + manual USDT)
- WireGuard config file delivery to users
- Free trial system with file pool
- Multi-level referral system (Level 1: 20%, Level 2: 10%)
- Supabase Storage Buckets: `payments-screenshots`, `plan-files`, `trial-files`

## Project Structure

```
index.js          # Main entry — Express server + Telegraf bot logic (~3600 lines)
supabase.js       # Supabase DB abstraction layer
bot.js            # (auxiliary bot helpers)
start-all.js      # Multi-process launcher
monitor.js        # Bot health monitoring
public/           # Static frontend files
  admin.html      # Admin dashboard
  admin-login.html
  plans.html      # Plans/payment web app
  payment.html
  garantias.html  # guarantee information
  index.html      # Landing page
  how.html, faq.html, politicas.html
  css/style.css
uploads/          # Local temp storage for screenshots and config files
  trial_files/    # Trial config file pool
ecosystem.config.js  # PM2 config (for reference)
```

## Environment Variables / Secrets Required

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (admin) |
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `JWT_SECRET` | Secret for signing admin JWT tokens |
| `WEBAPP_URL` | Public URL (used for Telegram webhook + WebApp links) |
| `API_BASE_URL` | Same as WEBAPP_URL |
| `PORT` | Server port (set to 5000) |

## Admin Telegram IDs
There is a SuperAdmin who has controll about all allowed admins. This SuperAdmin can add or erase admins manually whenever he wants. 

## Deployment

Configured as a **VM deployment** (always-on) since it runs a persistent Telegram bot.  
Run command: `node index.js`

**Note**: When deployed to production, update `WEBAPP_URL` and `API_BASE_URL` to the production `.replit.app` domain so the Telegram webhook points correctly.

## NOVA — AI customer support

- The separate `NOVA` chat is exposed in the support hub and powered server-side by OpenRouter Free with Cloudflare Workers AI as a fallback.
- Configure `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID` as deployment secrets; set `NOVA_ENABLED=true` only after staging tests. It defaults to disabled. Do not expose the key to the frontend.
- Configure `NOVA_OPENROUTER_MODEL`, `NOVA_OPENROUTER_DAILY_LIMIT`, `NOVA_OPENROUTER_RPM_LIMIT`, and `NOVA_CLOUDFLARE_DAILY_NEURON_LIMIT` as needed. The Cloudflare model is fixed to a verified Workers Free model and the OpenRouter model selector rejects paid model IDs. The free tier is rate-limited and not a production SLA; see `NOVA_SETUP.md`.
- `routes/nova.js` validates Telegram Web App `initData` using `BOT_TOKEN`; it does not connect the model to payments, account changes, VPN configuration, or admin tools.
- NOVA does not require new Supabase tables. Existing support tickets continue to work independently.
