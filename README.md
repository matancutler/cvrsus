# Cvrsus

CV intake, matching and messaging. Three interfaces:

- **`/` — Join.** Open to anyone, and it asks first: *I am a Candidate or a Recruiter.*
  Candidates upload a CV, which fills the form in for them, and submitting creates their
  account. Recruiters get the company sign-up form in the same card, without leaving the page.
  Either way, the email address and the phone number are each proved with a six-digit code
  before an account exists.
- **`/account` — Candidate account.** The candidate signs in with a code, edits everything
  they entered, sees how many recruiters have viewed their profile, and replies to recruiters.
- **`/hr` — Recruiters.** Paste a job description, rank every CV on file with a visible
  breakdown, organise candidates into folders, and message them.

Everything runs locally. No third-party services, no API keys, no data leaving the machine.

## Running it

```bash
npm install       # once
npm run dev       # API on :5175, UI on http://localhost:5174
```

Open <http://localhost:5174>.

### First run

1. Go to **Recruiters → Create a company account**. Enter your company name, your name,
   email, phone and website, and a password. You get a **company key** like `A5U6-NP9K-3TYZ`
   and a **username** derived from your name (`maya.cohen`) — that plus the company key and
   your password is how you sign in.
2. **Approve the company.** Registration is open, and a new company reaches no candidate
   profile until someone clears it:

   ```
   node server/scripts/companies.mjs pending
   node server/scripts/companies.mjs approve <id>
   node server/scripts/companies.mjs decline <id> --reason "..."
   ```

   A decline is recorded, not deleted: the company, its recruiters and anything they saved
   stay put, they simply reach no candidate. `approve` undoes it. Use `delete` if the
   company should not exist at all, and `list` to see every company's status.

   The `/api/hr` gate opens for `approved` and nothing else, so an unrecognised status
   refuses rather than admits.

3. Share the company key with colleagues so they can create their own accounts.
4. Have someone apply at `/`, then sign in at `/account`.

## Accounts

| Account | Created with | Signs in with |
| --- | --- | --- |
| **Company** (parent) | Company name, administrator details, password — verified, then approved | Not a login — it issues the company key |
| **Recruiter** (subsidiary) | Company key + first name, last name, password, confirm | Company key + username + password |
| **Candidate** | Submitting an application, with both contact details verified | Email **or** phone + a six-digit code |

**Both contact details are proved at sign-up.** A candidate and a company administrator each
verify their email address *and* their phone number with a six-digit code before the account
is created. A correct code mints a short-lived signed proof naming that address; the sign-up
route re-checks the signature and that the proof names the address being registered, so one
verified address can never stand in for another. Nothing about a half-finished form is held
server-side. Changing either afterwards re-proves it — a verified address that can be swapped
for an unverified one was never really verified. See `server/src/verification.js`.

**Why companies are approved rather than gated.** Registration used to require a shared
`COMPANY_SIGNUP_SECRET`, which meant one leaked string opened every CV on file and there was
no record of who had used it. The audit (§15) removed the field. What replaced it is a
review: anyone may register and sign in, but `/api/hr` — search, profiles, files, reveals,
everything that reaches a candidate — is closed to a company until it is approved. The
administrator's verified email and phone, and their website (§17), are what that review looks
at.

**Why recruiters get a username.** The four sign-up fields you specify — name, last name,
password, confirm — cannot identify a person: two people called Maya Cohen in the same
company would collide. A username is derived from the name at sign-up (`maya.cohen`, then
`maya.cohen2`) and shown on screen. Usernames are unique per company, so the same name in a
different company still gets the plain form.

**Candidate sign-in has no password.** The candidate enters the email address or phone
number they applied with and receives a code. Phone numbers are matched on their last nine
digits, so `+972 54 987 6543` finds an account registered as `054-987-6543`.

An identifier with no application behind it returns **404**, and the sign-in page says so and
offers to create a profile. That is a deliberate trade: it means the endpoint can also be used
to check whether a particular person has applied, which is worth throttling before this server
is exposed to the internet.

> **Codes are printed to the server console.** No email or SMS provider is wired up.
> While `OTP_ECHO=true` the code is *also* returned in the API response and shown in the
> browser so the flow works without a mailbox. **This must be off in production** — with it
> on, knowing someone's email address is enough to sign in as them.
> [`server/src/notify.js`](server/src/notify.js) is the single place to add a real provider.

## The candidate form

