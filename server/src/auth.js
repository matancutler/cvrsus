import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)
const KEY_LENGTH = 64

/**
 * The token is `<role>:<id>:<expiry>[:<sid>].<hmac>`, so a candidate token can
 * never be used on a recruiter route and vice versa.
 *
 * The signature alone makes a token self-validating — nothing has to be looked
 * up, and nothing can be taken back. That is the right trade for a candidate,
 * whose session is only ever their own. It is the wrong one for a seat that a
 * company pays for: "signed in on one device at a time" is a claim about how
 * many sessions exist, and a server that keeps no record of them cannot make
 * it. So a recruiter token also carries `sid`, an opaque id naming *this*
 * sign-in, which the caller checks against the one the account currently holds.
 * Issuing a new one is what makes the old device's token stop working.
 *
 * The field is optional and last, so a token without it verifies exactly as
 * before — candidates are unaffected by any of this.
 */
export function issueToken(secret, { role, id, sid }, hours) {
  const expiresAt = Date.now() + hours * 60 * 60 * 1000
  const payload = `${role}:${id}:${expiresAt}${sid ? `:${sid}` : ''}`
  return `${payload}.${sign(payload, secret)}`
}

/** A name for one sign-in. Random, so it says nothing about the account. */
export function newSessionId() {
  return crypto.randomBytes(16).toString('hex')
}

export function readToken(token, secret) {
  if (typeof token !== 'string') return null

  const dot = token.lastIndexOf('.')
  if (dot < 1) return null

  const payload = token.slice(0, dot)
  if (!constantTimeEqual(token.slice(dot + 1), sign(payload, secret))) return null

  const [role, rawId, rawExpiry, sid] = payload.split(':')
  const id = Number(rawId)
  const expiresAt = Number(rawExpiry)

  if (!role || !Number.isInteger(id) || !Number.isFinite(expiresAt)) return null
  if (expiresAt <= Date.now()) return null

  return { role, id, sid: sid || null }
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

/** Compares without leaking length or content through timing. */
export function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8')
  const bufB = Buffer.from(String(b), 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// ------------------------------------------------------------------ CSRF ---

export const CSRF_COOKIE = 'cvrsus_csrf'
export const CSRF_HEADER = 'x-csrf-token'

/**
 * Double-submit CSRF protection.
 *
 * Cookies are attached by the browser automatically, which is exactly what
 * makes them convenient and exactly what makes cross-site request forgery
 * possible: a form on another site can aim a POST at us and the session rides
 * along. SameSite=Lax already blocks that for cross-site POST, but it is one
 * browser behaviour standing between an attacker and a state change, so this
 * adds a second, independent check.
 *
 * The token is readable by our own script and echoed in a header. Another
 * origin can cause the request but cannot read our cookie to set the header,
 * and cannot set that header cross-origin without a CORS preflight we do not
 * grant. Note this defends against *other sites*, not against XSS on our own —
 * script running here can read the token like any other page code.
 */
export function issueCsrfToken(res, req) {
  const existing = parseCookies(req)[CSRF_COOKIE]
  if (existing && existing.length >= 32) return existing

  const token = crypto.randomBytes(32).toString('hex')
  const attributes = ['Path=/', 'SameSite=Lax', 'Max-Age=86400']
  if (process.env.COOKIE_SECURE === 'true' || req.secure || req.get('x-forwarded-proto') === 'https') {
    attributes.push('Secure')
  }
  append(res, `${CSRF_COOKIE}=${token}; ${attributes.join('; ')}`)
  return token
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Rejects a state-changing request whose CSRF header does not match its cookie.
 *
 * Only applies when the request is authenticated *by cookie*. A Bearer-token
 * caller is a script that attached the credential deliberately — there is no
 * ambient authority to forge, so demanding a CSRF token from it would break
 * every API client to protect against nothing.
 */
export function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next()

  const cookies = parseCookies(req)
  const usesCookieAuth = Object.values(SESSION_COOKIES).some((name) => cookies[name])
  if (!usesCookieAuth) return next()

  const sent = req.get(CSRF_HEADER) ?? ''
  const expected = cookies[CSRF_COOKIE] ?? ''

  if (!expected || !sent || !constantTimeEqual(sent, expected)) {
    return res.status(403).json({
      error: 'That request could not be verified. Reload the page and try again.',
    })
  }

  return next()
}

// ------------------------------------------------------------- passwords ---

/** scrypt via node:crypto — no external hashing dependency needed. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt, KEY_LENGTH)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored ?? '').split('$')
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false

  const expected = Buffer.from(keyHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

// ------------------------------------------------------- one-time codes ---

/** Six digits, uniformly distributed, leading zeros preserved. */
export function generateLoginCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Codes are stored hashed, so the database never holds a usable credential. */
export function hashLoginCode(code, secret) {
  return crypto.createHmac('sha256', secret).update(String(code)).digest('hex')
}

// ------------------------------------------------------------ middleware ---

/**
 * Express middleware factory. Reads the session behind the request and refuses
 * it if there isn't one.
 *
 * `isCurrent` is optional and is how a role adds a second question to the
 * signature check: not "is this token genuine" but "is this still the session
 * the account is on". It takes the decoded session and answers a reason string
 * when the token should be refused, or null to allow it. auth.js knows nothing
 * about the database and should not — the caller supplies the lookup.
 */
export function requireRole(secret, role, isCurrent = null) {
  return (req, res, next) => {
    const session = readSession(secret, role, req)
    if (!session) {
      return res.status(401).json({ error: 'Not signed in, or the session expired.' })
    }

    const stale = isCurrent?.(session) ?? null
    if (stale) {
      /*
       * Clear the cookies on the way out. Otherwise the browser keeps sending a
       * token that will never be accepted again, and the app sits on a signed-in
       * shell that 401s on everything — the session is over, so the page should
       * look like it.
       */
      clearSessionCookies(res, req)
      return res.status(401).json({ error: stale, reason: 'session-superseded' })
    }

    req.session = session
    next()
  }
}

/**
 * The same token check without the rejection, for routes that serve both signed
 * in and anonymous callers — a form that works before the account exists and
 * again afterwards. Returns null rather than responding, so the caller decides
 * what a missing session means.
 */
// --------------------------------------------------------------- cookies ---

/**
 * Session cookies, one per role.
 *
 * The token used to live in localStorage, where any script on the page could
 * read it — one XSS and an attacker walks away with a session they can replay
 * from anywhere, for as long as it lasts. An httpOnly cookie cannot be read by
 * script at all. XSS can still *use* the session while the victim is on the
 * page, but it can no longer take it away, which is the difference between an
 * incident and a breach.
 */
export const SESSION_COOKIES = {
  candidate: 'cvrsus_candidate',
  recruiter: 'cvrsus_recruiter',
}

/**
 * A readable flag saying a session exists — never the token itself.
 *
 * The UI has to know which shell to render before it has spoken to the server,
 * and it cannot read an httpOnly cookie. This carries no credential: forging it
 * gets you a signed-in-looking page whose every request still returns 401.
 */
export const SESSION_HINT = 'cvrsus_session'

/** Minimal cookie header parser — one header, no dependency. */
export function parseCookies(req) {
  const jar = {}
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      jar[name] = part.slice(eq + 1).trim()
    }
  }
  return jar
}

