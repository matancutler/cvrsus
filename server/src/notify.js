/**
 * Delivery of candidate sign-in codes.
 *
 * There is no email or SMS provider wired up, so codes are written to the
 * server console. This is the single place to change when you add one: swap the
 * body of `sendLoginCode` for a Nodemailer / Twilio / provider call and
 * everything else keeps working.
 *
 * Until then, `OTP_ECHO` controls whether the API also returns the code to the
 * browser so the flow is usable without a mailbox. It MUST be off in
 * production — with it on, anyone who knows a candidate's email address can
 * sign in as them.
 */
export const OTP_ECHO = process.env.OTP_ECHO === 'true'
  || (process.env.OTP_ECHO === undefined && process.env.NODE_ENV !== 'production')

export async function sendLoginCode({ channel, destination, code, expiresInMinutes }) {
  const target = channel === 'phone' ? 'phone' : 'email'

  console.log('')
  console.log('  ┌─ candidate sign-in code ─────────────────────────────')
  console.log(`  │  to ${target}: ${destination}`)
  console.log(`  │  code:        ${code}`)
  console.log(`  │  valid for:   ${expiresInMinutes} minutes`)
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')

  return { delivered: 'console' }
}

if (OTP_ECHO) {
  console.warn('  WARNING: OTP_ECHO is on — sign-in codes are returned in API responses.')
  console.warn('  Set OTP_ECHO=false and wire a real email/SMS provider before production.\n')
}

/**
 * A password reset for an organization administrator.
 *
 * Console, like everything else here, because no provider is wired up. That is
 * a delivery gap and not a logic one: the token is real, single use and
 * expiring, so wiring a mailer into this one function is all that stands
 * between this and a working reset by email.
 */
export async function sendPasswordReset({ to, name, companyName, link, expiresInMinutes }) {
  console.log('')
  console.log('  ┌─ recruiter password reset ───────────────────────────')
  console.log(`  │  to:         ${to}`)
  console.log(`  │  for:        ${name} at ${companyName}`)
  console.log(`  │  link:       ${link}`)
  console.log(`  │  valid for:  ${expiresInMinutes} minutes`)
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')

  return { delivered: 'console' }
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

/**
 * One email, printed.
 *
 * Returns the subject and body so a caller — or a test — can assert on what
 * would have been sent rather than on the fact that something was.
 */
async function deliver({ to, subject, lines }) {
  console.log('')
  console.log('  ┌─ email ──────────────────────────────────────────────')
  console.log(`  │  to:      ${to}`)
  console.log(`  │  subject: ${subject}`)
  for (const line of lines) console.log(`  │  ${line}`)
  console.log('  └──────────────────────────────────────────────────────')
  console.log('')

  return { delivered: 'console', to, subject, body: lines.join('\n') }
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
