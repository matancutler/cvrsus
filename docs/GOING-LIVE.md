# The four things left before strangers can use it

In order. The first one blocks sign-up entirely; the rest make the product work
as designed.

Everything here is done in **Render → Environment** unless it says otherwise.
Each save is a ~45-second redeploy that does not touch the disk.

---

## 1. SMS — so candidates can finish signing up

**Why:** registration needs a verified email *and* a verified phone. Email is
deliverable. A phone code is currently printed to the log, so a stranger waits
for a text that never arrives.

**The code is already written.** `server/src/notify.js` calls Twilio when three
variables are set and prints when they are not. Nothing to build — only an
account.

### 1a. Create the Twilio account

1. Go to **twilio.com**, sign up, verify your own email and phone.
2. You land on the Console. The trial account has free credit, enough to test.

### 1b. Get a sender

You need a number or a sender ID that texts can come *from*.

**Option A — buy a number** (simplest, works everywhere):
Console → **Phone Numbers → Buy a number**. Pick one with **SMS** capability. A
US number is the cheapest and reaches Israeli phones fine. Around $1/month plus
a few cents per message.

**Option B — an alphanumeric sender ID** (texts appear from "Cursus" rather than
a number): supported for Israel, but requires registration through Twilio and
takes longer. Better later; a number is fine to start.

### 1c. Copy three values

From the Console dashboard:

| Twilio calls it | You need it as |
|---|---|
| Account SID (starts `AC…`) | `TWILIO_ACCOUNT_SID` |
| Auth Token (click to reveal) | `TWILIO_AUTH_TOKEN` |
| Your number, E.164 e.g. `+15551234567` | `TWILIO_FROM` |

### 1d. Put them in Render

Environment → add all three → **Save**.

### 1e. Test it

On a **trial** account Twilio will only text numbers you have verified in the
Console — so verify your own number first (Console → Phone Numbers → Verified
Caller IDs), then go to `https://cvrsvs.com/apply` and start a sign-up with your
own phone number. The text should arrive in seconds.

If it does not, **Logs** will show Twilio's own words:

```
Twilio refused the message (400): {"code":21608,"message":"…unverified…"}
```

Code `21608` means the trial restriction above. Upgrading the account removes
it.

### Why a laptop cannot send by accident

Email protects itself: fixtures write to `example.com`, and the code refuses
those whatever key is set. Phone numbers have no reserved range — a test number
is somebody's real handset.

So the guard is the environment: **texts are only sent under
`NODE_ENV=production`.** Your laptop and the test suites run as `development`,
so even with the credentials set they print. If you ever genuinely need a real
send from your machine, set `SMS_ALLOW_NON_PRODUCTION=true` for that one run.

---

## 2. Email — rotate the key, then set it

**Why:** every email is currently printed to the log rather than sent. Approval
notices, sign-in codes, check-ins — none of them arrive.

**Rotate first.** The existing key was pasted into a chat transcript. Treat it as
public.

### 2a. Replace the key

1. **resend.com** → **API Keys**.
2. **Create API Key** — name it `cursus-production`, permission **Sending
   access**. Copy it now; Resend shows it once.
3. Delete the old key. Do this *after* the new one is in Render, or you will
   have a window with neither.

### 2b. Set three variables

```
RESEND_API_KEY   re_…            the new key
MAIL_FROM        Cursus <no-reply@mail.cvrsvs.com>
MAIL_REPLY_TO    (a mailbox you actually read, or leave blank)
```

`MAIL_FROM` must be on a domain verified in Resend. Yours is `mail.cvrsvs.com`
and it is already verified — SPF, DKIM and MX are all in place. Do not change it
to `cvrsvs.com`; the subdomain is deliberate, so sending records and website
records cannot collide.

`MAIL_REPLY_TO` only helps if somebody reads it. Resend sends but does not
receive, so an address there with no mailbox behind it is worse than none.

### 2c. Test it

Sign up a company at `https://cvrsvs.com/hr` with an address you own. The
approval email should arrive. Then check **Logs** — emails should have *stopped*
appearing there, because they are being sent instead of printed.

Fixtures still print: any address at `example.com`, `.test` or `.invalid` is
refused delivery whatever the key says, so the test suite can never mail a
stranger.

---

## 3. The AI keys — what makes it the product

**Why:** without them, CV reading and match scoring fall back to keyword
overlap. Every search still returns people; it just matches wording rather than
meaning, and every candidate's score comes from term matching rather than
judgement.

### 3a. Anthropic

1. **console.anthropic.com** → **Settings → API Keys → Create Key**.
2. Add credit under **Billing**. This is pay-as-you-go — no plan to choose.
3. Set `ANTHROPIC_API_KEY`.

This is what reads each CV on upload and judges each candidate against a job
description.

**It costs money per search.** `AI_RANK_LIMIT` (default 25) caps how many
candidates are read in full per search, which is the lever on both latency and
spend. Everyone below the cut keeps their keyword score and the results say so.

### 3b. Voyage

1. **dashboard.voyageai.com** → create a key.
2. Set `VOYAGE_API_KEY`.

This turns each profile into a vector once, so a job description matches by
meaning — a CV saying "Vue design system" surfaces for a React role. It decides
*which* profiles Claude reads, not how they score.

Changing `VOYAGE_MODEL` later invalidates every stored vector, because vectors
are only comparable within one model. Profiles re-embed on their next edit.

### 3c. Check it worked

The startup banner in **Logs** stops saying `ANTHROPIC_API_KEY is not set`. Run
a search: results should carry reasoning, not just a keyword score.

---

## 4. DMARC — so your mail is trusted

**Why:** you have SPF and DKIM. DMARC is the third record that tells receiving
servers what to do when a message fails those checks. Without it, Gmail and
Outlook are more likely to treat your mail as suspicious — and a sign-in code in
a spam folder is a candidate who never signs in.

### The record

Cloudflare → `cvrsvs.com` → **DNS → Records → Add record**:

```
Type      TXT
Name      _dmarc.mail
Content   v=DMARC1; p=none; rua=mailto:you@cvrsvs.com
TTL       Auto
Proxy     n/a for TXT
```

`Name` is `_dmarc.mail` because your sending domain is `mail.cvrsvs.com`.
Cloudflare appends the zone, giving `_dmarc.mail.cvrsvs.com`.

### What the policy means

- `p=none` — "tell me about failures, do not act on them". **Start here.** It
  changes nothing about delivery and begins collecting reports.
- `p=quarantine` — failures go to spam.
- `p=reject` — failures are refused outright.

Move to `quarantine` after a few weeks of clean reports, and only then consider
`reject`. Going straight to `reject` with a misconfiguration means your own mail
disappears silently.

`rua=` is where aggregate reports are sent. Use an address you can read.

---

## The order matters

1. **SMS** unblocks sign-up. Nothing else matters if nobody can register.
2. **Email** makes approvals and codes arrive.
3. **AI keys** make matching work as designed.
4. **DMARC** improves whether any of that mail lands.

You can do 2 before 1 if you want to see emails working sooner — they are
independent. But 1 is the one standing between you and a usable site.
