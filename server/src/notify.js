/**
 * Every message the product sends, and where it goes.
 *
 * Email is delivered through Resend when RESEND_API_KEY is set and printed to
 * the console when it is not. SMS has no provider yet, so a sign-in code sent
 * to a phone is still console-only — which is the one reason OTP_ECHO cannot be
 * turned off yet.
 *
 * `OTP_ECHO` controls whether the API also returns the code to the browser so
 * the flow is usable without a mailbox. It MUST be off in production — with it
 * on, anyone who knows a candidate's email address can sign in as them.
 */
export const OTP_ECHO = process.env.OTP_ECHO === 'true'
  || (process.env.OTP_ECHO === undefined && process.env.NODE_ENV !== 'production')

export async function sendLoginCode({ channel, destination, code, expiresInMinutes }) {
  /*
   * A code going to a phone goes by SMS when a provider is configured, and to
   * the console when one is not — the same rule email follows, so the two
   * channels behave alike and neither can silently do nothing.
   */
  if (channel === 'phone') {
    return sendSms({
      to: destination,
      body: `${code} is your Cursus sign-in code. It is valid for `
        + `${expiresInMinutes} minutes and can be used once.`,
      label: 'candidate sign-in code',
      expiresInMinutes,
      code,
    })
  }

  /*
   * The code is in the subject on purpose. It is the first thing shown in a
   * notification preview, and a candidate who can read it there does not have
   * to open anything — which is the difference between a code that gets used
   * and one that expires.
   */
  return deliver({
    to: destination,
    subject: `${code} is your Cursus sign-in code`,
    lines: [
      'Hi,',
      `Your Cursus sign-in code is ${code}.`,
      `It is valid for ${expiresInMinutes} minutes and can be used once.`,
      'If you did not ask to sign in, you can ignore this email — nobody can '
        + 'use the code without it.',
      '— Cursus',
    ],
  })
}

if (OTP_ECHO) {
  console.warn('  WARNING: OTP_ECHO is on — sign-in codes are returned in API responses.')
  console.warn('  Set OTP_ECHO=false and wire a real email/SMS provider before production.\n')
}

/**
 * A password reset for an organization administrator.
 *
 * Sent, not printed.
 *
 * This function used to console.log the reset link and return
 * {delivered:'console'}, with a comment saying no provider was wired up. That
 * comment outlived its truth: deliver() has posted to Resend since
 * RESEND_API_KEY existed, and eighteen other templates in this file go through
 * it. The consequence was not cosmetic. The link is a single-factor account
 * recovery credential for an ORGANIZATION ADMINISTRATOR — redeeming it needs
 * the token and nothing else, no session and no company key — and it was being
 * written in plaintext to a log stream that travels further than any database:
 * dashboard viewers, log drains, exported bundles, screen shares.
 *
 * And the person entitled to it never received it, while the route answered
 * {sent: true}. So administrator recovery was both broken and dangerous, in
 * the same eleven lines.
 *
 * deliver() still prints when there is no key or the address is a reserved
 * test domain, so development and the suites are unchanged — but it prints the
 * body it would have sent, under the rule that applies to every other message,
 * rather than because this one function opted out.
 */
export async function sendPasswordReset({ to, name, companyName, link, expiresInMinutes }) {
  return deliver({
    to,
    subject: 'Reset your Cursus password',
    lines: [
      `Hi ${name},`,
      `Somebody asked to reset the password for your Cursus account at ${companyName}.`,
      `Open this link to choose a new one: ${link}`,
      `It is valid for ${expiresInMinutes} minutes and can be used once.`,
      'If this was not you, ignore this email. Your password has not changed, '
        + 'and nobody can use the link without opening it.',
      '— Cursus',
    ],
  })
}

/**
 * Where the yes/no links in a check-in email point. Set APP_URL when the app is
 * not being served from the same origin the candidate will click into.
 */
export const APP_URL = (process.env.APP_URL ?? 'http://localhost:5175').replace(/\/+$/, '')

export function checkinLinks(token) {
  const base = `${APP_URL}/check-in/${encodeURIComponent(token)}`
  return { yes: `${base}?answer=yes`, no: `${base}?answer=no`, page: base }
}

