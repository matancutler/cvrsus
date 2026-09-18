# Rolling Triage — plan

Planning only. Nothing in the code, the database or the config was changed to write this.

Everything below was read out of the repository. Where a number is an estimate rather than a
measurement, it says so. Where the code cannot answer a question, the question is in section 5
instead of being guessed at.

---

## 1. How Triage works today

### The object

One Triage is one job description, one pile of CVs, one charge. That is not a summary — it is
written into the schema as a design statement (`server/src/schema.js:802`).

Five tables hold it:

| Table | What it holds |
| --- | --- |
| `triages` | The session: company, title, the JD text, the parsed JD, counters, the charge |
| `triage_applicants` | One row per uploaded CV: the file, its text, its score, its analysis |
| `triage_batches` | The work queue: parse, preliminary, initial, rolling |
| `triage_cost_events` | Per-batch timing and token counts |
| `folder_triage_items` | An applicant filed into a shared folder |

None of them has a foreign key back to `triages`. Nothing writes to the `candidates` table — an
applicant is never a marketplace candidate, and a test asserts it (`test/triage-check.mjs:422`).

### The JD

`triages.raw_jd` holds the text. `triages.match_profile` holds the parsed version — the model
reads the JD once per session and the result is cached on the row
(`server/src/triageQueue.js:439`).

There is **no JD version column**. The marketplace side has one (`jobs.jd_version`), and its
whole analysis cache is keyed by it. Triage has nothing equivalent. `triages.jd_hash` is written
on every edit and then **never read by anything** (`server/src/triage.js:448`).

### The flow the recruiter sees

Two screens, chosen by one flag:

```
TriageWorkspace → triage.launched ? <TriageResults> : <TriageBuilder>
                  (client/src/components/TriageTab.jsx:252)
```

`launched` is `Boolean(row.ledger_id)` — true the instant capacity is charged.

1. **Builder.** Step 1 the role (paste or attach a JD), Step 2 the CVs (drag or pick, uploaded 40
   files per request), Step 3 Start. Duplicates are detected by a SHA-256 of the file bytes and
   refused. Files over the 500 cap are rejected with "put the rest through a second Triage".
2. **Start.** Capacity is checked, then charged. From this moment the pile and the JD are frozen.
3. **Results.** A progress line, a status chip, ranked cards, "Show the next 25", a failures list,
   an applicant dialog, and filing into folders.
4. **History.** The rail lists launched Triages only, bucketed by date. Drafts are invisible in it.

### What runs behind it

One process-wide queue, one batch at a time (`server/src/triageQueue.js:131`). Four batch kinds:

- **parse** — extract text from every file. Concurrency 4.
- **preliminary** — one model call to read the JD, then a free keyword ranking of the whole pile.
  Writes `prelim_rank` as a dense 1..N.
- **initial** — deep-analyse ranks 1 to 50.
- **rolling** — the next 25, only when the recruiter reaches the end of a page.

Deep analysis is **one model call per CV** (`analyseMatch`), not one per batch. Claude judges each
requirement; the score is computed in code from those verdicts.

### How the ranking is produced

Two numbers, and the difference matters for everything in this plan.

- **`absolute_fit`** is written once when the CV is scored and **never rewritten**
  (`server/src/triageQueue.js:568`). It depends only on that CV's own verdicts.
- **The displayed percentage** is computed fresh on every page load, across every scored applicant
  in the session (`server/src/triage.js:561` → `normalizeUniverse`).

The formula is `round(fit ÷ top × ceiling)`, where `top` is the best absolute fit in the session
and `ceiling` is 100 once `top` reaches 55, or lower below that.

I checked this specifically, because a plan built on a misreading of it would be wrong. **Existing
percentages only move when `top` moves** — that is, when a newly analysed CV becomes the best in
the session, or when the best crosses the 55 threshold. A weaker arrival changes nothing. The
*order* of already-scored CVs never changes from a new arrival, because the transform is the same
for everyone. So the instability is real but narrow: it is "a strong late CV quietly lowers
everyone else's number", not "the numbers shuffle".

The results payload already warns about it in words (`server/src/index.js:6929`).

### Money

- The unit is the CV, never the session. `pricing.js` says so explicitly.
- Packs: 100 / 200 / 300 / 500 CVs at ₪30 / ₪55 / ₪75 / ₪115. Capacity does not expire.
- New organizations get **100 CVs free**, once per company.
- The charge happens **once, at launch**, for the number of files held at that instant
  (`server/src/index.js:6828` → `consumeTriageCvs`).
- It is idempotent through one column: `UPDATE triages SET ledger_id = ?, charged_cvs = ? WHERE id
  = ? AND ledger_id IS NULL` (`server/src/wallet.js:1039`).
- Unreadable CVs are refunded automatically. A permanent parse failure refunds the whole session.
- A seat can have a per-recruiter allowance (`recruiters.triage_allowance`). It is a **lifetime
  counter with no reset**.
- `billing_ledger` has no `triage_id` column. Nothing links a charge to the session that caused it
  except `triages.ledger_id` pointing the other way.

No real money moves anywhere: the billing provider is `local` and simulates every purchase.

### Everything that assumes one batch

This is the list that matters. Each one is a real line of code, not a style problem.

