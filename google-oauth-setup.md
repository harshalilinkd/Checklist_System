# Google OAuth Setup for Checklist System

This walks through enabling **Sign in with Google** for the app. The code is already wired up (login screen has a Google button; backend rejects anyone whose email isn't in the `doers` table). What's left is **dashboard configuration** in two places: Google Cloud Console + Supabase.

## Step 1 — Create Google OAuth credentials

1. Go to https://console.cloud.google.com/
2. Pick (or create) a project. For example "Checklist System Auth"
3. **APIs & Services** → **OAuth consent screen**
   - User type: **External** (unless you're on Google Workspace and want internal-only)
   - App name: `Checklist System`
   - User support email: your admin email
   - Developer contact email: same
   - Save & continue through the next pages (Scopes, Test Users, Summary)
   - You don't need to add scopes — Supabase requests `openid email profile` by default
4. **APIs & Services** → **Credentials** → **+ Create Credentials** → **OAuth client ID**
   - Application type: **Web application**
   - Name: `Checklist System Web`
   - **Authorized JavaScript origins** — add:
     - `http://localhost:8080` (local dev)
     - `https://checklist-system-one.vercel.app` (your Vercel production URL — change to match)
   - **Authorized redirect URIs** — add EXACTLY:
     - `https://hwawiudaevydbglzdync.supabase.co/auth/v1/callback`
   - Click **Create**
5. Copy the **Client ID** and **Client Secret** that appear in the dialog. You'll paste them into Supabase in the next step.

> **Important:** the redirect URI points to Supabase, NOT to your app. Supabase handles the OAuth callback, then redirects to your app with a session attached.

## Step 2 — Configure Supabase Auth

1. Go to https://supabase.com/dashboard/project/hwawiudaevydbglzdync/auth/providers
2. Find **Google** in the providers list → click to expand → toggle **Enable Sign in with Google**
3. Paste the **Client ID** and **Client Secret** from Step 1
4. **Skip nonce check**: leave OFF (default)
5. Click **Save**

## Step 3 — Lock down sign-ups

This is what prevents random Google accounts from creating new auth.users.

1. https://supabase.com/dashboard/project/hwawiudaevydbglzdync/auth/sign-up-settings
2. Toggle **Allow new users to sign up** to **OFF**
3. Click **Save**

After this: any Google sign-in from an email that doesn't already have a row in `auth.users` will be rejected by Supabase before the OAuth flow even completes. Combined with the backend check (which verifies the email exists in `doers`), you get two layers of defense.

## Step 4 — Add Redirect URLs in Supabase

Supabase needs to know which URLs your app can redirect back to after OAuth.

1. https://supabase.com/dashboard/project/hwawiudaevydbglzdync/auth/url-configuration
2. **Site URL**: `https://checklist-system-one.vercel.app` (or whichever URL is your production frontend)
3. **Redirect URLs** — add each on its own line:
   - `http://localhost:8080`
   - `https://checklist-system-one.vercel.app`
   - `https://checklist-system-one.vercel.app/*` (wildcard for sub-paths)
4. Click **Save**

## Step 5 — Pre-provision existing users (already done)

For Google OAuth to recognize your existing users, their email must already exist in `auth.users` with `email_confirm: true`. This was done by `scripts/provision-users.js`. So nothing new needed for current users.

For **new** users in the future:
1. Add them to `doers` (via the Doers tab in the app or directly in the DB)
2. Add their `auth.users` row using `scripts/provision-users.js` (one-time) so Supabase can match the OAuth identity to the existing user

Without step 2, a new doer signing in with Google will be rejected by Supabase (because new sign-ups are disabled).

## How it all works at runtime

```
User clicks "Sign in with Google"
         ↓
supabase.auth.signInWithOAuth({ provider: 'google' })
         ↓
Browser redirects to accounts.google.com
         ↓
User picks Google account, grants email/profile permission
         ↓
Google redirects to https://hwawiudaevydbglzdync.supabase.co/auth/v1/callback
         ↓
Supabase checks: does this email exist in auth.users?
   • YES (pre-provisioned)  → create session, redirect to your app with session attached
   • NO (and signups OFF)  → reject, redirect with error
         ↓
Your app loads, getSession() restores the session
         ↓
afterLogin() calls /api/bootstrap
         ↓
Backend checks: is user.isAdmin OR is user.email in doers?
   • YES → return data, app loads normally
   • NO  → 403, frontend signs the user out and shows "Not authorized"
```

## Testing checklist

After setup:

1. **Allowed user signs in via Google** → lands on dashboard/master with their data
2. **Disallowed user signs in via Google** (e.g. an existing Google account not in doers) → backend returns 403 → frontend signs them out and shows error
3. **Email/password login still works** as fallback for users who haven't linked Google yet
4. **Refreshing the page keeps you signed in** (Supabase session persists in localStorage)
5. **Clicking Logout** clears the session — next Google sign-in shows the account picker (because we pass `prompt: 'select_account'`)

## Common errors

- **"redirect_uri_mismatch"** in Google's error page: the redirect URI in Google Cloud doesn't exactly match `https://hwawiudaevydbglzdync.supabase.co/auth/v1/callback`. Check it character by character — no trailing slash, no http vs https mix-up.
- **"Database error finding user"** from Supabase: usually means new sign-ups are disabled but you're trying to sign in with a Google account that has no `auth.users` row. Either enable sign-ups temporarily to let Supabase create the row, or provision the user via `provision-users.js` first.
- **403 from `/api/bootstrap`**: working as intended — the user is authenticated to Supabase but their email isn't in `doers`. Add them via the Doers tab.
