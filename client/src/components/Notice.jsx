import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One notice, and the rules every notice on this site follows.
 *
 * There were two kinds of message on screen and no distinction drawn between
 * them, so they behaved the same way: they appeared, they stacked on top of one
 * another, and they stayed for ever. A candidate who saved their profile twice
 * ended up reading "Your profile is live" and "Your details have been updated"
 * one under the other, neither of which was news by then.
 *
 * The two kinds are:
 *
 *   TRANSIENT — the outcome of something the reader just did. It is news for a
 *     moment and clutter afterwards, so it clears itself after thirty seconds,
 *     and a second one REPLACES the first rather than pushing it down the page.
 *     There is only ever one, in one place, and it is always the latest thing
 *     that happened.
 *
 *   PERSISTENT — a standing fact about the account: no reveals left, a
 *     subscription about to change. It is true until the fact changes, so it
 *     does not time out. It appears when the fact becomes true, and once the
 *     reader has dismissed it they are not told again until it becomes true
 *     afresh.
 *
 * Both carry a close control, because a message the reader cannot get rid of is
 * a message they learn to read past.
 */

/** Thirty seconds, said once. */
export const NOTICE_MS = 30_000

const TONES = { ok: 'alert-ok', error: 'alert-error', warn: 'alert-warn', muted: 'alert-muted' }

export default function Notice({
  tone = 'ok',
  onDismiss,
  className = '',
  children,
  /* Announced to a screen reader as it arrives. An error interrupts; a
     confirmation waits for a pause, which is the difference between 'assertive'
     and 'polite' and the reason this is not one value for both. */
  live = tone === 'error' ? 'assertive' : 'polite',
}) {
  return (
    <div
      className={`alert ${TONES[tone] ?? TONES.ok} notice ${className}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={live}
    >
      <div className="notice-body">{children}</div>

      {onDismiss && (
        <button
          type="button"
          className="notice-close"
          onClick={onDismiss}
          aria-label="Dismiss this message"
          title="Dismiss"
        >
          &times;
        </button>
      )}
    </div>
  )
}

/**
 * A screen's single status line: whatever just happened, and nothing else.
 *
 * Almost every panel in the product held two pieces of state, `error` and
 * `notice`, and rendered them as two adjacent paragraphs. Both could be set at
 * once — save fails, fix it, save again — and the reader was left with a red
 * line and a green line stacked, one of which was no longer true.
 *
 * This renders at most one. The error wins when both are set, because a failure
 * is the thing that still needs acting on. It clears itself after thirty
 * seconds, and it carries a cross.
 *
 * The timer is keyed on the MESSAGE, not on the dismiss callback: callers write
 * that inline, so it is a new function on every render, and depending on it
 * would restart the countdown every time anything else on the page changed —
 * which is a timer that never fires.
 */
export function StatusNotice({ error = '', notice = '', onDismiss, className = '', ms = NOTICE_MS }) {
  const shown = error || notice
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    if (!shown) return undefined
    const timer = setTimeout(() => dismiss.current?.(), ms)
    return () => clearTimeout(timer)
  }, [shown, ms])

  if (!shown) return null

  return (
    <Notice
      tone={error ? 'error' : 'ok'}
      className={className}
      onDismiss={onDismiss ? () => dismiss.current?.() : undefined}
    >
      {shown}
    </Notice>
  )
}

/**
 * The one transient notice a screen is allowed.
 *
 * Returns the current notice, a setter, and a clear. Setting a new one while
 * another is showing replaces it and restarts the clock — which is the whole
 * point: two consecutive saves should read as one confirmation of the second,
 * not as a growing list of things that went right.
 *
 * The timer is keyed on the notice's identity rather than on its text, so
 * saving twice with the same message still resets the thirty seconds instead of
 * letting the first timer clear the second message early.
 */
export function useNotice() {
  const [notice, setState] = useState(null)
  const timer = useRef(null)
  const seq = useRef(0)

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setState(null)
  }, [])

  const show = useCallback((next) => {
    if (timer.current) clearTimeout(timer.current)

    if (!next || !next.message) {
      timer.current = null
      setState(null)
      return
    }

    seq.current += 1
    setState({ tone: 'ok', ...next, id: seq.current })
    timer.current = setTimeout(() => {
      timer.current = null
      setState(null)
    }, next.ms ?? NOTICE_MS)
  }, [])

  // A timer that outlives its component sets state on nothing at all.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return [notice, show, clear]
}

/**
 * A standing fact, and whether this reader has already waved it away.
 *
 * `key` identifies the fact and `fact` is whether it is currently true. A
 * dismissal lasts until the fact stops being true; when it becomes true again
 * that is news, and the banner speaks again.
 *
 * The second argument exists because the first one could not do the job alone.
 * Callers used to put the changing part INTO the key — `triage-${balance}` —
 * on the reasoning that a different balance is a different fact. But every
 * banner using it returns null unless the balance is zero, so the only key ever
 * written was `triage-0`: running out, buying a pack and running out again
 * produced the same key, found the old dismissal, and stayed silent. The
 * banners are now the only thing that says the product has stopped, so staying
 * silent is the whole failure rather than a cosmetic one.
 *
 * Kept in sessionStorage rather than in state, so moving between tabs of the
 * workspace does not bring back a banner that was just dismissed, and rather
 * than localStorage, so it is not silenced permanently on one machine.
 */
export function useStandingNotice(key, fact = true) {
  const [dismissed, setDismissed] = useState(() => fact && read(key))

  useEffect(() => {
    if (!fact) {
      /* Spent. The dismissal was granted against a fact that has since gone
         away, so it does not carry over to the next time it comes back. */
      try { window.sessionStorage.removeItem(storageKey(key)) } catch { /* private mode */ }
      setDismissed(false)
      return
    }
    setDismissed(read(key))
  }, [key, fact])

  const dismiss = useCallback(() => {
    setDismissed(true)
    try { window.sessionStorage.setItem(storageKey(key), '1') } catch { /* private mode */ }
  }, [key])

  return [!dismissed, dismiss]
}

const STORAGE_PREFIX = 'cursus.notice.'

const storageKey = (key) => `${STORAGE_PREFIX}${key}`

/**
 * Forgets every dismissal. Called when a session ends.
 *
 * "Dismissed for this session" was only half true. sessionStorage outlives a
 * sign-out here, because signing out is a state change rather than a page load
 * — nothing reloads, so the tab and its storage carry on. Somebody who waved
 * away "no reveals remaining", signed out and signed back in got a workspace
 * that had quietly stopped mentioning it, and the fact was still true.
 *
 * Clearing on the way out rather than on the way in, because signing out is the
 * moment we know a session ended; a sign-in cannot tell whether it is the same
 * person returning or a colleague on a shared machine, and the answer should be
 * the same either way.
 */
export function clearStandingNotices() {
  try {
    const { sessionStorage } = window
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key)
    }
  } catch { /* private mode */ }
}

function read(key) {
  if (!key) return false
  try { return window.sessionStorage.getItem(storageKey(key)) === '1' } catch { return false }
}