| # | Assumption | Where |
| --- | --- | --- |
| 1 | Uploading to a launched Triage is refused | `index.js:6632` (409) |
| 2 | Deleting a file from a launched Triage is refused | `index.js:6745`, `6767` (409) |
| 3 | Editing the JD or even the title after launch is refused | `index.js:6595` (409) |
| 4 | After launch the API stops returning the file list at all | `index.js:6570` |
| 5 | `parse` and `preliminary` can each run **once per session, ever** — the queue's idempotency key has no batch identity | `triageQueue.js:63`, `schema.js:944` |
| 6 | `prelim_rank` is a dense 1..N written in one transaction over the whole pile | `triageQueue.js:389` |
| 7 | Deep analysis selects by rank range, so a CV with no rank is invisible to it | `triageQueue.js:515` |
| 8 | `analysis_frontier` is one integer cursor that only moves forward | `triageQueue.js:753` |
| 9 | The charge is one row, one claim, one `charged_cvs` total | `wallet.js:1039` |
| 10 | `ledger_id` means three things at once: paid, launched, and "not a draft" | `triage.js:160`, `292` |
| 11 | The UI is a hard binary on `launched` | `TriageTab.jsx:252` |
| 12 | Polling stops when the queue drains and never restarts | `TriageTab.jsx:983` |
| 13 | `completed` is treated as the end | `TriageTab.jsx:1097`, tests |
| 14 | The tests assert most of the above | see section 7 |

---

## 2. Target behaviour

A session is a live shortlist for one open role.

- It is opened once, with a job description.
- CVs can be added at any time, in as many drops as the recruiter likes.
- The ranking always covers everything added so far.
- A score a recruiter has already read does not change underneath them without explanation.
- The session has a state the recruiter controls: open, paused, closed.
- CVs are not kept forever.

What does **not** change: an applicant is still not a marketplace candidate; the analysis is still
one model call per CV; folders still work; the score still means what it means in Search, unless
section 3 says otherwise and you agree.

---

## 3. Changes by area

### 3.1 Data and scoring

**Taking new CVs at any time.** Four changes, in dependency order:

1. **Drop the launch freeze.** The three 409 guards (`index.js:6595`, `6632`, `6745`/`6767`) become
   checks on the new lifecycle state instead of on `launched`.
2. **Give the queue a batch identity.** The idempotency key is
   `${triageId}:${kind}:${from}:${to}`, which makes a second `parse` impossible. It needs a drop
   number in it: `${triageId}:${dropId}:${kind}:...`. This is the single hardest blocker and it is
   about ten lines plus a column.
3. **Stop renumbering ranks.** `prelim_rank` must become append-only: a new drop is ranked among
   itself and appended after the current maximum, or the frontier has to be re-derived. Renumbering
   the whole pile under an advanced frontier would silently skip CVs — `runDeep` with no matching
   rows advances the frontier and declares the work done (`triageQueue.js:523`).
4. **Let the pipeline pull work.** Today only the recruiter's browser asks for more analysis
   (`?advance=1`). A drop added on Tuesday must be analysed without somebody scrolling.

**Is each CV scored on its own?** Yes, and this is the good news. `absolute_fit` is computed from
that CV's verdicts against the session's requirement list, and never touched again. Old scores are
already stable. What is not stable is the **displayed** percentage — see the exact rule in section
1. The options are in question **Q1**.

**Editing the JD mid-session.** Today it is impossible after launch, and the code comment says the
honest answer is a new Triage. That reasoning does not survive a session that stays open for six
weeks: JDs get corrected. Three options, with what each costs us:

| Option | What happens | Cost to us |
| --- | --- | --- |
| Forbid edits | Same as today. Recruiter opens a second session and loses the shortlist | Nothing |
| Re-score everything | Every CV in the session is analysed again against the new text | Full price again — a 300-CV session is roughly $45 at today's settings |
| Version the JD, score forward | New drops use the new text; old scores are kept and labelled; re-scoring is a button | One JD parse ($0.05–0.10) plus whatever the recruiter asks for |

`triages.jd_hash` already exists and is unused — it is the natural trigger. The decision is **Q3**,
and who pays is **Q4**.

**Duplicates.** Byte-identical files are already refused per session, not per drop — this part is
rolling-ready. What is not handled is the same person sending an updated CV: different bytes, so a
second applicant row, so the same person appears twice in the ranking. The `duplicate_of` column
exists in the schema and nothing writes to it. See **Q15**.

**Failed and unreadable CVs.** Unreadable files are marked and refunded automatically. That path
assumes one charge: the refund is computed as a target total clamped to `charged_cvs`
(`wallet.js:1118`). With several drops it would refund the first drop's total and then stop. It has
to become per drop.

Applicants whose model call failed are left as `failed` and never retried. In a one-shot Triage
that is one bad row. In a session open for weeks it is a permanent hole, and there is no re-queue
route. Worth fixing in the first version.

**Large sessions.** Every page load runs `SELECT *` over every scored applicant — including the
full extracted CV text — then sorts in JavaScript and slices 25 (`triage.js:561`). At 40 CVs that
is invisible. At 800 it is tens of megabytes per poll, every 2.5 seconds. This must be fixed before
sessions get big: select only the columns the list needs, and sort in SQL.