| Field | Required | Notes |
| --- | --- | --- |
| Profile picture | no | Round frame with a live preview. Still images only — JPG, PNG or WebP |
| First name | yes | |
| Middle name | no | |
| Last name | yes | |
| Email | yes | Doubles as a sign-in identifier |
| Phone number | yes | Doubles as a sign-in identifier |
| City | no | Dropdown of Israeli cities, plus an *Other* option that reveals a free-text field |
| Availability | no | Immediately / Within 2 weeks / Within 1 month / 1–3 months |
| CV | yes | **PDF only**, up to 10 MB |
| Professional Summary | no | Read alongside the CV when matching |

The application form and the account's edit page render the *same component*
([`CandidateForm.jsx`](client/src/components/CandidateForm.jsx)), so they cannot drift apart.
The only difference is that editing keeps the existing CV unless a new one is attached.

Years of experience and job titles are not asked for — they are derived from the CV.

## Profile views

The candidate sees **how many distinct recruiters** opened their profile, plus when it was
last viewed. One row is stored per (candidate, recruiter) pair, so a recruiter who looks five
times still counts as one person.

`viewSummary` also returns the company count and the total number of opens. Nothing displays
them today — the account page shows the recruiter count alone — but they are there if you
want a fuller breakdown later.

A view is recorded when a recruiter *opens* a profile — listing or ranking candidates does not
count, otherwise every search would inflate everyone's number.

## Reveals, seats and billing

Two products, one wallet per organization.

**Reveals** open a candidate's contact details, CV and documents. They are bought in prepaid
packs, belong to the organization rather than to the person who bought them, and never expire.
Searching, filtering, ranking and saving to a folder are free — the reveal is the only thing
that costs. A candidate one colleague revealed is open to the whole company at no further
charge, so an organization pays once per candidate however many people look at them.

**Seats** are how many recruiter accounts the organization may hold. One is included — the
administrator's own. Every colleague after that needs a seat, bought once rather than monthly,
and deleting someone frees theirs for the next hire. Seats never carry their own reveal balance.

**Messaging sits on the far side of the reveal.** A conversation carries the recruiter's name
and company to the candidate and puts a reply address in front of them, which is the same
access a reveal grants in the other direction — so a recruiter can only write to somebody their
organization has revealed. That is also why the recruiter's message list shows full names: every
candidate in it is one they already hold the details of.

**Reveals can be divided across seats.** Off by default — one shared pool is the right answer
for most teams. An administrator can give each person an allowance from the Team tab; the total
cannot exceed the balance, and setting a new allowance resets what has been drawn against it.
Anyone left without one draws from the shared remainder.

Every new organization is granted **ten complimentary reveals**, once, at creation — never
again when a seat is added.

| Where | What it holds |
| --- | --- |
| `server/src/pricing.js` | Every price, pack size, tier, grant and threshold. Nothing else in the codebase states an amount. |
| `server/src/wallet.js` | The balance, the ledger, seat entitlement, and the atomic charge. |
| `server/src/billing.js` | The payment seam a real processor plugs into. |

**Why the reveal is a transaction, not a flag.** `consumeReveal` inserts the organization's
claim on the candidate *first* and deducts *second*, both inside one SQLite transaction. The
UNIQUE index on `(company_id, candidate_id)` is what makes two colleagues clicking at the same
instant cost one reveal rather than two, and the `reveal_balance > 0` guard in the UPDATE is
what stops a balance of one satisfying two concurrent reveals of different candidates. If
either step finds nothing to do the whole thing rolls back, so a reveal that fails consumes
nothing and leaves the candidate masked.

**Why seats true up.** The tier is decided by how many seats the organization owns *after* the
purchase, and what it already paid is credited against it. Growing one hire at a time
therefore costs exactly what guessing the headcount on day one would have. `GET
/api/company/seats/quote` returns that arithmetic so the summary on screen and the amount
charged come from the same function.

Prices are read server-side from the catalogue on every purchase. A request names *which* pack,
never what it costs; `test/pricing-check.mjs` asserts that a client-supplied amount is ignored.

To reprice, edit `pricing.js` or set the matching environment variables — `COMPLIMENTARY_REVEALS`,
`INCLUDED_SEATS`, `SEAT_BASE_PRICE`, `SEAT_TRUE_UP`,
`BILLING_CURRENCY`.

## Folders

Each recruiter has their own folders; colleagues cannot see or change them. Candidates can be
added from the search results or dragged between folders on the board. A candidate sits in at
most one of a recruiter's folders, so dragging moves rather than copies.

## Chat

Conversations are between **one candidate and one named recruiter**. Two recruiters at the
same company have separate threads with the same candidate.

Recruiters start conversations; candidates reply. A candidate cannot cold-message a recruiter
who has not written to them, which keeps the recruiter's inbox from becoming an application
channel of its own. Both sides poll every few seconds, so a reply lands within moments.

