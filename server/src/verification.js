import crypto from 'node:crypto'

import db, { emailKey, phoneKey } from './db.js'

/**
 * Proving an email address and a phone number belong to whoever is signing up.
 *
 * The existing login codes (accounts.js) cannot do this job: they are keyed by
 * candidate id, and at sign-up there is no account yet — that is the whole
 * point. These are keyed by the destination itself, so a code can be sent to an
 * address nobody has claimed.
 *
 * Verification then has to survive the gap between "I typed the code" and "I
 * submitted the form", which may be several minutes and several other fields
 * later. Rather than hold server-side state for that window, a successful check
 * mints a short-lived signed proof; the sign-up route re-checks the signature
 * and that the proof names the address actually being registered. Nothing is
 * trusted from the client except a string this server signed.
 */

const CODE_TTL_MINUTES = 10
const MAX_CODE_ATTEMPTS = 5

/** How long a proof stays good for. Long enough to finish a form, no longer. */
const PROOF_TTL_MINUTES = 45

/**
 * One canonical spelling per destination.
 *
 * Codes are looked up by this, so "Dana@Example.com" and "dana@example.com"
 * cannot each hold a separate pending code — and a phone verified as
 * "050-123-4567" still matches when the form submits "0501234567".
 */
export function normalizeDestination(channel, value) {
  const text = String(value ?? '').trim()
  /*
   * emailKey, not toLowerCase — the same function findCandidateByContact uses.
   *
   * These were two canonicalizations of one thing: this lowercased, and the
   * lookup also folded the dots and +tags that Gmail treats as one mailbox. No
   * bug had surfaced from the gap yet — login codes are keyed on a candidate
   * id, not on an address, which is what hid it — but "the same address" meant
   * two different things in two files, and the next person to improve one of
   * them would have found out the hard way.
   *
   * The code is still sent to the address as typed; only the key it is filed
   * under is folded. So two spellings of one inbox cannot hold two live codes,
   * and a proof for either covers both — which is right, because whoever read
   * the code controls the mailbox both spellings reach.
   */
  if (channel === 'email') return emailKey(text)
  /*
   * null, not '', when the number cannot be keyed.
   *
   * Every unkeyable value used to collapse to the same empty string, which made
   * them one destination: a code proved against "03-123456" satisfied a check
   * for "7654321", and for "abcdefg". One proof for every malformed number is
   * not a verification. Callers treat null as "cannot be verified", which is
   * the honest answer.
   */
  return phoneKey(text)
}

function hashCode(code, secret) {
  return crypto.createHmac('sha256', secret).update(String(code)).digest('hex')
}

export function generateCode() {
  // Six digits, uniformly distributed — `crypto.randomInt` rather than
  // Math.random, because this is a credential however short-lived it is.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * Issues a code for one destination, invalidating any earlier one.
 *
 * Requesting a second code has to retire the first, or a resend leaves two
 * valid codes alive and doubles the guessing surface for the attempt counter.
 */
export function issueVerificationCode({ channel, destination, code, secret }) {
  const key = normalizeDestination(channel, destination)
  /* Nothing to send a code to. Refused here rather than filed under the empty
     string, which is where every unkeyable number used to end up together. */
  if (!key) throw new Error('That destination cannot be verified.')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000)

  db.prepare(`
    UPDATE signup_codes SET consumed_at = ?
    WHERE channel = ? AND destination = ? AND consumed_at IS NULL
  `).run(now.toISOString(), channel, key)

  db.prepare(`
    INSERT INTO signup_codes (channel, destination, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(channel, key, hashCode(code, secret), expiresAt.toISOString(), now.toISOString())

  return { expiresInMinutes: CODE_TTL_MINUTES }
}

/**
 * Returns `{ ok: true }`, or a reason the caller can turn into a message.
 * Attempts are counted so a six-digit code cannot be walked through.
 */
export function redeemVerificationCode({ channel, destination, code, secret }) {
  const key = normalizeDestination(channel, destination)
  if (!key) return { ok: false, reason: 'not-found' }

  const row = db.prepare(`
    SELECT * FROM signup_codes
    WHERE channel = ? AND destination = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(channel, key)

  if (!row) return { ok: false, reason: 'no-code' }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'too-many-attempts' }

  if (row.code_hash !== hashCode(code, secret)) {
    db.prepare(`UPDATE signup_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id)
    return { ok: false, reason: 'mismatch', remaining: MAX_CODE_ATTEMPTS - row.attempts - 1 }
  }

  db.prepare(`UPDATE signup_codes SET consumed_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), row.id)

  return { ok: true }
}

/** Deletes codes nobody is going to use again. Called opportunistically. */
export function sweepVerificationCodes() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  db.prepare(`DELETE FROM signup_codes WHERE created_at < ?`).run(cutoff)
}

// -------------------------------------------------------------- proofs ---

/**
 * A signed, self-contained "this destination was verified" note.
 *
 * `channel.destination.expiry.signature`, where the signature covers the other
 * three. Stateless on purpose: the alternative is a server-side session for
 * every half-finished sign-up form, which is a lot of bookkeeping for a fact
 * that stops mattering the moment the form is submitted.
 */
export function mintProof({ channel, destination, secret }) {
  const key = normalizeDestination(channel, destination)
  if (!key) throw new Error('That destination cannot be verified.')
  const expiresAt = Date.now() + PROOF_TTL_MINUTES * 60 * 1000
  const body = `${channel}.${Buffer.from(key).toString('base64url')}.${expiresAt}`
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`
}

/**
 * Reads a proof back, or returns null if it is missing, malformed, expired or
 * not one of ours. Compared in constant time so a forged signature cannot be
 * tuned byte by byte against the response.
 */
export function readProof(proof, secret) {
  const parts = String(proof ?? '').split('.')
  if (parts.length !== 4) return null

  const [channel, encoded, expiresAt, signature] = parts
  const body = `${channel}.${encoded}.${expiresAt}`
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url')

  const given = Buffer.from(signature)
  const want = Buffer.from(expected)
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null
  if (!Number(expiresAt) || Number(expiresAt) <= Date.now()) return null

  return { channel, destination: Buffer.from(encoded, 'base64url').toString() }
}

/**
 * The check a sign-up route makes: that this proof is valid AND that it is for
 * the address being registered. Without the second half a proof for any address
 * would let somebody register any other.
 */
export function proofCovers({ proof, channel, destination, secret }) {
  const read = readProof(proof, secret)
  if (!read || read.channel !== channel) return false

  /* An unkeyable destination is covered by no proof. Without this the null
     would have to equal the proof's key to pass, which it never does — but
     saying so is cheaper than reasoning about it at each call site. */
  const key = normalizeDestination(channel, destination)
  if (!key) return false

  return read.destination === key
}