Paging is offset-based over a list that re-sorts on every read, and the client appends pages
blindly — so a new arrival can push a CV from page 2 to page 1 and the recruiter sees it twice.
Keyset paging (order by score, id) fixes it.

### 3.2 Session lifecycle

**States.** The recruiter needs `open`, `paused`, `closed`. The pipeline already has five states of
its own (`draft`, `processing`, `ready`, `completed`, `failed`) and they are not the recruiter's to
set — nothing outside the queue writes that column.

Recommendation: a **second column**, `lifecycle`, beside the untouched `status`. One ALTER, no table
rebuild. SQLite cannot change a CHECK constraint, so folding lifecycle into `status` means dropping
and renaming a live table for no gain, and it would force the queue to choose between recording
"paused" and recording "failed" when both are true.

| State | Add CVs | Analysis runs | Visible |
| --- | --- | --- | --- |
| open | yes | yes | in the list |
| paused | no | no new work | in the list, marked |
| closed | no | no | history only |

`archived` is not recommended as a fourth state: it would permit exactly what `closed` permits, so
it is a label rather than a state. Hiding closed sessions from the main list does the same job.

**Existing sessions.** Every Triage in production today was launched, charged and finished under the
one-time model. Turning them all "open" would make a finished 2026 report look like a live
shortlist and would put them back in scope for uploads and charges. Recommendation: migrate them to
`closed`, which is what they are, with a Reopen button. See **Q10** — and **Q14**, because I cannot
see the production database from here and do not know how many sessions or CVs are involved.

**Retention.** This is the sharpest finding in the audit.

*Nothing in the product ever deletes an applicant's CV.* There is one daily timer; it runs the
check-in sweep, the seat-expiry sweep and the anonymous demo sweep. None of them reads
`triage_applicants`. The boot-time orphan sweep explicitly *protects* Triage files. So a CV, its
full extracted text, and the applicant's name, email, phone and city are held until a recruiter
presses Delete — which today deletes the entire session, all or nothing.

The privacy policy already describes this accurately: kept "for as long as the Organization keeps
the Triage workspace" (`client/src/legal/legalDocuments.jsx:1301`). That sentence is defensible for
a one-off report. For a session designed to stay open indefinitely it becomes "we keep other
people's CVs forever", which is a different promise.

Two more gaps, both real today and both worse under rolling:

- **An applicant's erasure request cannot be honoured.** Deleting one CV from a launched session is
  refused with a 409. The terms promise CURSUS will assist with erasure requests as processor. The
  only available action is deleting the whole session.
- **Nothing empties `uploads/_swept`.** Quarantined files accumulate forever on a 5 GB disk.

Recommendation: a stated retention rule, a per-CV delete route, and a sweep. The numbers are
**Q6** — they are a decision, not a technical fact.

### 3.3 UX and UI

**Screens that change**

| Screen | Change |
| --- | --- |
| `TriageWorkspace` (`TriageTab.jsx:252`) | Stop branching on `launched`. One session page with an Add CVs control |
| `TriageBuilder` | Becomes "open a session" — JD plus the first drop. Keeps its steps |
| `TriageResults` | Gains: Add CVs, a new-since-last-visit marker, drop history, lifecycle controls |
| `TriageRail` | Gains state, CV count and last activity per row. Today a row shows a title, an author and a file count |
| `TriageResultCard` | Gains a recruiter-set status chip (shortlisted / rejected / to review) |
| `TriageApplicantDialog` | Gains status controls and "added on <date>" |
| `TriageStatus` | New vocabulary. "Completed" stops meaning finished |
| Pricing page, landing page, info page, demo | Copy changes — see 4.1 |

**New screens**

- A **sessions list** with role, CV count, new-since-last-visit, last activity, state. The rail is
  close but it lists launched sessions only, buckets them by creation date and caps each bucket
  with no "see all".
- A **drop history** panel: what was added, when, by whom, how many were unreadable.

**Screens that go away**: none. The builder becomes the opening step of the session page.

**Ranking movement.** Depends on Q1. If the displayed number becomes the stable absolute fit, the
list only ever gains rows in the right place and nothing a recruiter read changes. A new-arrival
marker (a dot, and a "3 new since Tuesday" line) does the rest of the work.

**Per-candidate status.** Today there is only `reviewed_at`, which is company-wide, one-way, and set
by opening the CV. Shortlisted / rejected / to review is a new column. Recommendation: rejected
applicants stay in the ranking but are filtered out of the default view — removing them from the
ranking entirely changes the denominator of a percentage that is supposed to describe the role, and
recruiters un-reject people. See **Q8**.

