/**
 * What your team calls a candidate.
 *
 * Free text, up to five, in a colour of your choosing — "phone screened",
 * "wants remote", "hold for Q4". Not the taxonomy labels on the candidate's own
 * profile: those are a fixed vocabulary because they are matched against, and
 * these are matched against nothing. They are a note in the margin, and a
 * margin with a dropdown is not a margin.
 *
 * Two halves that live in different places on the card, so this exports both
 * rather than drawing one box: the strip of tags sits beside the score, and the
 * + that edits them sits with the other actions in the corner.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import portalHost from '../portalHost.js'

import { get, put } from '../api.js'
import { StatusNotice } from './Notice.jsx'

const MAX = 5
const COLOURS = ['grey', 'red', 'amber', 'green', 'blue', 'purple']

/**
 * The strip. Nothing at all when there are no tags — an empty box is furniture.
 *
 * `limit` because this lives in a narrow column beside a score: five tags is
 * five lines on a list row, and a row whose height depends on how much somebody
 * has annotated it is a list that jumps about.
 *
 * One at a time on a row, because the column holds about a hundred pixels and
 * two tags in it are two five-letter stumps — "Phone…" and "Want…" say less
 * than one whole tag and a count does. What is held back is named in the title
 * and shown in full in the panel, which is one press away.
 */