## How matching works

This is deterministic keyword and skill matching — no AI model, no per-match cost, and every
number is explainable. That last part is the point: a recruiter needs to be able to tell a
hiring manager *why* someone scored 78.

**1. Reading the job description.** `Read job description` pulls out a title, a minimum years
figure, and two skill lists. It splits on headings — text under *Requirements* / *Must have* /
*Qualifications* becomes **required**, text under *Nice to have* / *Preferred* / *Bonus*
becomes **preferred**. A skill named in both is treated as required. Everything it extracts is
loaded into editable fields; it never applies anything silently.

**2. Scoring each candidate.** Five components, weighted:

| Component | Weight | What it measures |
| --- | --- | --- |
| Required skills | 45 | Fraction of required skills found in the CV |
| Preferred skills | 15 | Fraction of preferred skills found |
| Experience | 15 | Years against the minimum |
| Title relevance | 10 | Overlap between the job title and titles in the CV |
| JD keyword overlap | 15 | How many of the JD's distinctive terms appear in the CV |

A component that does not apply is dropped and its weight spread across the rest, so the total
always tops out at 100.

Skills are matched through a taxonomy of ~190 canonical skills with aliases, so *ReactJS*,
*React.js* and *React* all count as React, and *k8s* counts as Kubernetes. Anything not in the
taxonomy is matched literally, so custom skills work fine.

**3. Experience** is estimated from employment date ranges in the CV, merging overlapping
ranges so concurrent roles are not double counted, plus any explicit "8 years of experience"
phrasing. A CV showing neither scores below neutral rather than zero, and the breakdown says
`not stated` rather than pretending it measured something.

**4. Filters** are hard gates applied before ranking: require every listed skill, minimum
years, minimum score, city, availability, or a name search.

### What this approach will not do

It matches words, not meaning. A CV saying "built single-page apps in Vue" will not match a
required skill of *React*. Adding aliases to [`server/src/skills.js`](server/src/skills.js)
covers most real gaps. If you later want genuine semantic matching, the clean place to add it
is a re-rank pass over the top N results.

Scanned or image-only PDFs have no text layer. The server rejects those uploads with a clear
message rather than filing an empty record.

## Tests

```bash
npm test              # skill detection — no server needed
npm run test:api      # full API flow — needs the server running
npm run test:pricing  # reveals, seats, the true-up and who may buy
```

## Contact messages

The public contact form stores every enquiry and prints one line to the server
console. Nothing emails them anywhere, so the database is the inbox:

```bash
npm run contact                          # the 20 most recent, test rows hidden
node server/scripts/contact.mjs show 47  # one message in full
```

Worth running on a schedule until a mail provider is wired into
[`notify.js`](server/src/notify.js) — a console line scrolls away, and
`node --watch` clears the terminal on every restart, so an enquiry can sit
unread indefinitely.

`test:api` covers company and recruiter registration, username derivation and collisions,
company scoping, candidate code sign-in by email and phone, profile editing, distinct-viewer
counting, folder isolation and drag-to-move, and chat in both directions. It deletes
everything it created, so it is safe to re-run against a database with real candidates in it.

## Project structure

