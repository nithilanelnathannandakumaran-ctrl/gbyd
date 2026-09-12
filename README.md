# GetBetterYouDumbo — deploying to Cloudflare (Pages + D1)

Your app now has a real backend: a Cloudflare Pages Function (`functions/api/[[path]].js`)
talking to a Cloudflare D1 database. Accounts, passwords (hashed), points, progress,
feedback, and messages all live server-side now, instead of in each browser's
localStorage — so a user's progress follows them to any device/browser.

The static site (`public/index.html`) and the API live in the **same** Cloudflare
Pages project, on the same domain, so there's no CORS to configure.

## What you need

- A free Cloudflare account
- Node.js installed locally (for the `wrangler` CLI)

## One-time setup

```bash
npm install -g wrangler
wrangler login          # opens a browser to authorize the CLI
```

## 1. Create the D1 database

```bash
cd gbyd-app
wrangler d1 create gbyd-db
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_DATABASE_ID`.

## 2. Load the schema

```bash
wrangler d1 execute gbyd-db --remote --file=./schema.sql
```

## 3. Deploy

```bash
wrangler pages deploy public --project-name=gbyd-app
```

The first time you run this it'll ask to create the Pages project — say yes.
It will print a URL like `https://gbyd-app.pages.dev` — that's your live site.

## 4. Bind the database to the Pages project

Pages Functions need the D1 binding configured on the Pages project itself
(not just in `wrangler.toml`, which only helps local dev). In the Cloudflare
dashboard:

1. Go to **Workers & Pages → gbyd-app → Settings → Functions**
2. Under **D1 database bindings**, add a binding:
   - Variable name: `DB`
   - D1 database: `gbyd-db`
3. Redeploy (`wrangler pages deploy public --project-name=gbyd-app`) so the
   new binding takes effect.

## 5. Make yourself admin

Sign up in the app with the username `elnathan` (all lowercase) — that
username is hard-coded as the owner account and is automatically made an
admin on signup (see `OWNER_USERNAME` in `functions/api/[[path]].js`). Change
that constant first if you want a different owner username, then redeploy.

## Local development (optional)

```bash
wrangler d1 execute gbyd-db --local --file=./schema.sql
wrangler pages dev public --d1=DB=gbyd-db
```

This runs the whole thing (static site + API + a local copy of the database)
on your machine at `http://localhost:8788`.

## What changed from the original file

- Passwords are hashed (PBKDF2-SHA256, salted) before they ever touch the
  database — the server never stores or sees them in plain text again after
  signup/login.
- Login issues a random session token (stored in the browser's localStorage,
  nothing else is). All other data — accounts, XP, progress, badges,
  feedback, chat — lives in D1 and is fetched over `/api/*`.
- The server enforces who can edit what: everyone can update their own
  progress/points/avatar; only admins can edit other accounts, toggle admin
  status, kick/suspend, force-logout, or delete a user.
- Since two devices can now be logged in as different people at once, the
  app polls `/api/state` every 20s while you're logged in to catch admin
  actions (kicks, suspensions) reasonably quickly; the chat window polls
  every 5s while open.
- Terms-of-service copy was updated since data is no longer "local to your
  browser only."

## Limitations to know about

- This isn't real-time (no websockets) — leaderboard/chat updates arrive on
  the poll interval, not instantly.
- Feedback and chat are simple append-only tables; there's no pagination, so
  very heavy use would need that added later.
