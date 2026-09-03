# Running Cursus day to day

Written for someone who has not operated a live service before. It assumes
nothing except that the site is deployed on Render, which it now is:

```
https://cursus-fcbw.onrender.com
```

---

## Before anything else: nobody can sign up yet

This is not a bug in the deployment. It is a gap in the product that only
becomes visible once the site is live, and it is the single most important thing
on this page.

**Candidate sign-up requires two codes: one to the email address, one to the
phone number.** Both are enforced by the server (`assertContactsVerified` in
`server/src/index.js`). Email can be delivered — Resend does it. **SMS has no
provider wired.** A code sent to a phone is printed to the server log and
nowhere else.

So today a real stranger who finds the site cannot finish signing up. They will
enter their phone number, wait for a text, and no text will ever arrive.

The tempting fix is the wrong one. `OTP_ECHO=true` makes the API return the code
to the browser, which unblocks sign-up **and means anyone who knows somebody's
email address can sign in as them.** Never turn it on in production.

The three real options:

1. **Wire an SMS provider** (Twilio or similar). `server/src/notify.js` has one
   branch — `if (channel === 'phone')` — that prints instead of sending. That is
   the only place that changes.
2. **Stop requiring phone verification**, and verify the email alone. A product
   decision, not a technical one.
3. **Leave it as is** while the site is something you show people rather than
   something strangers use. You can still create accounts yourself, because you
   can read the log.

Until one of those happens, the live site is a demo you control, not an open
service.

---

## Part 1 — Where everything is

Render's left-hand menu, on the `cursus` service. Five things matter.

### Logs — every email, every code, every error

**MONITOR → Logs.**

This is the running server's console. Anything the app prints appears here live.
It is where you read:

**Sign-in and verification codes.** They are printed in a box:

```
┌─ candidate sign-in code (SMS not wired) ─────────────
│  to phone:  0501234567
│  code:      284913
│  valid for: 10 minutes
└──────────────────────────────────────────────────────
```

**Every email**, while `RESEND_API_KEY` is unset — the whole message, printed
rather than sent:

```
┌─ email ──────────────────────────────────────────────
│  to:      someone@example.com
│  subject: You're approved — here's your company key
│  …
└──────────────────────────────────────────────────────
```

Once you set `RESEND_API_KEY`, emails go to real inboxes and stop appearing
here. **SMS codes keep appearing here regardless**, because there is no SMS
provider — see the warning above.

There is a search box. Searching `code:` finds every verification code;
searching `email` finds every message sent.

Logs are **not kept forever.** Render holds a rolling window. If you need
something permanently, copy it out.

### Shell — a terminal inside the live server

**MANAGE → Shell.**

A real command prompt on the machine, in your project directory. This is how you
inspect and repair live data. Everything in Part 2 runs here.

Two things to know: the shell disconnects when idle, and anything you type runs
against **real data** with no undo. There is no staging safety net inside this
window.

### Environment — the settings

**MANAGE → Environment.**

