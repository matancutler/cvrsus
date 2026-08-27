/**
 * What your team has said about one candidate.
 *
 * Not the conversation with the candidate — they never see this. It is the note
 * a colleague leaves so the next person to open the profile knows somebody has
 * already spoken to them, and who.
 *
 * A popover rather than a tab, because it is read beside the row it belongs to:
 * a recruiter scanning ten results wants to know which of them their team has
 * already touched without opening ten profiles. Portalled to the body for the
 * same two reasons PopMenu is — the dock and the result list both clip, and a
 * panel opened from inside a dialog has to sit above it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import portalHost from '../portalHost.js'

import { DATE_LOCALE } from '../dates.js'
import { get, post } from '../api.js'
import { StatusNotice } from './Notice.jsx'

export default function CommentsPopover({ candidateId, label = 'Comments', meId = null }) {
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState(null)
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [box, setBox] = useState(null)

  const button = useRef(null)
  const panel = useRef(null)

  const place = useCallback(() => {
    const trigger = button.current?.getBoundingClientRect()
    if (!trigger) return

    const height = panel.current?.offsetHeight ?? 0
    const width = panel.current?.offsetWidth ?? 280
    const GAP = 6

    /* Below by preference, above when there is no room — the same rule the row
       menus follow, so two panels opened from the same corner behave alike. */
    const roomBelow = window.innerHeight - trigger.bottom
    const above = roomBelow < height + GAP && trigger.top > height + GAP

    /*
     * Clamped to the window, not merely flipped.
     *
     * "Above if there is no room below" answers the wrong question on a short
     * viewport — a phone in landscape, or a laptop with the console open — where
     * there is room in neither direction. The panel then took a negative top and
     * its first comment sat above the top of the screen with no way to scroll to
     * it. The panel also has a max-height now, so this cannot merely move the
     * overflow to the bottom.
     */
    const wanted = above ? trigger.top - height - GAP : trigger.bottom + GAP
    setBox({
      left: Math.max(GAP, Math.min(trigger.right - width, window.innerWidth - width - GAP)),
      top: Math.max(GAP, Math.min(wanted, window.innerHeight - height - GAP)),
    })
  }, [])

  useLayoutEffect(() => { if (open) place() }, [open, place, comments, writing])

  useEffect(() => {
    if (!open) return undefined
    /* Closed by Escape and by scrolling away, but NOT by any click elsewhere:
       there is a textarea in here, and a panel that vanishes when you click
       into your own draft is a panel you cannot type in. */
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      /* This panel, and only this panel. Without stopping it the candidate
         dialog behind also hears the same Escape and both shut at once. */
      event.stopPropagation()
      setOpen(false)
    }
    const away = (event) => { if (!panel.current?.contains(event.target)
      && !button.current?.contains(event.target)) setOpen(false) }
    /* Named, because removeEventListener compares by identity: a second arrow
       function with the same body removes nothing and leaves a listener behind
       that closes the panel on every scroll for the rest of the session.
       Ignores scrolling INSIDE the panel: the comment list has its own
       scrollbar, and reaching the oldest note closed the thing you were
       reading. */
    const close = (event) => {
      if (panel.current?.contains(event.target)) return
      setOpen(false)
    }

    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', away)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', away)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    get(`/api/hr/candidates/${candidateId}/comments`, 'recruiter')
      .then((data) => setComments(data.comments))
      .catch((err) => setError(err.message))
  }, [open, candidateId])

  async function send(event) {
    event?.preventDefault()
    const body = draft.trim()
    if (!body || sending) return

    setSending(true)
    setError('')
    try {
      const data = await post(`/api/hr/candidates/${candidateId}/comments`, { body }, 'recruiter')
      setComments(data.comments)
      setDraft('')
      setWriting(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  const count = comments?.length ?? 0

  return (
    <span className="comments-anchor">
      <button
        ref={button}
        type="button"
        className={`icon-button comments-toggle${open ? ' comments-toggle-on' : ''}`}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={(event) => { event.stopPropagation(); setOpen((was) => !was) }}
      >
        <CommentIcon />
      </button>

      {open && createPortal(
        <div
          ref={panel}
          className="comments-panel"
          role="dialog"
          aria-label={label}
          style={box ? { left: box.left, top: box.top } : { opacity: 0, pointerEvents: 'none' }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="comments-head">
            <h4>Comments{count > 0 ? ` · ${count}` : ''}</h4>
            {/* One control to start a note. It is a + rather than a permanent
                box: the panel is opened to read far more often than to write. */}
            <button
              type="button"
              className="icon-button"
              aria-label={writing ? 'Cancel this comment' : 'Write a comment'}
              title={writing ? 'Cancel' : 'Write a comment'}
              aria-expanded={writing}
              onClick={() => { setWriting((was) => !was); setError('') }}
            >
              {writing ? '×' : '+'}
            </button>
          </div>

          <div className="comments-list">
            {comments === null && <p className="muted">Loading…</p>}
            {comments?.length === 0 && !writing && (
              <p className="muted">Nothing yet. The first note is worth writing.</p>
            )}
            {comments?.map((comment) => (
              <article key={comment.id} className="comment">
                <p className="comment-meta">
                  {/* Your own name read back at you is noise; everybody else's
                      is the point of the note. */}
                  <strong>{comment.recruiterId === meId ? 'me' : comment.author}</strong>
                  <time dateTime={comment.at}>
                    {new Date(comment.at).toLocaleString(DATE_LOCALE, {
                      dateStyle: 'medium', timeStyle: 'short',
                    })}
                  </time>
                </p>
                <p className="comment-body">{comment.body}</p>
              </article>
            ))}
          </div>

          <StatusNotice error={error} onDismiss={() => setError('')} />

          {writing && (
            <form className="comments-compose" onSubmit={send}>
              <textarea
                autoFocus
                rows={2}
                value={draft}
                placeholder="What should your team know?"
                aria-label="Your comment"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Enter posts; Shift+Enter makes a new line — as the composer does.
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
                }}
              />
              <button
                type="submit"
                className="icon-button comments-send"
                disabled={sending || draft.trim() === ''}
                aria-label="Post this comment"
                title="Post"
              >
                <SendIcon />
              </button>
            </form>
          )}
        </div>,
        portalHost(button.current),
      )}
    </span>
  )
}

/** A speech bubble with something written in it. */
export function CommentIcon({ size = 15 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M4 5.5h16v11H9l-4 3.5v-3.5H4Z" />
      <path d="M7.5 9h9M7.5 12.5h6" />
    </svg>
  )
}

/** The paper plane every messaging product sends with. */
export function SendIcon({ size = 16 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M21 3 2 10.5l7.5 3L13 21Z" />
      <path d="M9.5 13.5 21 3" />
    </svg>
  )
}