export function TagStrip({ tags, limit = 1 }) {
  if (!tags || tags.length === 0) return null

  const shown = tags.slice(0, limit)
  const rest = tags.slice(limit)

  return (
    <span className="tag-strip">
      {shown.map((tag) => (
        /* Titled as well: a long tag still truncates in a narrow column, and
           the whole of it should never be more than a hover away. */
        <span key={tag.label} className={`tag tag-${tag.colour}`} title={tag.label}>
          {tag.label}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="tag tag-grey tag-more" title={rest.map((tag) => tag.label).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  )
}

/**
 * The + beside the comments, and the panel it opens.
 *
 * The panel opens with every tag already in it, because the common act is
 * changing what is there rather than starting from nothing. Reading it is the
 * default and editing is a pencil away: crosses that are always live are
 * crosses that get pressed by accident on a list you are scrolling.
 */
export default function TagEditor({ candidateId, tags, onChange, label = 'Tags' }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState([])
  const [text, setText] = useState('')
  const [colour, setColour] = useState('grey')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [box, setBox] = useState(null)

  const button = useRef(null)
  const panel = useRef(null)

  const place = useCallback(() => {
    const trigger = button.current?.getBoundingClientRect()
    if (!trigger) return

    const height = panel.current?.offsetHeight ?? 0
    const width = panel.current?.offsetWidth ?? 260
    const GAP = 6
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

  useLayoutEffect(() => { if (open) place() }, [open, place, draft, editing, error])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      /* This panel, not the dialog behind it. */
      event.stopPropagation()
      setOpen(false)
    }
    const away = (event) => {
      if (!panel.current?.contains(event.target) && !button.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    /* Named so removeEventListener can find it again, and deaf to scrolling
       inside the panel itself. */
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
    setEditing(false)
    setError('')
    /*
     * Drawn from what the row already knows, then corrected by the server.
     *
     * The draft started empty and waited for the fetch, so opening the editor
     * on a candidate with four tags showed "No tags yet" for as long as the
     * round trip took — the panel telling you the opposite of what the strip
     * two centimetres away was showing. The row's copy is nearly always right
     * and is right instantly; the fetch below is what covers the case it is
     * wrong about, which is a colleague having added one since this row was
     * drawn.
     */
    setDraft(tags ?? [])
    get(`/api/hr/candidates/${candidateId}/tags`, 'recruiter')
      .then((data) => { setDraft(data.tags); onChange?.(data.tags) })
      .catch((err) => setError(err.message))
  }, [open, candidateId]) // eslint-disable-line react-hooks/exhaustive-deps

  function add(event) {
    event?.preventDefault()
    const wanted = text.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!wanted) return
    if (draft.length >= MAX) return
    if (draft.some((tag) => tag.label.toLowerCase() === wanted.toLowerCase())) {
      setError('That tag is already on them.')
      return
    }
    setDraft([...draft, { label: wanted, colour }])
    setText('')
    setError('')
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const data = await put(`/api/hr/candidates/${candidateId}/tags`, { tags: draft }, 'recruiter')
      setDraft(data.tags)
      onChange?.(data.tags)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const full = draft.length >= MAX

  return (
    <span className="tag-anchor">
      <button
        ref={button}
        type="button"
        className={`icon-button tag-toggle${open ? ' tag-toggle-on' : ''}`}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={(event) => { event.stopPropagation(); setOpen((was) => !was) }}
      >
        +
      </button>

      {open && createPortal(
        <div
          ref={panel}
          className="tag-panel"
          role="dialog"
          aria-label={label}
          style={box ? { left: box.left, top: box.top } : { opacity: 0, pointerEvents: 'none' }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="tag-panel-head">
            <h4>Tags</h4>
            {/* One control that changes what it does: a pencil to start, a tick
                to finish. There is nothing to cancel — the tick is what writes,
                and closing without it leaves the stored set alone. */}
            <button
              type="button"
              className="icon-button"
              disabled={saving}
              aria-label={editing ? 'Save these tags' : 'Edit these tags'}
              title={editing ? 'Save' : 'Edit'}
              onClick={() => (editing ? save() : setEditing(true))}
            >
              {editing ? <TickIcon /> : <PencilIcon />}
            </button>
          </div>

          <div className="chip-row tag-row">
            {draft.length === 0 && !editing && (
              <span className="muted tag-empty">No tags yet. The pencil adds one.</span>
            )}

            {draft.map((tag) => (
              <span
                key={tag.label}
                className={`tag tag-${tag.colour}${editing ? ' tag-editing' : ''}`}
                role={editing ? 'button' : undefined}
                tabIndex={editing ? 0 : undefined}
                title={editing ? `Paint ${tag.label} ${colour}` : undefined}
                onClick={editing
                  ? () => setDraft(draft.map((t) => (t.label === tag.label ? { ...t, colour } : t)))
                  : undefined}
                onKeyDown={editing
                  ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setDraft(draft.map((t) => (t.label === tag.label ? { ...t, colour } : t)))
                    }
                  }
                  : undefined}
              >
                {tag.label}
                {editing && (
                  <button
                    type="button"
                    className="chip-x"
                    aria-label={`Remove ${tag.label}`}
                    /* The chip around it is itself a key-activated control (it
                       paints), so a keyboard press here has to stop there as
                       well as on click — otherwise Enter on Remove removed the
                       tag and recoloured it in the same breath. */
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      setDraft(draft.filter((t) => t.label !== tag.label))
                    }}
                  >
                    &times;
                  </button>
                )}
              </span>
            ))}
          </div>

          {editing && (
            <>
              {/* The colour is chosen first and applies to what you do next:
                  the tag you type, or any tag you press. One rule, said once. */}
              <div className="tag-colours" role="group" aria-label="Tag colour">
                {COLOURS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`tag-swatch tag-${name}${colour === name ? ' tag-swatch-on' : ''}`}
                    aria-label={name}
                    aria-pressed={colour === name}
                    title={name}
                    onClick={() => setColour(name)}
                  />
                ))}
              </div>

              {full ? (
                <p className="muted tag-limit">{MAX} is the maximum.</p>
              ) : (
                <form className="tag-add" onSubmit={add}>
                  <input
                    autoFocus
                    value={text}
                    maxLength={40}
                    placeholder="e.g. Phone screened"
                    aria-label="New tag"
                    onChange={(event) => { setText(event.target.value); setError('') }}
                  />
                  <button
                    type="submit"
                    className="btn btn-secondary btn-small"
                    disabled={!text.trim()}
                  >
                    Add
                  </button>
                </form>
              )}

              <p className="field-hint tag-hint">
                Pick a colour, then type a tag or press one to recolour it. Nothing is stored
                until you press the tick.
              </p>
            </>
          )}

          <StatusNotice error={error} onDismiss={() => setError('')} />
        </div>,
        portalHost(button.current),
      )}
    </span>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" />
      <path d="M14.5 7.5 16.5 9.5" />
    </svg>
  )
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="m5 13 4.5 4.5L19 7" />
    </svg>
  )
}