```
server/src/
  index.js     Express app and all routes
  db.js        Schema, migrations, candidate queries
  accounts.js  Companies, recruiters, login codes
  pricing.js   Every price, pack, tier, grant and threshold
  wallet.js    Reveal balance, billing ledger, seat entitlement, the charge
  billing.js   The payment-processor seam
  workspace.js Folders, views, messages
  auth.js      Role-aware tokens, scrypt passwords, one-time codes
  notify.js    Where to plug in email/SMS delivery
  extract.js   PDF text extraction (pdfjs-dist), experience estimation
  skills.js    Skill taxonomy, aliases, detection
  match.js     JD parsing, scoring, filters

client/src/
  pages/UploadPage.jsx       Application form
  pages/CandidatePortal.jsx  Code sign-in, profile editing, views, messages
  pages/HrPanel.jsx          Recruiter auth, search, folders, chat, billing
  pages/PricingPage.jsx      Reveals and Seats tabs, pack cards, purchase
  components/EyeIcon.jsx     The reveal mark — reveals only, never seats
  components/CandidateForm.jsx  Shared by apply and edit
  components/ChatPanel.jsx      Shared by both sides of a conversation
  data/israeliCities.js
```

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | Liveness, candidate and company counts |
| `POST` | `/api/candidates` | — | Apply: CV + photo + fields; creates the account |
| `POST` | `/api/company/register` | secret | Create a company, get its join key |
| `POST` | `/api/recruiter/register` | join key | Create a recruiter account |
| `POST` | `/api/recruiter/login` | — | Company key + username + password |
| `GET` | `/api/recruiter/me` | recruiter | Own account and colleagues |
| `POST` | `/api/candidate/request-code` | — | Send a sign-in code to email or phone |
| `POST` | `/api/candidate/verify-code` | — | Exchange the code for a session |
| `GET` `PATCH` | `/api/candidate/me` | candidate | Read and update the profile |
| `GET` | `/api/candidate/me/photo`, `/cv` | candidate | Own files |
| `GET` `POST` | `/api/candidate/threads[/:recruiterId]` | candidate | Inbox and replies |
| `GET` | `/api/hr/candidates` | recruiter | List all candidates |
| `GET` | `/api/hr/candidates/:id` | recruiter | Full record — **records a profile view** |
| `GET` | `/api/hr/candidates/:id/file`, `/photo` | recruiter | Original PDF, profile photo |
| `DELETE` | `/api/hr/candidates/:id` | recruiter | Delete a candidate and their files |
| `POST` | `/api/hr/parse-jd`, `/api/hr/match` | recruiter | Extract requirements, rank |
| `GET` `POST` `PATCH` `DELETE` | `/api/hr/folders[/:id]` | recruiter | Folder CRUD |
| `POST` | `/api/hr/folders/:id/items` | recruiter | Add or drag a candidate into a folder |
| `GET` `POST` | `/api/hr/threads/:candidateId` | recruiter | Conversation with a candidate |
| `POST` | `/api/hr/candidates/:id/reveal` | recruiter | Open contact details — **spends one reveal** |
| `GET` | `/api/pricing` | — | The pack catalogue, for the public pricing page |
| `GET` | `/api/company/billing` | org admin | Balance, seats, ledger, catalogue |
| `POST` | `/api/company/reveals/purchase` | org admin | Buy a Reveal Pack by key |
| `GET` `POST` | `/api/company/seats/quote`, `/seats/purchase` | org admin | Price and buy seat capacity |
| `PATCH` | `/api/company/auto-replenish` | org admin | Auto top-up, reveals only; no pack turns it off |
| `GET` `PUT` | `/api/company/reveal-allocations` | org admin | Read and replace the whole allowance map |

## Production build

```bash
npm run build     # builds the client into client/dist
npm start         # server serves the API and the built UI on :5175
```

When `client/dist` exists the server serves it directly, so production is a single origin on
one port. Rebuild after changing client code, or `npm start` will serve a stale bundle.

## Resetting the data

Deleting these two directories wipes every candidate, company, recruiter, folder and message.
They are recreated empty on the next start.

```bash
rm -rf server/data server/uploads      # PowerShell: Remove-Item -Recurse -Force server\data, server\uploads
```

## Before this handles real CVs

CVs are personal data, and the current setup is built for a trusted internal network:

- **Turn off `OTP_ECHO`** and wire a real email/SMS provider. Leaving it on means an email
  address is a login.
- **Set a long random `SESSION_SECRET`.** Without it, sessions are signed with a per-boot
  value and nobody stays signed in across a restart.
- **Watch the pending queue.** Company registration is open; approval is the only thing
  between a stranger and every CV on file. `node server/scripts/companies.mjs pending`
  lists who is waiting, and nothing reaches a candidate until you approve it. Raise
  `RATE_REGISTER_MAX` above its default of ten an hour only if you have a reason to.
- **Serve over HTTPS.** Passwords, sign-in codes and session tokens cross the wire in plain
  text otherwise.
- **The application endpoint is unauthenticated and unthrottled** — deliberately, so
  candidates can reach it. Exposed to the internet it needs rate limiting and probably a
  CAPTCHA.
- **`/api/candidate/request-code` confirms whether an account exists**, so the sign-in page
  can offer to create a profile. Without rate limiting that lets anyone test addresses one at
  a time to find out who has applied to you.
- **All recruiters see the whole candidate pool**, including recruiters from other companies.
  Folders and conversations are private, but the CVs are not. If companies should not see each
  other's candidates, candidates need to apply *to* a company and the queries need scoping by
  company id.
- **Uploaded files sit unencrypted** in `server/uploads/`, and the database holds the full
  extracted text of every CV and every message.
- **There is no retention policy.** GDPR and similar rules give candidates deletion rights and
  cap how long you may keep applications. The delete route exists; scheduling it is up to you.
- **Photos raise the stakes on bias.** A face on every row invites the judgement structured
  screening exists to avoid. The field is optional and plays no part in scoring.
