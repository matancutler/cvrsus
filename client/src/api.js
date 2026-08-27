/**
 * The browser no longer holds a session token.
 *
 * Sessions live in httpOnly cookies the server sets, which script cannot read —
 * so an XSS on this page can no longer walk off with a credential and replay it
 * elsewhere, which is what storing the token in localStorage allowed. The cost
 * is that cookies travel automatically, so every unsafe request now carries a
 * CSRF token proving it came from our own page.
 */

/** A readable flag the server sets alongside the session. Never a credential. */
import { clearStandingNotices } from './components/Notice.jsx'

const HINT_COOKIE = 'cvrsus_session'
const CSRF_COOKIE = 'cvrsus_csrf'
const CSRF_HEADER = 'X-CSRF-Token'

function readCookie(name) {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return null
}

/**
 * Whether a session of this role appears to exist.
 *
 * A hint only — it decides which shell to render before the first request
 * returns. Forging it produces a signed-in-looking page whose every call still
 * comes back 401, because the real credential is the cookie script cannot read.
 */
export function hasSession(role) {
  return readCookie(HINT_COOKIE) === role
}

/**
 * Kept so existing call sites read naturally. It answers "is there a session",
 * not "give me the token" — there is no token here to give.
 */
export const getToken = hasSession

/** Thrown for any non-2xx response, carrying the server's message. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * The event fired when the server says this session has been taken over.
 *
 * A recruiter account is signed in on one device at a time, so a sign-in
 * somewhere else ends this one — and the first anything here hears about it is
 * a 401 on whatever request happened to be next. Announced centrally rather
 * than handled at each call site: it can arrive during any request, including
 * background polling nobody is watching, and every one of them should end at
 * the same place.
 */
export const SESSION_ENDED = 'cvrsus:session-ended'

async function parse(response) {
  const body = await response.json().catch(() => ({}))

  if (response.status === 401 && body.reason === 'session-superseded') {
    /* A session ended here too, and the banners waved away during it go with
       it. This path never touches signOut() — the server has already ended the
       session and there is nothing to ask it to do — so the clearing has to be
       here as well or a forced sign-out leaves the next person's warnings
       silenced. */
    clearStandingNotices()
    window.dispatchEvent(new CustomEvent(SESSION_ENDED, { detail: body.error }))
  }

  if (!response.ok) throw new ApiError(response.status, body.error || `Request failed (${response.status})`)
  return body
}

/** Every request: send our cookies, and prove unsafe ones came from this page. */
function options({ method = 'GET', headers = {}, body } = {}) {
  const csrf = readCookie(CSRF_COOKIE)
  return {
    method,
    credentials: 'same-origin',
    headers: {
      ...headers,
      ...(csrf && !['GET', 'HEAD'].includes(method) ? { [CSRF_HEADER]: csrf } : {}),
    },
    ...(body === undefined ? {} : { body }),
  }
}

export async function get(path) {
  return parse(await fetch(path, options()))
}

export async function post(path, data) {
  return parse(await fetch(path, options({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })))
}

export async function put(path, data) {
  return parse(await fetch(path, options({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })))
}

export async function patch(path, data) {
  return parse(await fetch(path, options({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })))
}

/** DELETE may carry a body — account deletion sends a typed confirmation. */
export async function del(path, _role, data) {
  return parse(await fetch(path, options({
    method: 'DELETE',
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  })))
}

/** Multipart requests must not set Content-Type — the browser adds the boundary. */
export async function sendForm(path, formData, { method = 'POST' } = {}) {
  return parse(await fetch(path, options({ method, body: formData })))
}

/**
 * Used by <img> and links, which cannot set headers.
 *
 * It appended the session token as a query parameter, putting a live credential
 * into browser history, server logs and the Referer header of whatever the page
 * loaded next. The cookie travels on those requests by itself, so the path is
 * now returned untouched and the server no longer accepts a token in a URL.
 */
export function withToken(path) {
  return path
}

/**
 * Ends the session. Only the server can clear an httpOnly cookie.
 *
 * The banners a person waved away this session go with it. They are kept in
 * sessionStorage, which survives a sign-out on its own — signing out changes
 * state rather than loading a page — so without this a standing warning stayed
 * silenced for whoever signed in next in the same tab.
 */
export async function signOut() {
  await fetch('/api/auth/sign-out', options({ method: 'POST' })).catch(() => {})
  clearStandingNotices()
}

/** Downloads through an authenticated fetch, since <a href> cannot carry one. */
export async function downloadFile(path, fileName) {
  const response = await fetch(path, options())
  if (!response.ok) throw new ApiError(response.status, 'Could not download that file.')

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName ?? 'download'
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
