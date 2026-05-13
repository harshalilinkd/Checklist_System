# Checklist Migration — Prompt Set

Six prompts. Run them in order in your AI coding tool (Claude Code / Cursor / etc.).
Between each prompt, run the verification command and confirm it works.
If verification fails, tell the AI to fix it before moving to the next prompt.

**Stack lock-in:**
- Database: Supabase (PostgreSQL) with Supabase Auth for login
- Backend: Node.js + Express
- Frontend: Vanilla JS (HTML/CSS, no framework)
- Hosting: local first, then Render

**Architecture decisions made (don't let the AI second-guess these):**
- No `live_buffer` table — query `master_checklist` directly with indexes
- Window-filtered API responses (today-2 to today+30 + all Delayed rows)
- Pagination kicks in only if a window response exceeds 500 rows
- Supabase Auth handles login, JWT, password reset
- Cache: 60s for master_checklist, 6h for doers/tasks (rarely change)
- Optimistic UI for Mark Done

---

## PROMPT 1 — Database schema and migration scripts

```
You're helping me migrate a checklist app from Google Sheets to Supabase
(PostgreSQL). Create the database schema and a CSV-import migration script.

PROJECT SETUP (do this first):
- Create a folder called `checklist-migration`
- Inside it, create subfolders: `db/`, `scripts/`, `data/` (for CSVs)
- Create a `package.json` with these dependencies:
  pg, dotenv, csv-parse, @supabase/supabase-js
- Create a `.env.example` file with:
  SUPABASE_URL=
  SUPABASE_SERVICE_KEY=
  DATABASE_URL=
  ADMIN_EMAILS=admin1@example.com,admin2@example.com

SCHEMA REQUIREMENTS:

Create `db/001_schema.sql` with these tables:

1. doers
   - id: serial primary key
   - name: text not null
   - department: text
   - email: text unique not null
   - created_at: timestamptz default now()

2. tasks
   - task_id: text primary key (UUIDs from existing system, e.g. "abc-123")
   - task_name: text not null
   - doer_email: text not null references doers(email)
   - frequency: text not null check (frequency in
     ('D','W','F','M','Q','Y','SM','E1ST','E2ND','E3RD','E4TH','ELAST'))
   - start_date: date not null
   - end_date: date
   - assigned_by: text
   - status: text not null default 'Active' check (status in ('Active','Inactive'))
   - created_at: timestamptz default now()
   - updated_at: timestamptz default now()

3. master_checklist
   - id: bigserial primary key
   - occurrence_key: text unique not null
   - task_id: text not null references tasks(task_id) on delete cascade
   - doer_email: text not null references doers(email)
   - planned_date: date not null
   - actual_date: date
   - status: text not null default 'Scheduled' check (status in
     ('Scheduled','Today','Delayed','Upcoming Focus','Done'))
   - created_at: timestamptz default now()
   - updated_at: timestamptz default now()

4. archive
   Same shape as master_checklist plus archived_at timestamptz default now()

INDEXES (critical for performance — don't skip these):

create index idx_master_planned on master_checklist(planned_date);
create index idx_master_doer_planned on master_checklist(doer_email, planned_date);
create index idx_master_status on master_checklist(status) where status != 'Done';
create index idx_master_occurrence on master_checklist(occurrence_key);
create index idx_tasks_doer on tasks(doer_email);

TRIGGERS:
Add a trigger that updates `updated_at` on every UPDATE to tasks and master_checklist.

MIGRATION SCRIPT:

Create `scripts/import-from-csv.js` that:
- Reads CSVs from data/doers.csv, data/tasks.csv, data/master_checklist.csv
- Connects to Postgres using DATABASE_URL from .env
- Imports in this order: doers → tasks → master_checklist (respecting FKs)
- Uses upsert (on conflict do update) so it's safe to re-run
- Logs row counts at each step
- Handles date format DD/MM/YYYY (the existing Sheet locale) and converts
  to ISO YYYY-MM-DD before insert
- Handles empty cells gracefully (treats them as NULL, not empty string)

Print all created files at the end. Don't run anything yet.
```

**Verify before moving to Prompt 2:**
1. Run `npm install` — should complete without errors
2. Open Supabase project SQL editor, paste contents of `db/001_schema.sql`, run
3. Confirm in Supabase dashboard that all 4 tables appear
4. Export your current Sheets to CSV, save as `data/doers.csv` etc.
5. Run `node scripts/import-from-csv.js` — should print row counts matching your sheet

---

## PROMPT 2 — Supabase Auth setup and user provisioning

```
Set up Supabase Auth for this project and create a script that provisions
the existing users from the old Users sheet.

In Supabase dashboard, I need to enable Email/Password auth (assume already
done, just write the code that uses it).

CREATE: scripts/provision-users.js

This script reads `data/users.csv` (columns: email, name, role, password)
and for each row:
- Calls supabase.auth.admin.createUser() with email + password
- Sets email_confirm: true (so users don't need to verify email)
- Stores the user's role ('admin' or 'user') in user_metadata
- Skips users that already exist (don't error)
- Logs success/failure for each row

Use SUPABASE_SERVICE_KEY from .env (admin operations require service key,
not anon key).

CREATE: backend/auth.js (we'll use this in Prompt 3)

Export a function `verifyToken(token)` that:
- Takes a JWT from the Authorization header
- Calls supabase.auth.getUser(token)
- Returns { email, role, isAdmin } where isAdmin is true if either:
  a) user_metadata.role === 'admin', OR
  b) email is in the ADMIN_EMAILS env var (comma-separated list)
- Throws if token is invalid

Why both checks for admin? user_metadata is set at provisioning time;
ADMIN_EMAILS is a runtime override so I can promote someone without
running a script. Belt and suspenders.

Print all files. Don't run yet.
```

**Verify before moving to Prompt 3:**
1. Make sure email/password auth is enabled in Supabase dashboard → Authentication → Providers
2. Create `data/users.csv` from your existing Users sheet
3. Run `node scripts/provision-users.js`
4. In Supabase dashboard → Authentication → Users, confirm your users appear

---

## PROMPT 3 — Backend Express server (the core of the system)

```
Build the Node.js + Express backend for this checklist app. Use the schema
and auth setup from previous steps.

CREATE: backend/server.js (entry point)

Routes (all routes except /api/health require Authorization: Bearer <jwt>):

GET  /api/health              — returns { ok: true, ts: <timestamp> }
GET  /api/me                  — returns current user { email, isAdmin }
GET  /api/bootstrap           — returns { doers, tasks, masterWindow }
                                 doers/tasks: full lists if admin, filtered if user
                                 masterWindow: rows in window (see below)
GET  /api/master              — paginated master rows (only if needed)
                                 query params: cursor, limit (default 500, max 500)
POST /api/tasks                — create task + generate occurrences (admin only)
PUT  /api/tasks/:id            — update task (admin only)
DELETE /api/tasks/:id          — delete task + cascade master rows (admin only)
POST /api/doers                — create doer (admin only)
PUT  /api/doers/:id            — update doer (admin only)
DELETE /api/doers/:id          — delete doer (admin only, only if no tasks)
POST /api/master/:occurrenceKey/done  — mark a master row done
                                         body: { actual_date? } default today

WINDOW QUERY LOGIC (the most important part):

The "master window" is what loads on bootstrap. It must include:
- All rows where status = 'Delayed' (regardless of date) — never hide overdue work
- All rows where planned_date BETWEEN today-2 AND today+30
For non-admins, additionally filter by doer_email = currentUser.email.

ORDER BY planned_date ASC.

If the result exceeds 500 rows, return only the first 500 plus
{ nextCursor: <last_row_id> } in the response. Otherwise nextCursor: null.

OCCURRENCE GENERATION LOGIC (when a task is created or updated):

Given a task with frequency F, start_date S, end_date E (or S + 1 year if no E),
generate one row per occurrence into master_checklist:

- D (daily): every day from S to E
- W (weekly): same weekday as S, every 7 days
- F (fortnightly): same weekday as S, every 14 days
- M (monthly): same day-of-month as S; if month doesn't have that day,
  use last day of month
- Q (quarterly): every 3 months from S
- Y (yearly): every 12 months from S
- SM (semi-monthly): 1st and 15th of every month (or nearest weekday — keep simple, just 1st and 15th)
- E1ST (1st <weekday> of month): if S is the first Monday of a month,
  generate first Monday of every subsequent month
- E2ND, E3RD, E4TH: same pattern, 2nd/3rd/4th occurrence
- ELAST: last <weekday> of every month

For each occurrence, occurrence_key = task_id + '_' + planned_date_iso.
Use upsert (on conflict (occurrence_key) do nothing) so re-saving a task
is idempotent.

STATUS COMPUTATION (run on every read, don't store dynamically computed status):

Computed in the SELECT, not stored:
  CASE
    WHEN status = 'Done' THEN 'Done'
    WHEN planned_date < CURRENT_DATE THEN 'Delayed'
    WHEN planned_date = CURRENT_DATE THEN 'Today'
    WHEN planned_date <= CURRENT_DATE + 7 AND frequency != 'D' THEN 'Upcoming Focus'
    ELSE 'Scheduled'
  END AS status

Wait — frequency is on tasks, not master_checklist. Join tasks to get frequency
for the Upcoming Focus rule. Or denormalize freq into master_checklist
(simpler, faster, slight storage cost). Choose denormalize: add `freq` column
to master_checklist, populate during occurrence generation.

CACHING:
Use a simple in-memory Map for caching. Key format:
  `master:${userEmail}:${dateString}`
TTL: 60 seconds.
Invalidate on any POST/PUT/DELETE to that user's master rows.

For doers and tasks (small, rarely change):
  TTL: 6 hours, invalidate on any change to those tables.

Use the `lru-cache` npm package (cleaner than rolling your own).

ERROR HANDLING:
- All errors return JSON: { error: <message>, code: <http_code> }
- Use try/catch in every async route, no unhandled rejections
- Log all 500 errors with full stack trace to console

DEPENDENCIES to add to package.json:
express, cors, @supabase/supabase-js, lru-cache, date-fns, pg

CREATE these files:
- backend/server.js (entry, route registration)
- backend/auth.js (already exists from prompt 2, extend it)
- backend/db.js (pg pool with connection from DATABASE_URL)
- backend/cache.js (lru-cache instances)
- backend/routes/bootstrap.js
- backend/routes/master.js
- backend/routes/tasks.js (with occurrence generation)
- backend/routes/doers.js
- backend/lib/occurrences.js (the recurrence math, well-tested)
- backend/lib/status.js (status computation helper)

Print all files. Don't run yet.
```

**Verify before moving to Prompt 4:**
1. Run `npm install`
2. Start with `node backend/server.js` — should print "Listening on :3000"
3. Test health: `curl http://localhost:3000/api/health` — should return `{"ok":true,...}`
4. Get a JWT from Supabase: in dashboard, go to Authentication → Users, click a user → Generate Magic Link, OR use the frontend (Prompt 4) to log in
5. Test bootstrap: `curl -H "Authorization: Bearer <jwt>" http://localhost:3000/api/bootstrap` — should return doers, tasks, masterWindow
6. Confirm row counts match what you expect

---

## PROMPT 4 — Frontend (vanilla HTML/CSS/JS)

```
Build the frontend in vanilla JS. Single-page app, no framework, no build step.
The backend is at http://localhost:3000.

CREATE: frontend/index.html, frontend/styles.css, frontend/app.js

LAYOUT:
- Top header: app title, current user email, Logout button
- Tabs (admin only): Dashboard / Doers / Tasks / Master Checklist
  Non-admin: only "My Checklist" tab visible
- Below header: tab content area

LOGIN SCREEN (shown when not authenticated):
- Email input
- Password input
- Login button
- On submit: call supabase.auth.signInWithPassword({email, password})
  Use the @supabase/supabase-js client loaded from CDN:
  https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm

Store the supabase client globally. After login:
- Get session.access_token (this is the JWT we send to backend)
- Store in window.SESSION = { token, email, isAdmin: ... }
- Call /api/me to determine isAdmin
- Switch to main app view

ALL FETCH CALLS use a wrapper:
  async function api(path, opts = {}) {
    opts.headers = { ...(opts.headers || {}),
                     'Authorization': 'Bearer ' + SESSION.token,
                     'Content-Type': 'application/json' };
    const res = await fetch('http://localhost:3000' + path, opts);
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  }

BOOTSTRAP FLOW:
On login success:
- Show "Loading..." overlay
- Call /api/bootstrap (parallel with /api/me)
- Cache result in window.STATE = { doers, tasks, master }
- Render the default tab (Master Checklist for users, Dashboard for admins)
- Hide overlay

MASTER CHECKLIST TABLE:
Columns: Date, Task, Doer, Frequency, Status, Action
For each row, render a "Done" button if status != 'Done'.
Add filter row above table:
  - Doer dropdown (admin only — auto-populated from doers list)
  - Task dropdown — CASCADING: when doer changes, task dropdown shows
    only that doer's tasks
  - Status filter (All / Delayed / Today / Upcoming Focus / Scheduled / Done)
  - Date range (from/to)

CASCADING FILTER LOGIC:
function cascadeTasksForDoer(doerEmail) {
  const taskSelect = document.getElementById('filterTask');
  taskSelect.innerHTML = '<option value="">All</option>';
  const filtered = doerEmail
    ? STATE.tasks.filter(t => t.doer_email === doerEmail)
    : STATE.tasks;
  for (const t of filtered) {
    taskSelect.add(new Option(t.task_name, t.task_id));
  }
}
Wire onchange of doer dropdown to call cascadeTasksForDoer.

OPTIMISTIC MARK DONE:
function markDone(occurrenceKey) {
  // 1. Update local state immediately
  const row = STATE.master.find(r => r.occurrence_key === occurrenceKey);
  if (row) { row.status = 'Done'; row.actual_date = new Date().toISOString().slice(0,10); }
  rerenderMasterTable();

  // 2. Hit the server
  api('/api/master/' + occurrenceKey + '/done', { method: 'POST', body: '{}' })
    .catch(err => {
      // 3. Rollback on failure
      if (row) { row.status = 'Today'; row.actual_date = null; }
      rerenderMasterTable();
      alert('Could not save: ' + err.message);
    });
}

DASHBOARD (admin only):
Cards showing counts: Total / Delayed / Today / Upcoming / Done
Computed from STATE.master in JS (no extra API call needed).

DOERS / TASKS PAGES (admin only):
Standard CRUD tables with Add / Edit / Delete buttons.
Modals for add/edit forms.

STYLING:
Use plain CSS, modern flexbox/grid layout. Aim for clean and functional,
not flashy. Keep CSS under 200 lines.

CONFIG:
Put SUPABASE_URL and SUPABASE_ANON_KEY in a config object at the top of
app.js. These are public values (anon key is safe in frontend code).

Print all three files. Don't run yet.
```

**Verify before moving to Prompt 5:**
1. Open `frontend/index.html` in a browser (use a simple http server: `npx http-server frontend -p 8080`, or just open the file directly)
2. Login with one of the users you provisioned in Prompt 2
3. Confirm Master Checklist loads and shows your data
4. Test cascading filter: select a doer, confirm task dropdown updates
5. Click "Done" on a row, confirm it updates instantly and persists on refresh
6. Logout and log back in as admin — confirm you see Dashboard / Doers / Tasks tabs

---

## PROMPT 5 — Background jobs and operational endpoints

```
Add two background jobs and one operational endpoint. The jobs run in the
same Node process (no separate worker needed for this scale).

CREATE: backend/jobs/archive.js

Once a day, move rows from master_checklist to archive where:
- status = 'Done'
- actual_date < CURRENT_DATE - INTERVAL '30 days'

Use a transaction:
  BEGIN;
  INSERT INTO archive (...) SELECT ... FROM master_checklist WHERE ...;
  DELETE FROM master_checklist WHERE id IN (the same set);
  COMMIT;

Log how many rows were archived.

CREATE: backend/jobs/extend-occurrences.js

Once a week, for each task with no end_date or end_date > 6 months from now,
generate any missing occurrences for the next 12 months. This prevents the
master_checklist from running out of future rows. Idempotent — uses the
same upsert from prompt 3.

REGISTER JOBS:

In server.js, use the `node-cron` package:
  cron.schedule('0 2 * * *', archiveJob);     // daily at 2am
  cron.schedule('0 3 * * 0', extendJob);      // weekly Sunday 3am

Add `node-cron` to dependencies.

OPERATIONAL ENDPOINTS:

GET /api/admin/stats — admin only, returns:
  - doers count
  - tasks count
  - master rows count
  - archive rows count
  - oldest/newest planned_date in master
  - last archive run timestamp

POST /api/admin/run-job — admin only, body: { job: 'archive' | 'extend' }
  Runs the job immediately on demand. Useful for testing.

LOGGING:

Add a simple request logger middleware that prints:
  [METHOD] [PATH] [STATUS] [DURATION_MS] [USER_EMAIL]
For every request. Useful for debugging slow endpoints.

Print all changed/new files.
```

**Verify before moving to Prompt 6:**
1. Restart server, confirm cron jobs register without errors
2. Hit `POST /api/admin/run-job` with `{"job": "archive"}` — confirm rows move
3. Check `GET /api/admin/stats` — confirm counts make sense
4. Watch logs as you use the app — confirm format is readable

---

## PROMPT 6 — Render deployment

```
Prepare this app for deployment to Render's free tier.

CREATE: render.yaml

Define two services:
1. Web service for backend (Node):
   - root: backend/
   - build: npm install
   - start: node server.js
   - env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY,
     DATABASE_URL, ADMIN_EMAILS, NODE_ENV=production
2. Static site for frontend:
   - root: frontend/
   - publish: frontend/
   - build: (no build needed)

CREATE: render-deployment.md

Document:
- How to create the Render account and project
- Where to set each env var
- How to get DATABASE_URL from Supabase (Settings → Database → Connection string)
- How to update frontend's API_BASE_URL from localhost to the Render URL
- CORS — backend must allow the static-site origin

UPDATE: backend/server.js

Add CORS middleware:
  app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
  }));

Add a graceful shutdown handler that closes the pg pool on SIGTERM
(Render sends SIGTERM on deploys).

UPDATE: frontend/app.js

Change:
  const API_BASE = window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://YOUR-RENDER-BACKEND-URL.onrender.com';

PRODUCTION CONSIDERATIONS section in render-deployment.md:
- Render free tier sleeps after 15 min idle (first request can take 30s)
- Connection pool limit on Supabase free: 60 connections — set pg pool max to 5
- For mission-critical use, upgrade to Render paid ($7/mo eliminates sleep)

Print all changed files.
```

**Final verification:**
1. Push to GitHub
2. Connect repo to Render
3. Deploy both services
4. Smoke test the deployed URL
5. Compare login speed to old GAS app (this should be the moment of truth — 1-2s vs 15-40s)

---

## Tips for running these prompts

**Be specific when you tell the AI to fix something.** Don't say "this doesn't work." Say "the /api/bootstrap endpoint returns a 500 with this stack trace: <paste>". Specific errors get specific fixes.

**Run one prompt at a time.** Resist the urge to paste all six at once. The verification step between each is what catches drift early.

**Keep prompts isolated.** When you start prompt 3, the AI doesn't need to re-read prompt 1's schema — it just needs to know the table names and structure. If your AI tool has memory/context limits, summarize prior decisions briefly at the top of each new prompt.

**Run the verification command BEFORE telling the AI you're moving to the next prompt.** If the verification fails, the AI fixes it now. After moving to the next prompt, going back is more work because new context has accumulated.

**Don't let the AI "improve" the architecture mid-way.** If during prompt 4 the AI suggests "actually, we should use React" — say no. Architectural drift mid-build is how projects die.

## Common failure modes I'd watch for

- AI invents column names that don't match the schema (always paste the schema in if asked)
- AI uses `select * from master_checklist` without the window filter, then wonders why it's slow
- AI generates one massive 1000-line file instead of the modular structure I specified
- AI uses `localStorage` for the JWT (it's vulnerable to XSS) — Supabase's client handles this correctly by default, but if AI starts manually managing tokens, push back
- AI forgets to handle the case where `end_date` is NULL for a task (occurrence generation should default to start_date + 1 year)

## After everything works

Open issues for these known limitations:
- Real-time updates between users (would need Supabase Realtime subscriptions)
- Mobile responsive design (the prompts produce a desktop-first layout)
- Email notifications for delayed tasks (separate cron job + email service)
- File uploads (proof of completion photos) — would need Supabase Storage

Don't try to add these in the initial build. Get the core working first.
