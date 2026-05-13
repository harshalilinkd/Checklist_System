# Deploying Checklist Sys to Render

## Prerequisites

- A GitHub account and a repo containing this project (everything from `Checklist Sys/`)
- A Render account (free tier works) — sign up at https://render.com
- Your Supabase project (already provisioned: `hwawiudaevydbglzdync`)

## Step 1 — Push code to GitHub

```bash
cd "Checklist Sys"
git init
git add .
git commit -m "Initial commit"
gh repo create checklist-sys --private --source=. --push
# or push manually to a repo you create in the GitHub UI
```

`.gitignore` already excludes `.env`, `node_modules`, and the `*.log` files.
**Do not commit your `.env`** — its keys are in there.

## Step 2 — Connect to Render

1. https://dashboard.render.com → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render auto-detects [render.yaml](render.yaml) and proposes two services:
   - `checklist-backend` (Node web service)
   - `checklist-frontend` (Static site)
4. Click **Apply** — both services start provisioning

## Step 3 — Set backend env vars

In the Render dashboard for `checklist-backend` → **Environment**, add:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | `https://hwawiudaevydbglzdync.supabase.co` |
| `SUPABASE_SERVICE_KEY` | (from your local `.env`) |
| `SUPABASE_ANON_KEY` | (from your local `.env`) |
| `DATABASE_URL` | (from your local `.env`) |
| `ADMIN_EMAILS` | `harshali.linkd@gmail.com,maheshgavhane150@gmail.com,dhawdenikita25@gmail.com,aditya.linkd@gmail.com,ai.linkdprints@gmail.com` |
| `FRONTEND_URL` | `https://checklist-frontend.onrender.com` (your static-site URL — see Step 4) |

`NODE_ENV` and `APP_TIMEZONE` are set in `render.yaml` — no manual entry needed.

> **DATABASE_URL refresher:** Settings → Database → Connection string → **Transaction** tab. Replace `[YOUR-PASSWORD]` with your DB password and URL-encode any `@` as `%40`. Your current value is the IPv4 pooler URL (`aws-1-ap-southeast-1`), which is what Render needs.

## Step 4 — Update frontend with the backend URL

After deployment, Render assigns URLs like:
- Backend: `https://checklist-backend.onrender.com`
- Frontend: `https://checklist-frontend.onrender.com`

Edit [frontend/app.js](frontend/app.js):

```js
const PRODUCTION_API_BASE = 'https://checklist-backend.onrender.com';
```

Replace with the actual URL Render gave you, commit, and push. Render auto-deploys on push.

Then, back in the backend Environment, set `FRONTEND_URL` to the actual frontend URL so CORS allows it.

## Step 5 — Smoke test

Open the frontend URL, log in. Compare login speed to the old GAS app — should be 1–2 seconds vs 15–40 on Sheets.

## Production gotchas

- **Free tier sleep:** Render free instances sleep after 15 min of no traffic. The first request after sleep takes ~30 seconds to wake. Upgrading to Starter ($7/mo) eliminates this.
- **Supabase connection cap:** Free tier shares 60 connections across all clients. The Postgres pool is intentionally capped at 5 (`PG_POOL_MAX`); raise via env var only if you hit pool-exhaustion errors.
- **Cron jobs run inside the backend process.** If the free instance is sleeping at 02:00 IST, the archive job won't fire. Two options:
  1. Upgrade to a paid plan (always-on)
  2. Use a free uptime pinger (cron-job.org, UptimeRobot) hitting `/api/health` every 10 minutes
- **Scaling beyond free:** the backend is stateless (no in-memory state besides the LRU cache); you can run multiple instances safely. The cache will go cold per-instance but that's a 60s impact, not correctness.

## Rollback / redeploy

- Push a fix → Render auto-deploys
- Render keeps deploy history; click any prior deploy → **Redeploy** to roll back

## Local dev after deploy

Locally you keep using `node backend/server.js` and `node frontend/serve.js`. The frontend's `isLocal` check switches between `http://localhost:3000` and the production URL automatically based on `window.location.hostname`.