/**
 * Whether the connection is HTTPS.
 *
 * `Secure` on a cookie means the browser will not send it over plain HTTP — so
 * setting it unconditionally silently breaks local development, and never
 * setting it silently weakens production. Deciding per request gets both right,
 * and the proxy header is honoured only when the app has been told to trust it.
 */
function isSecure(req) {
  if (process.env.COOKIE_SECURE === 'true') return true
  if (process.env.COOKIE_SECURE === 'false') return false
  return Boolean(req.secure) || req.get('x-forwarded-proto') === 'https'
}

function cookieAttributes(req, maxAgeSeconds) {
  return [
    'Path=/',
    'HttpOnly',
    /*
     * Lax, not Strict. Strict would drop the session on any link arriving from
     * another site — including the check-in and message emails this product
     * sends — so a candidate clicking through would land signed out. Lax still
     * withholds the cookie from cross-site POST, which is the CSRF case.
     */
    'SameSite=Lax',
    ...(isSecure(req) ? ['Secure'] : []),
    `Max-Age=${maxAgeSeconds}`,
  ]
}

function append(res, value) {
  const existing = res.getHeader('Set-Cookie')
  const list = existing ? [].concat(existing) : []
  res.setHeader('Set-Cookie', [...list, value])
}

export function setSessionCookie(res, req, { role, token, hours }) {
  const maxAge = Math.round(hours * 60 * 60)
  append(res, `${SESSION_COOKIES[role]}=${encodeURIComponent(token)}; ${cookieAttributes(req, maxAge).join('; ')}`)

  // The hint is deliberately readable, so it omits HttpOnly.
  const hint = cookieAttributes(req, maxAge).filter((a) => a !== 'HttpOnly')
  append(res, `${SESSION_HINT}=${role}; ${hint.join('; ')}`)
}

export function clearSessionCookies(res, req) {
  const expired = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(isSecure(req) ? ['Secure'] : []), 'Max-Age=0']
  for (const name of Object.values(SESSION_COOKIES)) append(res, `${name}=; ${expired.join('; ')}`)
  append(res, `${SESSION_HINT}=; ${expired.filter((a) => a !== 'HttpOnly').join('; ')}`)
}

/**
 * The session behind a request.
 *
 * Cookie first, then a Bearer header for scripts and API clients. The old
 * `?token=` query parameter is gone: a credential in a URL ends up in browser
 * history, server logs and the Referer header sent to whatever the page links
 * to next, which is three copies of a session nobody meant to make.
 */
export function readSession(secret, role, req) {
  const cookies = parseCookies(req)
  const fromCookie = cookies[SESSION_COOKIES[role]] ?? null

  const header = req.get('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null

  const session = readToken(fromCookie ?? bearer, secret)
  return session && session.role === role ? session : null
}