**Notifications.** There is exactly one Triage email in the whole product ("You're out of Triage
CVs") and no notification when anything finishes. Recommendation for v1: in-app only — a count on
the session row and a marker in the list. Email digests are **Q9**.

**Polling.** Polling stops when the queue drains and only restarts on remount. A session that is
idle for a week and then receives a drop from a colleague will not update. Either the list polls
slowly on its own, or this needs a push. There are also two existing bugs to fix here: after the
first "Show the next 25" the list stops refreshing entirely, and the failures list is read once at
mount and never updated.

**Empty, loading and error states** needed: a session with no CVs yet; a drop being parsed while
older results are on screen (the important one — the list must stay readable while new work runs); a
drop where every file failed; a paused session; a closed session; a session over its cap; an
organization out of capacity mid-session, which is new — today capacity is only ever checked at
launch.

### 3.4 Pricing

**Today, exactly.** One charge, at launch, of one CV of capacity per stored file, from a company
pool that never expires, optionally limited per seat by a lifetime counter. Packs at ₪0.30/CV
falling to ₪0.23/CV. 100 CVs free per new organization. Unreadable files refunded. Idempotent
through `triages.ledger_id`.

**What breaks.** The charge is claimed once per session row. A second drop cannot be charged: the
claim column is already set, `charged_cvs` is a single total that is set rather than incremented,
and the refund path clamps to it. The capacity check reads the session's whole file count, so it
would re-check CVs already paid for. The ledger cannot say which session a charge belongs to.

**The number that matters more than the model.** Our cost per deeply-analysed CV is roughly
**$0.15** at the current settings (Opus 5, effort high). This is an estimate from prompt sizes — it
has never been measured, and `docs/ai-cost-review.html` says so. We sell at ₪0.30–0.23, which is
**$0.081–0.062**.

So at full read-through we lose money on every CV, and we only make money because most CVs in a
one-shot pile are never deep-analysed. Break-even read-through is about 54% at the ₪30 pack and 41%
at the ₪115 pack. **Rolling sessions are designed to increase read-through.** Dropping
`MATCH_EFFORT` to medium takes the cost to roughly $0.04–0.05 and makes every model on this list
work. That change is already built and gated on an eval that has not been run.

| Model | How | Cost per CV | Margin at ₪0.30/CV | Honest weakness |
| --- | --- | --- | --- | --- |
| **A. Per CV, charged per drop** | Each drop debits the pool | $0.15 now, $0.045 after the effort change | −86% now, +45% after | Smallest change; loses money today on heavily-read sessions |
| **B. Fee per open session** | ~₪149 buys 60 days and a CV cap | Same per CV | 44% at 150 CVs fully read | Reinstates exactly what the current pricing rejected in writing: it punishes opening a second role |
| **C. Monthly plan** | ~₪299/month for N sessions and M CVs | Same per CV | 44% at 300 CVs | Needs recurring billing, dunning and proration. None of it exists — there is no payment provider at all |
| **D. Session fee plus allowance** | ~₪89 opens a session with 100 CVs included, overage from the pool | Same per CV | 37% now, 81% after the effort change | Overage priced below cost today; two things to explain instead of one |

**The free allowance.** 100 CVs, once per company, spendable anywhere. Under rolling, one free
session that never expires is a permanent free product for a small recruiter. Keeping the grant in
CVs rather than sessions is the simplest answer and needs no code change. See **Q11**.

**Who pays for a re-score after a JD edit** is **Q4**.

**Recommendation.** Keep per-CV (A) for the first version, charged per drop, and revisit once the
eval is run. Reasons: it is the only option that needs no new commercial object, no payment
provider and no terms rewrite beyond one sentence; the work it does need (per-drop charging) is
needed by every option except B; and it keeps the thing the current pricing got right, which is that
opening another session is free. D is the better long-term shape and I would expect to land there —
but choosing it now means designing a second product while the cost per CV is still unmeasured.

**This is the one place I would push back on the whole idea.** Rolling sessions increase how much of
each pile we analyse, and we currently lose money on analysis at the margin. The pivot makes the
cost problem worse, and it should ship behind the effort change, not before it.

---

## 4. Other implications and additions you did not mention

### 4.1 Copy that becomes wrong (must, first version)

Six places describe Triage as a one-time act on a pile that already exists:

- Landing page: "sorts the stack you already have" (`landingCopy.jsx:194`)
- Info page: "get every one back scored and ranked" (`InfoPage.jsx:335`)
- Pricing page and the in-product billing dialog: "prioritises the full **batch**"
- The public demo: "up to 500 at a time", hard-coded, unlike the real product
- Five user-visible 409 strings, two of which tell the recruiter to "create a new one"
- The over-cap message: "put the rest through a second Triage"

### 4.2 Legal and privacy (must)

- The Terms state the charging rule: "Capacity is consumed when a Triage is launched, at one unit
  per valid CV submitted" (`legalDocuments.jsx:439`). Any change to when we charge is a change to
  the Terms.
- The privacy retention sentence needs to state a period.
- `test/legal-check.mjs` asserts the published wording, and both documents share a revision date.

### 4.3 Two bugs found while reading (one is a must)

- **Committed CVs can be deleted from disk.** The upload route's catch block unlinks every file in
  the request, including files whose database rows were already written
  (`index.js:6729`). The row survives pointing at a missing file, and later shows up as "could not
  be read" rather than as data loss. A rolling session uploads far more often, so this gets hit more.
- **A failed launch leaves a half-state.** If `startProcessing` throws, the code refunds and clears
  `ledger_id` but leaves `status = 'processing'`. The session is then un-launched and processing at
  the same time.

### 4.4 Team use (mixed)

- A Triage belongs to the company. Any colleague can open, edit, upload to, launch, delete and read
  every CV in it. There is no per-session permission and no audit of who did what. Over a six-week
  shared session that becomes a real question — see **Q7**.
- `reviewed_at` is one column with no recruiter dimension: one colleague opening a CV marks it read
  for everyone. "New since *I* last looked" needs a per-recruiter marker (must, first version — it
  is the core of the rolling UX).
- Comments and tags are keyed to marketplace candidates and are structurally unavailable on Triage
  applicants. Over weeks, a shared shortlist without notes is a real gap (later).
- `folder_triage_items` records no recruiter, so nobody can tell who shortlisted whom (later).

### 4.5 Export and sharing (later, but likely to be asked for)

There is no Triage export and no share link. The only export is the folder XLSX, and it labels a
Triage applicant's contact details "Hidden until revealed" — which is wrong, since the recruiter
supplied them.

### 4.6 Analytics (must, cheap)

Nine Triage events exist, all from HTTP routes. The background worker emits none, so nothing
records analysis completing, failing, or how long a session lives. Rolling needs at least: drop
added, session paused/closed/reopened, time from drop to ranked, CVs per session over time,
sessions still open after 30 days.

### 4.7 Abuse and cost control (must)

- **Free storage.** An open session with no analysis is free file storage on our disk. A cap per
  company on open sessions, plus the retention rule, closes it.
- **One JD stretched across many roles.** Nothing detects it. Low priority — it costs the recruiter
  their own capacity.
- **The daily circuit breaker.** `MATCH_DAILY_CAP` is 1500 analyses per company per 24 hours. It is
  about ten times any plan we would sell, so it is a runaway guard rather than a commercial one.
  Under rolling it will need to be lower, or it will not bind.
- **Cache efficiency falls.** Prompt caching pays for itself across a batch of 50. A rolling session
  that adds 3 CVs on a Tuesday writes the cache and barely reads it, so small drops cost more per
  CV than a big pile does. Worth knowing before promising "add a few at a time".

### 4.8 Throughput (worth knowing)

One queue, one batch at a time, process-wide. Many open sessions across many companies serialise
behind each other. Fine at today's volume; it is the first thing that breaks at scale.

### 4.9 Capacity running out mid-session (must)

Today capacity is checked once, at launch. In a rolling session an organization can run out between
drops. There is one warning email, fired only when the balance hits exactly zero, and no auto
top-up for Triage. A session that stops analysing silently is the worst version of this.

### 4.10 Support load (worth knowing)

Two new questions will arrive that cannot arrive today: "why did this candidate's score change" and
"where did my CVs go". Both are answerable in the UI if Q1 and Q6 are decided well, and unanswerable
if they are not.

### 4.11 The demo (later)

The public demo is a one-shot, stores nothing, and is deterministic. It can stay as it is; only its
copy needs to stop promising "up to 500 at a time".

---

## 5. Questions for Gabriel

**Q1. What number does a rolling session show?**
Options: (a) the stable absolute fit, shown as itself; (b) freeze the scale after the first 50; (c)
keep renormalising but show the movement; (d) drop the percentage, show rank and a tier.
*Recommendation: (a).* The stable number already exists and is thrown away at read time. (b) makes
"best of the first fifty" the ruler forever. (c) explains the instability rather than removing it.
(d) loses the number that makes Triage and Search read as one product.
*The cost of (a):* Triage percentages stop meaning the same as Search percentages, and the
fallback keyword score sits on a different ruler from the model score — normalisation was partly
papering over that.

**Q2. How is a rolling session charged?**
Options: per CV per drop (A); session fee (B); monthly (C); fee plus allowance (D).
*Recommendation: A for the first version, revisit after the eval.* Reasons in 3.4. D is the better
end state.

**Q3. Can the JD be edited mid-session?**
Options: forbid; allow and re-score everything; allow, version it, and score forward.
*Recommendation: allow, version it, score forward,* with old scores labelled and re-scoring offered
as a button. Forbidding it forces a new session and loses the shortlist, which is the thing rolling
exists to prevent.

**Q4. Who pays for a re-score?**
Options: the recruiter, per CV; free; out of an included allowance.
*Recommendation: the recruiter, with the number quoted before they press it.* A free re-score is an
unbounded cost attached to a text box.

**Q5. What is the CV cap on one session?**
Options: keep 500 as a lifetime cap; 500 per drop; raise it.
*Recommendation: keep 500 for the session, and say so up front.* It is a safety limit on a pipeline
that loads every scored row into memory per page. Raising it should follow the paging fix.

**Q6. How long do we keep applicant CVs?**
Options: forever (today); a period after the session closes; a period from each CV's upload; both.
*Recommendation: both — 90 days after close, and 12 months from upload, whichever comes first,* with
the period stated in the privacy policy and configurable. Any number is defensible; no number is
not.

**Q7. Who may pause, close, delete a session, and delete one CV?**
Options: any colleague (today's model); the author or an admin; admin only.
*Recommendation: any seat may pause and close; only the author or an admin may delete.* Deleting is
the one irreversible act and today any colleague can do it to six weeks of someone else's work.

**Q8. Do rejected applicants leave the ranking?**
*Recommendation: they stay and are filtered out by default.* Removing them changes the denominator
of a number that describes the role, and rejections get reversed.

**Q9. Do we notify a recruiter when a strong CV arrives?**
Options: nothing; in-app only; in-app plus a daily email digest.
*Recommendation: in-app for the first version.* An email that says "a strong candidate arrived"
makes a claim about a person based on a score, and I would want the scoring settled first.

**Q10. What happens to existing Triages?**
Options: convert to open; migrate to closed with a Reopen button; leave them outside the new model.
*Recommendation: closed, with Reopen.* They are finished reports. Opening them re-exposes them to
uploads and charges nobody asked for.

**Q11. How does the free allowance work?**
Options: keep 100 CVs across any number of sessions; one free session; 100 CVs but only in one
session.
*Recommendation: keep it as 100 CVs.* It needs no code change and it keeps opening a second role
free, which is the behaviour we want.

**Q12. Should a rolling session also surface matching CVs from the Cursus marketplace over time?**
*Asked as a question only, as you instructed — no plan attached.* What it would mean: the session
would hold two kinds of row with different consent stories, and a marketplace match would need a
paid reveal to be usable while an uploaded applicant needs nothing. That is a significant product
and legal boundary, and the current separation is enforced structurally.

**Q13. Will you run the eval and decide `MATCH_EFFORT` before this ships?**
*Recommendation: yes, first.* Every pricing model above is thin or negative at the current setting,
and the change is already built.

**Q14. Can you get me the production numbers?**
I cannot see the live database. Before any migration is written I need: how many launched Triages
exist, their statuses, how many applicant rows and how many megabytes of CVs. The local database
holds four empty drafts, so it tells me nothing.

**Q15. What happens when the same person sends an updated CV?**
Options: treat it as a new applicant (today); detect by name or email and replace, keeping the
history; detect and ask.
*Recommendation: detect by email and mark the newer one as the current version.* The `duplicate_of`
column already exists and is unused. Two rows for one person in a live shortlist is the kind of
thing that makes a recruiter stop trusting the list.

**Q16. Does closing a session stop analysis that is already paid for?**
*Recommendation: no — let queued work finish, then stop.* Refunding part-finished work is a second
refund path and there is no good reason for it.

---

## 5a. Decisions (given 18 September 2026)

These are the answers to section 5. Where an answer differs from my recommendation, the answer
wins and the plan below is written to it.

| # | Decision |
| --- | --- |
| Q1 | Show the stable absolute fit. No rescaling against the best CV in the session. |
| Q2 | Option A — charge per CV, every time CVs are added. |
| Q3 | **The job description stays locked after launch.** No versioning, no editing. Out of scope. |
| Q4 | Dropped, because of Q3. |
| Q5 | 500 CVs per session, stated to the recruiter up front. |
| Q6 | Delete 90 days after the session closes, or 12 months after each CV's upload, whichever comes first. Both periods are settings, changeable without a code change. |
| Q7 | Any seat may pause and close. Only the author or an admin may delete a session or a single CV. |
| Q8 | Rejected applicants stay in the ranking, hidden by default. |
| Q9 | In-app notice only. No emails. |
| Q10 | Existing Triages become closed, with a Reopen button. |
| Q11 | The free allowance stays at 100 CVs, usable across any number of sessions. |
| Q12 | No marketplace link. The two stay fully separate. |
| Q13 | Run the cost eval first. The setting is not switched without a decision. |
| Q14 | The live numbers come from a read-only check run by someone with access. |
| Q15 | Match the same person by email; the newer CV becomes the current version. No email means a new person. |
| Q16 | Closing lets already-paid analysis finish, then stops. |

**Removed from scope by Q3:** JD versioning, mid-session JD editing, re-scoring, and who pays for
it. Section 3.1's "Editing the JD mid-session" and Q3/Q4 are superseded. The 409 on `PATCH
/api/hr/triage/:id` stays exactly as it is.

**Removed from scope by Q12:** anything that surfaces marketplace candidates inside a session.

### Where each "must" item lands

Every item marked must in section 4, and the must-level items inside section 3, with its phase.
Nothing on this list is allowed to fall between phases.

| Must item | Source | Phase |
| --- | --- | --- |
| Upload catch deletes committed CVs | 4.3 | **1** (first change) |
| Failed launch leaves a half-state | 4.3 | **1** (first change) |
| Queue can run parse/preliminary more than once | 3.1 | 1 |
| Ranks stay stable when CVs arrive | 3.1 | 1 |
| Analysis runs without a browser asking | 3.1 | 1 |
| Results query stops loading every CV's text | 3.1 | 1 |
| Show the stable absolute fit (Q1) | 3.1 | 1 |
| Charge per drop; refunds per drop | 3.4 | 2 |
| Ledger gains a Triage dimension | 3.4 | 2 |
| Capacity checked at drop time, not only at launch | 4.9 | 2 |
| Capacity running out mid-session is visible and recoverable | 4.9 | 2 |
| Re-queue applicants whose analysis failed | 3.1 | 2 |
| Duplicate person by email (Q15) | 3.1 | 2 |
| Lifecycle: open / paused / closed (Q7, Q16) | 3.2 | 3 |
| Existing sessions become closed, with Reopen (Q10) | 3.2 | 3 |
| Delete a single CV — and so answer an erasure request | 3.2 | 3 |
| Retention sweep, log-only for one cycle (Q6) | 3.2 | 3 |
| Empty `uploads/_swept` | 4.7 | 3 |
| Terms and privacy wording, drafted for approval | 4.2 | 3 |
| Per-recruiter "new since I looked" | 4.4 | 4 |
| Add CVs at any time, in the UI | 3.3 | 4 |
| Live list that updates while work runs; polling resumes | 3.3 | 4 |
| Recruiter-set status, rejected hidden by default (Q8) | 3.3 | 4 |
| In-app notice of new arrivals (Q9) | 3.3 | 4 |
| Empty / loading / error states | 3.3 | 4 |
| Sessions list with state, counts, last activity | 3.3 | 5 |
| Copy: landing, info, pricing, demo, 409 strings, over-cap message | 4.1 | 5 |
| The 500 cap stated up front (Q5) | 3.4 | 5 |
| Analytics events, including from the worker | 4.6 | 5 |
| Cap on open sessions per company | 4.7 | 3 (number to be agreed) |
| Lower daily analysis limit | 4.7 | 3 (number to be agreed) |

---

## 6. Phased build plan

Each phase is shippable on its own. Nothing in phase 1 depends on a pricing decision.

### Phase 0 — Decisions and measurements (no code)
Q1, Q2, Q3, Q6, Q10, Q13, Q14 answered. The eval run and `MATCH_EFFORT` decided.
**Effort:** yours, plus one eval run (~$30). **Risk:** building on an unmeasured cost per CV.

### Phase 1 — Make the pipeline able to run twice
The unglamorous half, and the one everything else needs.
- Drop identity: a `triage_drops` row (or a drop number on the applicant) and the drop in the
  queue's idempotency key.
- `prelim_rank` becomes append-only; the frontier is re-derived rather than assumed.
- The pipeline pulls its own work instead of waiting for a browser.
- Fix the results query to stop loading every CV's text on every page load, and move the sort into
  SQL.
- Fix the two bugs in 4.3.
**Depends on:** nothing. **Effort:** the largest single phase — call it a week.
**Risks:** the frontier and rank logic is where a silent skip would hide. Needs a test that adds a
drop mid-analysis and proves every CV ends up scored exactly once.

### Phase 2 — Charging per drop
- `consumeTriageCvs` moves from one claim per session to one claim per drop.
- `charged_cvs` / `refunded_cvs` become per-drop rows; the unreadable refund follows.
- `billing_ledger` gains a Triage dimension.
- Capacity is checked at drop time, with a clear error before the upload rather than after.
- Low-balance handling that is not one email at exactly zero.
**Depends on:** Q2, phase 1. **Effort:** 3–4 days. **Risks:** double-charging or silent
free analysis. Every path needs the same "claim once" discipline the current code has.

### Phase 3 — Lifecycle and retention
- `lifecycle`, `closed_at`, `purge_after` on `triages`; pause, close, reopen routes.
- Existing sessions migrated per Q10.
- Per-CV delete, which also makes erasure requests answerable.
- The retention sweep on the existing daily timer, plus emptying `_swept`.
- Privacy policy and Terms updated; `test/legal-check.mjs` with them.
**Depends on:** Q6, Q7, Q10, Q14. **Effort:** 3–4 days. **Risks:** the sweep deletes real CVs. It
should log for a full cycle before it deletes anything, and the first run should be manual.

### Phase 4 — The session page
- One page instead of the launched/not-launched branch; Add CVs at any time.
- Per-recruiter "new since you looked".
- Drop history; live list that updates while work runs; polling that resumes.
- Recruiter-set status per applicant, with rejected filtered by default.
- Keyset paging.
**Depends on:** phases 1–3, Q1, Q8. **Effort:** ~a week. **Risks:** this is where the tests that
assert on client source text break (three suites). Expect to rewrite them.

### Phase 5 — The list, copy and analytics
- A real sessions list with state, counts and last activity.
- All the copy in 4.1.
- The analytics in 4.6.
**Depends on:** phase 4. **Effort:** 2–3 days. **Risks:** low.

### Later, deliberately not in the first version
Export and sharing; comments and tags on applicants; email digests; per-session permissions; the
marketplace link in Q12.

### Testing
- **New suites:** a drop added mid-analysis (every CV scored exactly once, no rank collisions); two
  drops charged separately with the right refunds; lifecycle transitions and what each state
  refuses; the retention sweep on fixtures only.
- **Suites that must change:** `triage-capacity-check` (asserts uploads 409 after launch, and
  exactly one consume row), `triage-check` (treats `completed` as terminal), `triage-funnel-check`
  (pins the frontier arithmetic to a frozen pile of 60), `triage-history-check`,
  `triage-draft-ux-check`, `triage-folder-check` (all three assert on client source text),
  `legal-check`, `pricing-check`.
- **Rules that apply:** every suite runs against a spare port with `CKING_URL`, mints its own
  marker, and deletes only what it created. `triage_applicants` has no entry in `ADDED_COLUMNS`, so
  any new column on it will silently never appear on the live database unless one is added.

### What could hurt existing users or data during the switch
1. A migration that reopens finished sessions and exposes them to new charges.
2. The retention sweep deleting CVs a recruiter still needs, with no undo.
3. Per-drop charging double-charging the first drop of a migrated session.
4. The upload bug in 4.3 destroying files, which gets more likely with more uploads.
5. A rank or frontier mistake in phase 1 silently leaving CVs unanalysed — the worst failure,
   because the product looks like it worked.

---

## 7. Risks

**The cost problem gets worse before it gets better.** We lose money per CV at the margin today and
rolling sessions raise read-through. Ship the effort change first.

**Silent under-analysis.** Every one-batch assumption in section 1 fails quietly rather than
loudly: a CV with no rank is simply never selected, and the frontier advances as though the work
was done. This is the main technical risk in the whole pivot.

**Holding other people's CVs for longer.** The organization is the controller and we are the
processor, but "indefinitely" is a promise we would rather not be making about people who never
heard of us. Retention is not optional in this pivot.

**One shared session, several recruiters, no permissions.** Today's model — any colleague can do
anything, including delete — is survivable for a one-off report and uncomfortable for six weeks of
shared work.

**The tests pin the old model in eight suites**, three of them by matching client source text with
regular expressions. Expect real work there, and expect at least one suite to be asserting
something we are deliberately changing.

**Scope.** This is not one feature. It is a schema change, a queue change, a billing change, a
lifecycle change, a UI rewrite and a legal change. The phases are ordered so each one is useful
alone, but phases 1 and 2 have to be right or everything above them inherits the fault.

---

## 8. Build log

Each phase is built on `rolling-triage`, tested, reviewed adversarially by readers who did not
write it, and logged here. Nothing has been merged to `main` since the bug-fix release
(`9ee130e`); production still runs Phase 1 only, and `TRIAGE_ADD_CVS` is off there regardless.

### Phase 1 — the pipeline can run twice · done

Drop identity (`triage_drops`, `drop_id` on applicants and batches, and the drop in the queue's
idempotency key), append-only `prelim_rank`, a queue waker so analysis finishes without a browser,
the results query rewritten to name its columns and page in SQL, and the stable `absolute_fit` from
Q1. Both bugs in 4.3 fixed.

**Review found four real defects**, all fixed with regression tests: the tranche was sized by
parsed rows rather than by ranks, so the frontier could run past ranks that did not exist yet; a
legacy draft taking a new file lost its original CVs; `runDeep` claimed rows before work that could
throw; and a later delivery failing left its CVs in a state nothing reported.

One claim I made to Gabriel and then corrected: I said the "Show the next 25" fault was costing
paying customers that day. It is not — on a one-time Triage the overshoot self-heals, because the
initial batch covers ranks 1–50 regardless. It becomes permanent loss only once a session takes a
second delivery.

### Phase 2 — charging per delivery · done

`triage_drops` carries the charge (`ledger_id`, `charged_cvs`, `refunded_cvs`, `charged_at`) and the
UPDATE that sets `ledger_id` is the claim, so a retried upload charges once. Session counters stay
the sum of deliveries, which is why the usage screen, `triageCvsUsed` and the audit script needed no
changes. `billing_ledger` gains `triage_id` and `triage_drop_id`. Refunds are per delivery.
`POST /api/hr/triage/:id/cvs` behind `TRIAGE_ADD_CVS`, capacity checked before anything is written,
`POST /api/hr/triage/:id/retry` free, Q15 by email, decision 4 reported in the results payload, and
a low-balance warning at `TRIAGE_LOW_WATER` (50) instead of one email at exactly zero.

Two migrations, both additive and idempotent: `adoptSessionCharge` hands a pre-deliveries session's
charge to the delivery its CVs are adopted into, and `attributeTriageCharges` does the same at boot
for sessions launched in the window between Phase 1 and Phase 2. Neither writes a ledger row — no
money moves, the charge is recorded where it now belongs.

**Found while building:** the global error handler sweeps every entry in `req.files`, which undid
Phase 1's committed-file protection one layer out. Reachable today through the
launched-while-uploading 409 on the draft upload route: the row survived, its file did not, and the
loss surfaced days later as an unreadable CV.

**Review found eight defects**, two of them losing real money (a legacy session refunding its whole
charge for one unreadable file; a later delivery that failed permanently never being refunded).
All fixed — see commit `2b883c6` for the full account.

**Covered by reasoning rather than by a test:** the four queue-failure fixes (the opening-pile
predicate, the refund for a failed later delivery, the queue leaving a failed session alone, and the
stranded deep batch). Forcing a batch to throw structurally means breaking the model call itself,
and a test that has to win a race in order to fail passes for the wrong reason most of the time.

**Deferred to Phase 4, deliberately:** a CV filed into a folder and then superseded stays in the
folder and in folder exports, carrying its score, while no longer appearing in the ranking — so
there is no affordance to un-file it. The row is still reachable by id, so the dialog and the CV
download work; what is missing is a way to see it from the session page. That belongs with the
session page rewrite.

**One decision for Gabriel, not taken here.** If the server dies between writing a delivery's rows
and charging them, those CVs sit unpaid in a running session: nothing will queue them, and the
session can never report itself complete. `npm run triage:audit` reports the count ("unpaid
deliveries holding CVs"). Clearing them automatically at boot would mean deleting uploaded CVs
without being asked, and charging them automatically would mean taking money without being asked, so
neither is done. Today the local and production counts are zero.

---

*Written 18 September 2026 against the working tree. Cost figures are estimates from prompt sizes,
not measurements — see `docs/ai-cost-review.html`. Production data was not inspected; see Q14.*