The six values you were asked for at deploy (`APP_URL`, `RESEND_API_KEY`,
`MAIL_FROM`, `MAIL_REPLY_TO`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`) are edited
here, any time. Saving redeploys the service — about 45 seconds — and does not
touch the disk, so no data is lost.

The other variables (`CKING_DATA_DIR`, `NODE_ENV`, `TRUST_PROXY`,
`COOKIE_SECURE`, `OTP_ECHO`, `NODE_VERSION`) belong to `render.yaml`. Editing
them here works until the next blueprint sync silently puts them back. To change
one, edit the file and push.

### Events — what happened and when

**MONITOR → Events.** Every deploy, restart, crash and health-check failure,
with the commit that caused it. First place to look when something changed
behaviour and you want to know when.

### Metrics — is it struggling

**MONITOR → Metrics.** CPU, memory, request rate. Worth glancing at
occasionally. On the Starter instance, memory is the one to watch: a Triage
reading many CVs at once is the heaviest thing this app does.

---

## Part 2 — Looking at the live database

All of these run in **Shell**. They are read-only unless the word in the command
says otherwise (`set`, `add`, `delete`, `approve`).

### The whole picture

```bash
npm run db
```

A summary of every table. Then, for detail:

```bash
npm run db accounts      # companies and recruiters
npm run db candidates
npm run db messages
npm run db folders
npm run db billing
npm run db views
```

### Contact messages from the public site

The contact form stores every message. This reads them back:

```bash
node server/scripts/contact.mjs                # the 20 most recent
node server/scripts/contact.mjs list --limit 50
node server/scripts/contact.mjs show <id>      # one message in full
```

The form also prints one line to the log when a message arrives — but a log line
scrolls away, which is why the table and this script exist. **Check it
regularly**; nothing notifies you.

### Companies

```bash
node server/scripts/companies.mjs list
node server/scripts/companies.mjs show <id|name>
node server/scripts/companies.mjs approve <id>
```

A new company can sign in and set itself up but reaches no candidate profile
until approved. `approve` is how a company becomes real.

### Recruiters

```bash
node server/scripts/recruiters.mjs list [company]
node server/scripts/recruiters.mjs show <id|username>
node server/scripts/recruiters.mjs password <id|username> --password "..."
```

Passwords can be set but never read — they are salted scrypt hashes. If somebody
is locked out, you set a new one.

### Candidates

```bash
node server/scripts/candidates.mjs list --search "tel aviv"
node server/scripts/candidates.mjs show <id|email|phone>
node server/scripts/candidates.mjs deactivate <id|email>
```

### The raw database

If you ever need SQL directly, the file is at `/data/db/cking.db`. Prefer the
scripts: they know about the rules the app depends on, and raw `UPDATE`
statements do not.

---

## Part 3 — Changing the site

### The normal loop

```
edit on your laptop  →  test locally  →  git commit  →  git push  →  live in ~1 min
```

**Yes — pushing to `main` deploys automatically.** No button to press. Watch it
under Events or Logs.

Two deploys fire when a push also changes `render.yaml`: Auto-Deploy goes first
with the *old* configuration, then the Blueprint sync applies the new one. That
is why the first attempt showed a red row and a green one for the same commit.
It only happens when the blueprint itself changes.

### Test before you push

You have a full test suite. Use it — this is what it is for:

```bash
npm run test:api
npm run test:workspace
npm run test:portal
```

They run against a server on your own machine, never the live one. That
distinction matters: see the note on `CKING_URL` in `docs/` and in your own
memory file.

### If a deploy breaks the site

**Deploys → find the last good one → Rollback.** It redeploys that commit. The
disk is untouched, so no data is affected. Then fix the problem on your laptop
without the site being broken while you think.

### Do you need a sandbox?

**You already have one: your laptop.** It runs the same code against its own
database, and the test suite exercises it far harder than clicking would. For
almost everything, that is the right place to try things.

A second Render service — a "staging" site — is worth it only when you need to
test something that cannot exist locally: the real domain, real emails
arriving, real TLS. It costs another instance plus another disk (~$8/month), and
it is set up by pointing a second blueprint at a `staging` branch with a
different service name.

**Do not test on the live site once real people are using it.** Not because
something will break, but because test accounts and real accounts in one
database are very hard to separate afterwards — and cleaning them up is exactly
how real accounts get deleted by mistake.

### Test accounts, if you make them

Give every one a marker you can search for, and never delete anything a query
merely returned — delete only what the marker names. An address like
`test-2026-09@example.com` is unmistakable: `.example.com` is reserved for
testing and nothing is ever delivered to it.

---

## Part 4 — Putting it on your own domain

### First: check which domain you actually own

You have been saying **cursus.com**, but the domain in your configuration is
**cvrsvs.com**, and they are not the same thing.

```
cvrsvs.com  →  nameservers at Cloudflare        ← yours
cursus.com  →  nameservers at fabulous.com      ← a domain broker's parking page
```

`cursus.com` is registered to somebody else and listed with a reseller. It may
be for sale, and a one-word `.com` of that quality is usually expensive — often
five figures. That is a business decision, not a deployment step.

Everything below is for **cvrsvs.com**, which you own and which already has your
Resend sending records on `mail.cvrsvs.com`.

### The steps

1. **Render → Settings → Custom Domains → Add.** Enter `cvrsvs.com`, and
   `www.cvrsvs.com` if you want both.
2. Render shows you a DNS record to create. For a root domain it is usually an
   `ALIAS`/`ANAME`, or an `A` record to an address it gives you; for `www` it is
   a `CNAME` to `cursus-fcbw.onrender.com`.
3. **In Cloudflare**, add exactly that record. If Cloudflare offers the orange
   cloud (proxying), **turn it off** for this record while you verify — proxying
   can prevent Render from issuing the certificate. You can turn it back on
   afterwards.
4. Wait. DNS takes minutes usually, up to an hour occasionally. Render's page
   shows Verified when it can see the record.
5. Render issues a TLS certificate automatically. No action needed.
6. **Update `APP_URL` to `https://cvrsvs.com`** in Environment. This is the step
   people forget: until you do it, every link in every email still points at the
   onrender.com address.

### Do not touch these records

Your Resend records live on `mail.cvrsvs.com` — a subdomain, deliberately, so
sending records and website records cannot collide. Adding a website record on
the root does not affect them. Leave the `mail.` entries alone.

---

## Part 5 — Backups

There are none unless you make them. One machine, one disk.

```bash
node scripts/backup.mjs /tmp/backup
```

It copies the database and every upload **together**, then reads the copy back
and tells you whether every file the database names is actually in it. That
check exists because the opposite has happened here.

The awkward part on Render: the shell is temporary, so a backup written there
vanishes with it. Until something automatic exists, the practical routine is to
run it and download the result, or add a Render Cron Job that pushes a copy to
object storage.

**A backup that only lives on the machine you are protecting is not a backup.**

---

## Part 6 — A short weekly routine

- **Logs** — skim for errors and for any `row(s) name an upload that is not on
  disk` line at startup.
- `node server/scripts/contact.mjs` — read enquiries. Nothing notifies you.
- `node server/scripts/companies.mjs list` — approve anyone waiting.
- `npm run db` — a glance at the numbers.
- Run a backup and take it off the machine.

---

## What is still open

| | |
|---|---|
| **SMS** | No provider. Candidates cannot complete sign-up. The largest gap. |
| **Email key** | `RESEND_API_KEY` is unset on the live site, and the old key was exposed in a chat transcript — rotate it in Resend before using it. |
| **AI keys** | `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` unset. Search runs on keyword matching until they are set. |
| **DMARC** | Not published on the sending domain. Deliverability is worse without it. |
| **Automatic backups** | Manual only. |
| **Two lost documents** | Two rows on candidate 6912 name files that no longer exist. Local only; the live database is empty. |
