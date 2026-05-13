# Deploying Checklist System to Vercel

Single-deployment setup: static frontend + Express API as a serverless function, both at the same URL. Supabase remains the database.

## Architecture on Vercel

```
your-project.vercel.app/          → static frontend (frontend/index.html)
your-project.vercel.app/api/*    → /api/index.js → backend/server.js (Express)
```

- **/api/index.js** is the only Vercel serverless function. It re-uses the existing Express app.
- **vercel.json** rewrites every `/api/*` request to that one function. Express handles the rest.
- **frontend/** is the static publish directory (no build step).
- **Cron jobs** run via **Vercel Cron** (declared in `vercel.json`) hitting `/api/admin/cron/archive` and `/api/admin/cron/extend`. Those endpoints are auth-checked with a shared secret (`CRON_SECRET`).

## Step 1 — Push to GitHub

```powershell
cd "c:\Users\Admin\Desktop\Checklist Sys"

git init
git add .
git commit -m "Initial commit"

# Via GitHub CLI (recommended)
gh repo create checklist-sys --private --source=. --push

# OR manually via github.com → New repo → then:
#   git remote add origin https://github.com/<your-user>/checklist-sys.git
#   git branch -M main
#   git push -u origin main
```

The `.gitignore` already excludes `.env`, `node_modules`, logs, and the CSV data files — secrets stay local.

## Step 2 — Import the repo into Vercel

1. Go to https://vercel.com/new
2. Sign in with GitHub (if not already)
3. Import the `checklist-sys` repo
4. Vercel auto-detects `vercel.json`. You should see:
   - Framework Preset: **Other**
   - Build Command: `echo 'No build step'`
   - Output Directory: `frontend`
   - Install Command: `npm install` (default)
5. **Do NOT click Deploy yet** — set env vars first (Step 3)

## Step 3 — Set environment variables

In the import screen → **Environment Variables**, add these (all set for **Production**, **Preview**, and **Development**):

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | `https://hwawiudaevydbglzdync.supabase.co` |
| `SUPABASE_SERVICE_KEY` | (from your local `.env`) |
| `SUPABASE_ANON_KEY` | (from your local `.env`) |
| `DATABASE_URL` | (from your local `.env` — pooler URL with `%40` for password's `@`) |
| `ADMIN_EMAILS` | `harshali.linkd@gmail.com,maheshgavhane150@gmail.com,dhawdenikita25@gmail.com,aditya.linkd@gmail.com` |
| `APP_TIMEZONE` | `Asia/Kolkata` |
| `CRON_SECRET` | a long random string (for Vercel Cron auth — e.g. `openssl rand -hex 32`) |

`NODE_ENV` is auto-set by Vercel. `VERCEL=1` is auto-set by Vercel — the code uses it to skip `node-cron` and `app.listen()`.

## Step 4 — Deploy

Click **Deploy**. First build takes ~30–60s. When it's green:

- Open `https://your-project.vercel.app/`
- Log in as `harshali.linkd@gmail.com` / `Harshali123`
- Test all five tabs

## Step 5 — Cron jobs

`vercel.json` registers two Vercel Cron jobs (free tier supports up to 2 per project):

| Path | Schedule (UTC) | What it does |
|------|---------------|--------------|
| `/api/admin/cron/archive` | `0 20 * * *` (= 01:30 IST nightly) | Move Done rows older than 30 days from `master_checklist` to `archive` |
| `/api/admin/cron/extend` | `0 21 * * 6` (= 02:30 IST Sunday) | Generate next 12 months of occurrences for active tasks |

Both endpoints check `Authorization: Bearer ${CRON_SECRET}` — Vercel Cron auto-attaches this header using your `CRON_SECRET` env var.

To run a job manually: `POST /api/admin/run-job` with `{ "job": "archive" }` or `{ "job": "extend" }` (requires admin JWT).

## Production gotchas

- **Cold starts:** first request after ~5 min of idle takes 1–3s (Node serverless cold-start). Subsequent requests are <100ms.
- **No persistent state:** the in-memory LRU cache (`masterCache`, `refCache`) lives only within one serverless instance. A cold start wipes it. This is OK because the caches were designed to be ephemeral; the DB queries are fast.
- **PG pool capped at 1 per instance** (`backend/db.js`) so heavy concurrent load doesn't exhaust Supabase's 60-connection shared cap. Each function instance has its own pool; Vercel may spin up many instances under load.
- **Function timeout:** Vercel Hobby tier = 10s, Pro = 60s. The slowest endpoints (`/api/scorecard`) take ~1–2s on cold start. If you ever see timeouts: upgrade or trim the query window.
- **Region:** in Project Settings → Functions, pick **Singapore (sin1)** or **Mumbai (bom1)** to minimize latency to your Supabase project (also in Singapore/Mumbai region).

## Updating after deploy

Just push to GitHub:

```powershell
git add .
git commit -m "feature: ..."
git push
```

Vercel auto-builds and ships within ~30s. Each deploy gets a unique URL; the `production` alias updates automatically.

To roll back: Vercel dashboard → Deployments → click any prior deploy → **Promote to Production**.
