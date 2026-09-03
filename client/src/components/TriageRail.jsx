import { useCallback, useRef, useState } from 'react'

import { bucketOf, ORDER, railSlice } from '../rail.js'
import useDismissOnOutside from '../useDismiss.js'

/**
 * The company's Triages, in the rail, the way searches are listed beside them.
 *
 * Two things make this list different from the search list above it, and both
 * are deliberate rather than incidental:
 *
 * It is the COMPANY's, not yours. A Triage belongs to the organization — every
 * approved recruiter can open, edit and delete one — while a search is private
 * to whoever ran it (server/src/triage.js:20 against server/src/chats.js:81).
 * That asymmetry is real and a rail that hid it would be lying, so rows say
 * whose they are when they are not yours, and the caption above says it once
 * in words.
 *
 * It is bucketed on when it was CREATED, not when it was last touched. The
 * search list uses updated_at, which for a search means "when you last ran it"
 * — a fact about the recruiter. For a Triage updated_at is a fact about the
 * SERVER: the background worker writes it three times per tranche of 25 CVs,
 * so a colleague's 300-CV run would drag their Triage to the top of your rail
 * a dozen times while it processed, and rows would move under the cursor.
 */
export default function TriageRail({
  triages, activeId, onOpen, onRename, onDelete, meId,
}) {
  /* Which row has its menu open. One at a time, and held here rather than in
     the row so opening a second closes the first. */
  const [menuFor, setMenuFor] = useState(null)

  /* Same as the search rail above it: a press outside the open menu shuts it. */
  const openMenu = useRef(null)
  const openTrigger = useRef(null)
  useDismissOnOutside({
    ref: openMenu,
    trigger: openTrigger,
    onDismiss: useCallback(() => setMenuFor(null), []),
    active: menuFor !== null,
  })

  if (!triages) {
    return <p className="ws-rail-empty muted">Loading…</p>
  }

  if (!triages.length) {
    return (
      <p className="ws-rail-empty muted">
        No Triages yet. Start one from + New to sort CVs you already have.
      </p>
    )
  }

  const shown = railSlice(triages, (triage) => triage.createdAt)
  const groups = new Map()

  for (const triage of shown) {
    const bucket = bucketOf(triage.createdAt)
    if (!groups.has(bucket)) groups.set(bucket, [])
    groups.get(bucket).push(triage)
  }

  return (
    <div className="chat-list">
      {ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => (
        <section key={bucket}>
          <h4 className="chat-group">{bucket}</h4>
          <ul>
            {groups.get(bucket).map((triage) => (
              <li
                key={triage.id}
                className={triage.id === activeId ? 'chat-item chat-item-active' : 'chat-item'}
              >
                <button
                  type="button"
                  className="chat-item-open"
                  onClick={() => onOpen(triage.id)}
                  title={triage.author ? `Started by ${triage.author}` : undefined}
                >
                  <span className="chat-item-title">
                    {triage.title?.trim() || 'Untitled Triage'}
                  </span>
                  {/*
                    Whose it is, when it is not yours.
                    
                    Silent for your own, because a list in which every row says
                    "you" is a list that says nothing. A name appears exactly
                    when it changes what the row means.
                  */}
                  {triage.recruiterId !== meId && (
                    <span className="chat-item-author">{triage.author ?? 'A colleague'}</span>
                  )}
                </button>

                {/*
                  The same ⋯ the search rail carries, doing the same two things.

                  A Triage could be started and opened but never renamed or
                  thrown away — the dashboard that used to offer both was
                  deleted, and nothing took the jobs over. Which left the
                  untitled ones untitled for good: the job title is set while
                  building, and once a Triage was launched there was no way
                  back to that field.

                  It says "Rename" rather than "Rename Triage" because the
                  prompt above it already names the thing. The delete warns
                  that the CVs go with it, which is the difference from a
                  search: a search is a question about candidates who exist
                  elsewhere, a Triage IS the pile of files.
                */}
                {(onRename || onDelete) && (
                  <button
                    type="button"
                    className="chat-item-menu"
                    ref={menuFor === triage.id ? openTrigger : null}
                    aria-label={`Options for ${triage.title?.trim() || 'this Triage'}`}
                    onClick={() => setMenuFor(menuFor === triage.id ? null : triage.id)}
                  >
                    ⋯
                  </button>
                )}

                {menuFor === triage.id && (
                  <div className="chat-item-actions" ref={openMenu}>
                    {onRename && (
                      <button
                        type="button"
                        onClick={() => {
                          const current = triage.title?.trim() ?? ''
                          const next = prompt('Job title', current)
                          setMenuFor(null)
                          if (next && next.trim() && next.trim() !== current) {
                            onRename(triage.id, next.trim())
                          }
                        }}
                      >
                        Rename
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        className="chat-item-delete"
                        onClick={() => {
                          setMenuFor(null)
                          const name = triage.title?.trim() || 'this Triage'
                          if (confirm(`Delete “${name}”? Every CV uploaded to it is deleted too.`)) {
                            onDelete(triage.id)
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                )}

                {/* What it holds, in the same pill the search list uses for the
                    number of candidates saved out of one. */}
                {triage.counts?.total > 0 && (
                  <span className="chat-item-count" title={`${triage.counts.total} CVs`}>
                    {triage.counts.total}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