/**
 * The final day of the inactivity sequence — the one that reads differently.
 *
 * Named rather than inlined because three things key off it: the subject, the
 * absence of a "we'll ask again" promise, and the reassurance that the account
 * itself survives. Getting any of them wrong on an earlier email would be a lie
 * about what happens next.
 */
const FINAL_STAGE = 58

/**
 * One of the five inactivity reminders — day 30, 37, 44, 51 or 58.
 *
 * One function, not five templates. The only things that vary are the opening
 * line, the countdown and whether there is another email coming, and all three
 * follow from the canonical activity clock: daysRemaining is computed by the
 * caller from the same state that decides Green, Orange and hidden, so the
 * number in the email cannot drift from the date the profile actually goes.
 *
 * Both answers are one click from the email on purpose. A confirmation that
 * needs a login to answer gets ignored, and being ignored is exactly what the
 * badge on the candidate's profile ends up reporting.
 */
export async function sendFreshnessReminder({ to, name, token, stage, daysRemaining }) {
  const links = checkinLinks(token)
  const final = stage >= FINAL_STAGE
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`

  const opening = final
    ? [
      'This is your final activity reminder.',
      'We still have not recorded any activity on your Cursus account, and your profile is '
        + `scheduled to be hidden from recruiters in ${days(daysRemaining)}.`,
    ]
    : [
      stage <= 30
        ? 'We have not recorded any activity on your Cursus account for the past 30 days.'
        : 'We still have not recorded any activity on your Cursus account.',
    ]

  const closing = final
    ? [
      `If we do not hear from you within ${days(daysRemaining)}, your profile will `
        + 'automatically be hidden from recruiters.',
      'Your account will not be deleted. You can return to Cursus and make your profile '
        + 'visible again at any time.',
    ]
    : [
      'If we do not hear from you, your profile will be automatically hidden from '
        + `recruiters in ${days(daysRemaining)}.`,
      'We will check again in 7 days if you have not responded or become active before then.',
    ]

  return deliver({
    to,
    subject: final
      ? `Final reminder: Your Cursus profile will be hidden in ${days(daysRemaining)}`
      : (stage <= 30 ? 'Are you still open to opportunities?' : 'Still open to opportunities?'),
    lines: [
      `Hi ${name ?? 'there'},`,
      ...opening,
      'Are you still open to opportunities?',
      `Yes, keep me visible: ${links.yes}`,
      `No, hide my profile: ${links.no}`,
      ...closing,
      '— Cursus',
    ],
  })
}

/**
 * A recruiter has asked whether this candidate is still looking.
 *
 * Names the company, because an unattributed "somebody is interested" is
 * indistinguishable from spam. Names nothing else: the recruiter has not paid
 * to reveal this candidate and is not entitled to be introduced, and the
 * candidate is answering a question about themselves rather than opening a
 * conversation.
 *
 * The same yes/no token as the reminder above, deliberately. A candidate has
 * one answer to give about whether they are open to opportunities, and it
 * should not matter which email prompted it.
 */
export async function sendAvailabilityCheckEmail({ to, name, token, companyName }) {
  const links = checkinLinks(token)

  return deliver({
    to,
    subject: `${companyName ?? 'A company'} is interested in your profile`,
    lines: [
      `Hi ${name ?? 'there'},`,
      `A recruiter from ${companyName ?? 'a company on Cursus'} is interested in your profile on Cursus.`,
      'Are you currently open to opportunities?',
      `Yes: ${links.yes}`,
      `No: ${links.no}`,
      '— Cursus',
    ],
  })
}

/**
 * The answer, back to the recruiter who asked.
 *
 * "Confirmed that they are currently open to opportunities" and nothing
 * stronger. The candidate has said they are looking; they have not agreed to
 * reply to this recruiter, and a subject line promising a conversation would be
 * selling something Cursus cannot deliver.
 */
export async function sendAvailabilityConfirmedEmail({ to, name, candidateName, candidateId }) {
  return deliver({
    to,
    subject: `${candidateName ?? 'A candidate'} is available`,
    lines: [
      `Hi ${name ?? 'there'},`,
      `Good news — ${candidateName ?? 'the candidate'} confirmed that they are currently `
        + 'open to opportunities.',
      'Their Cursus activity status has been refreshed.',
      `View candidate: ${APP_URL}/hr?candidate=${encodeURIComponent(candidateId ?? '')}`,
      '— Cursus',
    ],
  })
}

/** The same question answered the other way. No link: there is nothing to open. */
export async function sendAvailabilityDeclinedEmail({ to, name, candidateName }) {
  return deliver({
    to,
    subject: `${candidateName ?? 'A candidate'} is not currently available`,
    lines: [
      `Hi ${name ?? 'there'},`,
      `${candidateName ?? 'The candidate'} has indicated that they are not currently open `
        + 'to opportunities.',
      '— Cursus',
    ],
  })
}

/**
 * Somebody paid to unlock this candidate, and the candidate is told.
 *
 * Every charged reveal, not only the first: each one is a different company
 * gaining their surname, email and phone, and the second is no less worth
 * knowing about than the first.
 *
 * "They may contact you" is the strongest thing this email is allowed to say. A
 * reveal is interest, not an appointment — the recruiter may read the CV and do
 * nothing — and a candidate who reads this as a promise of contact has been
 * told something Cursus cannot guarantee.
 */
export async function sendRevealNotice({ to, name, companyName }) {
  return deliver({
    to,
    subject: 'A recruiter revealed your profile on Cursus',
    lines: [
      `Hi ${name ?? 'there'},`,
      `Good news — a recruiter from ${companyName ?? 'a company on Cursus'} has revealed `
        + 'your profile on Cursus.',
      'This means they were interested enough in your profile to unlock your full details.',
      'They may contact you directly regarding an opportunity.',
      '— Cursus',
    ],
  })
}

/**
 * Tells a candidate a recruiter has written to them.
 *
 * The subject names the person and the company — "Sarah from NVIDIA sent you a
 * message" — because an unattributed "you have a new message" is
 * indistinguishable from spam and gets ignored.
 *
 * The message body is deliberately not included. It lives in the conversation,
 * where the candidate can reply, and where it is covered by the platform's
 * rules rather than sitting in an inbox after a thread has been closed.
 */
export async function sendMessageEmail({ to, candidateName, recruiterName, companyName, recruiterId }) {
  const link = `${APP_URL}/account?thread=${encodeURIComponent(recruiterId)}`
  const from = [recruiterName, companyName].filter(Boolean).join(' from ')

  console.log('')
  console.log('  ┌─ new message ────────────────────────────────────────')
  console.log(`  │  to:      ${to}`)
  console.log(`  │  subject: ${from} sent you a message`)
  console.log(`  │  hi:      ${candidateName ?? 'there'}`)
  console.log(`  │  read it: ${link}`)
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')

  return { delivered: 'console', link, subject: `${from} sent you a message` }
}

/**
 * Sent after a candidate answers no. Confirms what happened and says how to undo
 * it — a profile going quiet with no acknowledgement is how someone ends up
 * assuming the service is broken rather than obeying them.
 */
export async function sendDeactivationEmail({ to, name }) {
  console.log('')
  console.log('  ┌─ profile deactivated ────────────────────────────────')
  console.log(`  │  to:   ${to}`)
  console.log(`  │  hi:   ${name ?? 'there'}`)
  console.log('  │  Your profile is hidden from recruiters at your request,')
  console.log('  │  and the monthly emails have stopped.')
  console.log(`  │  Sign in to reactivate whenever you like: ${APP_URL}/portal`)
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')

  return { delivered: 'console' }
}

/* ==========================================================================
   The automated communications brief.

   Everything below is one template each, written out in full rather than
   assembled from fragments: this file is where the wording gets reviewed, and
   copy stitched together from variables is copy nobody can read.

   `deliver` is the seam. Swap its body for a provider call and every message
   here goes out for real; until then they are printed, which is what makes the
   whole notification surface visible in development.
   ========================================================================== */

/*
 * Where email actually goes.
 *
 * Resend when a key is configured, the console otherwise. The fallback is not
 * a stub to be removed later — it is what makes the whole suite runnable
 * without credentials, and what a developer sees when they run the server with
 * no .env at all.
 */
const RESEND_KEY = process.env.RESEND_API_KEY ?? ''

/*
 * The From address, and why it is not simply an address.
 *
 * Resend will only send from a domain verified in the account. Until
 * mail.cvrsvs.com is verified this default is Resend's own shared sender,
 * which delivers ONLY to the address that owns the Resend account — useful for
 * proving the wiring works, useless for candidates. Set MAIL_FROM once the
 * domain is verified.
 */
const MAIL_FROM = process.env.MAIL_FROM ?? 'Cursus <onboarding@resend.dev>'

/* Where a candidate's reply goes, since the From is a no-reply. Several of
   these emails do invite an answer in practice. */
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO ?? ''

/*
 * Addresses that must never reach a provider.
 *
 * RFC 2606 reserves example.com, .test, .invalid and localhost precisely so
 * that they can be used in documentation and test fixtures without anybody
 * trying to deliver to them — and every fixture in this repository uses
 * `@cking-<run>.example.com`. Without this guard, running the test suite on a
 * machine whose .env carries a real key would fire hundreds of live sends at
 * addresses that cannot exist, burn quota, and teach the provider that this
 * domain generates hard bounces. That last part is the expensive one: bounce
 * rate is what deliverability is scored on, and sign-in codes are the mail
 * that must never land in spam.
 *
 * Checked here rather than in the tests, because the tests are not the only
 * thing that could do it.
 */
const UNROUTABLE = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|test|invalid|localhost)$/i

/** Exported so the rule can be tested without a live key and a real send. */
export const isUnroutable = (address) => UNROUTABLE.test(String(address ?? ''))

/** True when mail would really be sent, so callers can log honestly. */
export const MAIL_LIVE = Boolean(RESEND_KEY)

function printed(to, subject, lines, note) {
  console.log('')
  console.log('  ┌─ email ──────────────────────────────────────────────')
  console.log(`  │  to:      ${to}`)
  console.log(`  │  subject: ${subject}`)
  for (const line of lines) console.log(`  │  ${line}`)
  if (note) console.log(`  │  (${note})`)
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')
}

/**
 * One email, sent or printed.
 *
 * Returns the subject and body either way, so a caller — or a test — can
 * assert on what would have been sent rather than on the fact that something
 * was. That is why every template in this file goes through here.
 *
 * Throws on a provider failure rather than swallowing it. Callers that must
 * not fail because of the outbox already wrap this in try/catch or .catch();
 * making the failure invisible here would take that choice away from them.
 */
async function deliver({ to, subject, lines }) {
  const body = lines.join('\n\n')
  const result = { to, subject, body }

  if (!RESEND_KEY) {
    printed(to, subject, lines)
    return { ...result, delivered: 'console' }
  }

  if (UNROUTABLE.test(String(to ?? ''))) {
    printed(to, subject, lines, 'reserved test domain — not sent')
    return { ...result, delivered: 'skipped' }
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RESEND_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      text: body,
      ...(MAIL_REPLY_TO ? { reply_to: MAIL_REPLY_TO } : {}),
    }),
  })

  if (!response.ok) {
    /*
     * The provider's own words, and nothing of ours. Resend explains refusals
     * usefully — an unverified domain, a malformed From — and those are the
     * failures worth reading. The key is never in this string.
     */
    const detail = await response.text().catch(() => '')
    throw new Error(`Resend refused the message (${response.status}): ${detail.slice(0, 300)}`)
  }

  const { id } = await response.json().catch(() => ({}))
  console.log(`  email sent to ${to} — ${subject}${id ? ` [${id}]` : ''}`)

  return { ...result, delivered: 'resend', id: id ?? null }
}

/* ------------------------------------------------------------------ SMS --- */

/* Which account. Always this, even when an API key does the authenticating:
   it is part of the URL, and Twilio needs to know whose messages these are. */
const SMS_SID = process.env.TWILIO_ACCOUNT_SID ?? ''

/*
 * Two ways to prove who we are, and the better one first.
 *
 * An API key (SK…) plus its secret is revocable on its own: if it leaks, you
 * delete that one key and every other thing using the account keeps working.
 * The account's Auth Token is the master credential — revoking it means
 * rotating everything at once, and this project has already had one credential
 * end up somewhere public.
 *
 * The Auth Token still works, because it is one field instead of two and that
 * is a reasonable way to get the first text sent. But if both are present the
 * key wins, so moving to one later is a matter of adding two variables and
 * deleting one.
 */
const SMS_KEY = process.env.TWILIO_API_KEY ?? ''
const SMS_SECRET = process.env.TWILIO_API_SECRET ?? ''
const SMS_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? ''

const SMS_USER = SMS_KEY || SMS_SID
const SMS_PASS = SMS_KEY ? SMS_SECRET : SMS_TOKEN

/* The number or alphanumeric sender ID messages come from. Twilio rejects a
   send with no From, so all of these have to be present before anything is
   live. */
const SMS_FROM = process.env.TWILIO_FROM ?? ''

/** True when a text would really be sent, so callers can log honestly. */
export const SMS_LIVE = Boolean(SMS_SID && SMS_USER && SMS_PASS && SMS_FROM)

/*
 * A test run must not be able to send a real text.
 *
 * Email protects itself: every fixture writes to a domain RFC 2606 reserves,
 * and UNROUTABLE refuses those whatever key is set. Phone numbers have no
 * equivalent — there is no reserved range a suite can safely use, and a fixture
 * number like 0509123456 is somebody's actual handset.
 *
 * So the guard is the environment instead. Sending happens only under
 * NODE_ENV=production, which no suite runs with (scratchpad/start5199.sh sets
 * development, and so does `npm run dev`). Setting the credentials on a laptop
 * therefore cannot cost money or wake a stranger; it prints, exactly as now.
 *
 * SMS_ALLOW_NON_PRODUCTION exists for the one hour somebody genuinely wants to
 * test a real send from a laptop. It is deliberately long and ugly to type.
 */
const SMS_ALLOWED = process.env.NODE_ENV === 'production'
  || process.env.SMS_ALLOW_NON_PRODUCTION === 'true'

/*
 * The country a bare national number belongs to.
 *
 * Israel unless told otherwise, because that is who signs up. Set SMS_COUNTRY
 * to another dialling code — "44", "1" — if that ever stops being true.
 */
const SMS_COUNTRY = process.env.SMS_COUNTRY ?? '972'

/**
 * A phone number in the form Twilio can route.
 *
 * Candidates type what they would tell a friend: "052-959-2503", "054 987
 * 6543", sometimes "+972 52 959 2503". Twilio needs E.164 — a plus, a country
 * code, then the subscriber digits and nothing else — and rejects anything else
 * with error 21211, which reads as "invalid To number" and says nothing about
 * formatting.
 *
 * This is NOT phoneKey. That keeps the last nine digits so two spellings of one
 * number match each other, which is the right rule for looking somebody up and
 * the wrong one for dialling them: nine digits are not a phone number, they are
 * a fingerprint of one.
 *
 * Three cases, in order:
 *   already international   +972529592503  → unchanged
 *   00-prefixed             00972529592503 → +972529592503
 *   national, leading zero  0529592503     → +972529592503
 *
 * Anything else is returned as-is rather than guessed at. A number this cannot
 * place is one Twilio should refuse loudly, not one we should invent a country
 * for and send somewhere unexpected.
 */
export function toE164(value, country = SMS_COUNTRY) {
  const text = String(value ?? '').trim()
  if (!text) return text

  /* Spaces, dashes and brackets are decoration everywhere they appear. */
  const cleaned = text.replace(/[\s()\-.]/g, '')

  if (cleaned.startsWith('+')) return cleaned
  if (cleaned.startsWith('00')) return `+${cleaned.slice(2)}`
  if (cleaned.startsWith('0')) return `+${country}${cleaned.slice(1)}`

  return cleaned
}

/**
 * The From, in the form Twilio accepts.
 *
 * It needs E.164 here too, and a number pasted into a dashboard without its
 * leading + is refused with 21212 — "Invalid From Number", naming a number that
 * looks perfectly correct to a reader. Normalising it costs nothing and removes
 * a whole class of configuration error that is invisible until the first send.
 *
 * Only when it IS a number. An alphanumeric sender ID — "Cursus" instead of a
 * number, which is worth having once the account supports it — must be passed
 * through untouched, and running it through toE164 would mangle it.
 */
function sender() {
  /* An alphanumeric sender ID is not a number and must survive untouched. */
  if (!/^[+\d\s()\-.]+$/.test(SMS_FROM)) return SMS_FROM

  const dialled = toE164(SMS_FROM)
  if (dialled.startsWith('+')) return dialled

  /*
   * Bare digits, and toE164 left them alone because for a DESTINATION it
   * refuses to guess: 529592503 could be a national number missing its country
   * or an international one missing its plus, and inventing the wrong answer
   * texts a stranger.
   *
   * A sender has no such ambiguity. You never configure a From in national
   * format — the number you were given by Twilio is international — so digits
   * with no plus are digits missing their plus, and that is what 21212 was
   * complaining about.
   */
  return `+${dialled.replace(/\D/g, '')}`
}

function printedSms(to, code, expiresInMinutes, note) {
  console.log('')
  console.log(`  ┌─ candidate sign-in code (${note}) ─────────────`)
  console.log(`  │  to phone:  ${to}`)
  console.log(`  │  code:      ${code}`)
  console.log(`  │  valid for: ${expiresInMinutes} minutes`)
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')
}

/**
 * One text, through Twilio's REST API.
 *
 * No SDK: this is one POST with three form fields, and a dependency that ships
 * a whole client for it would be more surface than the thing it replaces. The
 * shape mirrors deliver() above deliberately — same fallback to the console,
 * same habit of reporting the provider's own words on refusal, same rule that
 * the credentials never appear in an error string.
 */
async function sendSms({ to, body, expiresInMinutes, code }) {
  if (!SMS_LIVE) {
    printedSms(to, code, expiresInMinutes, 'SMS not configured')
    return { delivered: 'console', channel: 'phone' }
  }

  if (!SMS_ALLOWED) {
    printedSms(to, code, expiresInMinutes, 'not production — not sent')
    return { delivered: 'skipped', channel: 'phone' }
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${SMS_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        /* Basic auth is what Twilio's REST API takes. Buffer rather than btoa
           so this does not depend on which globals the runtime happens to
           expose. */
        authorization: `Basic ${Buffer.from(`${SMS_USER}:${SMS_PASS}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      /* Converted here rather than at the call site: every path into this
         function carries whatever the candidate typed, and one conversion at
         the edge is one place to be right. */
      body: new URLSearchParams({ To: toE164(to), From: sender(), Body: body }),
    },
  )

  if (!response.ok) {
    /* Twilio explains refusals precisely — an unverified number on a trial
       account, a region the account cannot reach, a malformed From. Those are
       the failures worth reading, and none of them contain the token. */
    const detail = await response.text().catch(() => '')
    throw new Error(`Twilio refused the message (${response.status}): ${detail.slice(0, 300)}`)
  }

  const { sid } = await response.json().catch(() => ({}))
  console.log(`  sms sent to ${to}${sid ? ` [${sid}]` : ''}`)

  return { delivered: 'twilio', channel: 'phone', id: sid ?? null }
}

/** 1 — the candidate's account exists and is already working for them. */
export async function sendCandidateWelcome({ to, name }) {
  return deliver({
    to,
    subject: 'Welcome to Cursus',
    lines: [
      `Hi ${name ?? 'there'},`,
      'Welcome to Cursus. Your profile is now live and can be matched with relevant opportunities.',
      "You don't need to search or apply — recruiters can find you when there's a match.",
      "We'll check in periodically to make sure you're still open to opportunities.",
      '— Cursus',
    ],
  })
}

/**
 * 2a — the account exists and cannot be used yet.
 *
 * Only for a company nobody has approved. A colleague joining an organization
 * that is already through review has not started a review of their own, and
 * telling them their account is "being reviewed" would be false and would leave
 * them waiting for an approval email that is never coming.
 */
export async function sendRecruiterUnderReview({ to, name }) {
  return deliver({
    to,
    subject: 'Your Cursus account is being reviewed',
    lines: [
      `Hi ${name ?? 'there'},`,
      'Thanks for creating an account with Cursus.',
      "We're reviewing your details now. Once your company is approved, we'll send you your "
        + 'company key so you and your team can sign in.',
      "This usually doesn't take long — we'll be in touch soon.",
      '— Cursus',
    ],
  })
}

/**
 * 2b — approved, with the key.
 *
 * The key is the credential for the whole organization, so the email says so
 * plainly rather than leaving somebody to discover it by forwarding the message
 * to a colleague. Sent once, on the approval event.
 */
export async function sendRecruiterApproved({ to, name, companyName, companyKey }) {
  return deliver({
    to,
    subject: "You're approved — here's your company key",
    lines: [
      `Hi ${name ?? 'there'},`,
      'Your account has been approved. Welcome to Cursus.',
      'Your company key:',
      `${companyKey}`,
      `Use it to sign in. This key covers every account created under ${companyName} — `
        + 'colleagues joining your team will sign in with the same key.',
      'Treat it like a password: keep it private, and only share it with people you trust to act '
        + "on your company's behalf.",
      `Sign in: ${APP_URL}/hr`,
      '— Cursus',
    ],
  })
}

/**
 * 2c — not approved, and deliberately vague about why.
 *
 * The specifics belong in a conversation with a person. A generic reason keeps
 * the door open for the ordinary case, which is a detail that could not be
 * verified rather than a company anybody objects to.
 */
export async function sendRecruiterDeclined({ to, name }) {
  return deliver({
    to,
    subject: 'We need more information to approve your account',
    lines: [
      `Hi ${name ?? 'there'},`,
      "Unfortunately we weren't able to complete the review of your account with the details "
        + 'provided.',
      "This is often easy to resolve — get in touch and we'll continue your application together.",
      'Contact us: https://cvrsvs.com/contact',
      '— Cursus',
    ],
  })
}

/**
 * 4 — the profile has been hidden after sixty days without a confirmation.
 *
 * Distinct from the email a candidate gets when they choose to hide themselves.
 * This one has to explain a change they did not ask for, so it leads with why.
 */
export async function sendAutoHiddenEmail({ to, name, token = null }) {
  return deliver({
    to,
    subject: 'Your Cursus profile is now hidden',
    lines: [
      `Hi ${name ?? 'there'},`,
      "We haven't received an activity confirmation from you in 60 days, so your profile has been "
        + 'hidden from recruiters.',
      'Want to become visible again?',
      token ? `Make my profile visible: ${checkinLinks(token).yes}` : `Sign in: ${APP_URL}/account`,
      '— Cursus',
    ],
  })
}

/** 6 — the candidate wrote back. The reply itself stays on Cursus. */
export async function sendReplyEmail({ to, name, candidateName, candidateId = null }) {
  return deliver({
    to,
    subject: `${candidateName ?? 'A candidate'} replied to your message`,
    lines: [
      `Hi ${name ?? 'there'},`,
      `${candidateName ?? 'A candidate'} has replied to your message on Cursus.`,
      `View reply: ${APP_URL}/hr${candidateId ? `?candidate=${encodeURIComponent(candidateId)}` : ''}`,
      '— Cursus',
    ],
  })
}

/**
 * 7 — the reveal balance has just hit zero.
 *
 * On the transition only. A team that stays at zero for a fortnight does not
 * want fourteen emails about it, and the product already says so on screen
 * every time somebody tries.
 */
export async function sendRevealsEmptyEmail({ to, name }) {
  return deliver({
    to,
    subject: "You're out of Reveals",
    lines: [
      `Hi ${name ?? 'there'},`,
      'Your Cursus account has no Reveals remaining.',
      'Purchase more Reveals to continue unlocking candidate profiles.',
      `Buy Reveals: ${APP_URL}/hr?billing=reveals`,
      '— Cursus',
    ],
  })
}

/** 8 — the same, for Triage capacity. A separate balance and a separate email. */
export async function sendTriageEmptyEmail({ to, name }) {
  return deliver({
    to,
    subject: "You're out of Triage CVs",
    lines: [
      `Hi ${name ?? 'there'},`,
      'Your Cursus account has used its available Triage CV allowance.',
      'Purchase more to continue analysing CVs with Triage.',
      `Buy Triage CVs: ${APP_URL}/hr?billing=triage`,
      '— Cursus',
    ],
  })
}

/** 9 — a month's notice before the seat subscription renews or lapses. */
export async function sendSeatExpiryEmail({ to, name, expiryDate }) {
  return deliver({
    to,
    subject: 'Your Cursus Seat subscription expires in one month',
    lines: [
      `Hi ${name ?? 'there'},`,
      `Your Cursus Seat subscription is scheduled to expire on ${expiryDate}.`,
      'You can review your Seats and subscription details in Settings.',
      `Manage Seats: ${APP_URL}/hr?billing=seats`,
      '— Cursus',
    ],
  })
}

/** 10 — a charge did not go through, and somebody has to act on it. */
export async function sendPaymentFailedEmail({ to, name, amount, productType }) {
  return deliver({
    to,
    subject: 'Your Cursus payment failed',
    lines: [
      `Hi ${name ?? 'there'},`,
      `We couldn't process your payment of ${amount} for ${productType}.`,
      'Please update your payment details or try again.',
      `Review payment: ${APP_URL}/hr?billing=reveals`,
      '— Cursus',
    ],
  })
}
