import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { DATE_LOCALE } from '../dates.js'
import { ORDER, bucketOf, railSlice } from '../rail.js'
import useDialogFocus from '../useDialogFocus.js'
import useDismissOnOutside from '../useDismiss.js'

/*
 * `bare` drops the frame and the New search button.
 *
 * The recruiter workspace moved this list into its own rail, which already
 * draws the panel and already carries a New search button at the top — so
 * rendering both put two of that button one above the other inside a box in a
 * box. The candidate side has no rail and still wants the whole thing.
 */
export default function ChatSidebar({
  chats, activeId, onNew, onOpen, onRename, onDelete, bare = false,
}) {
  const [menuFor, setMenuFor] = useState(null)

  /* The open row's menu, so a press anywhere else shuts it. Without this a menu
     opened on one search stayed open while you clicked another, and two could
     be on screen at once. */
  const openMenu = useRef(null)
  /* Only ever the ⋯ of the row whose menu is open — it is a sibling of the
     panel, so without it a press on that button would dismiss and then be
     toggled straight back open by its own click. */
  const openTrigger = useRef(null)
  useDismissOnOutside({
    ref: openMenu,
    trigger: openTrigger,
    onDismiss: useCallback(() => setMenuFor(null), []),
    active: menuFor !== null,
  })
  const [browsing, setBrowsing] = useState(false)

  const shown = railSlice(chats)
  const hidden = chats.length - shown.length

  const groups = new Map()
  for (const chat of shown) {
    const bucket = bucketOf(chat.updated_at)
    if (!groups.has(bucket)) groups.set(bucket, [])
    groups.get(bucket).push(chat)
  }

  return (
    <aside className={bare ? 'chat-sidebar chat-sidebar-bare' : 'chat-sidebar'}>
      {!bare && (
        <button type="button" className="chat-new" onClick={onNew}>
          <span aria-hidden="true">＋</span> New search
        </button>
      )}

      {chats.length === 0 ? (
        <p className="muted chat-sidebar-empty">
          Your searches are saved here so you can pick one up again.
        </p>
      ) : (
        <>
          <nav className="chat-list">
            {ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => (
              <section key={bucket}>
                <h4 className="chat-group">{bucket}</h4>
                <ul>
                  {groups.get(bucket).map((chat) => (
                    <li key={chat.id} className={chat.id === activeId ? 'chat-item chat-item-active' : 'chat-item'}>
                      <button
                        type="button"
                        className="chat-item-open"
                        onClick={() => onOpen(chat.id)}
                        title={chat.title}
                      >
                        {/*
                          The title truncates and the count is pinned right, so a
                          saved search reads exactly like Folders and Triage in
                          the same rail. Without the wrapper the count sat wherever
                          the title happened to stop.
                        */}
                        <span className="chat-item-title">{chat.title}</span>
                        {chat.saved > 0 && <span className="chat-item-count">{chat.saved}</span>}
                      </button>

                      <button
                        type="button"
                        className="chat-item-menu"
                        ref={menuFor === chat.id ? openTrigger : null}
                        aria-label={`Options for ${chat.title}`}
                        onClick={() => setMenuFor(menuFor === chat.id ? null : chat.id)}
                      >
                        ⋯
                      </button>

                      {menuFor === chat.id && (
                        <div className="chat-item-actions" ref={openMenu}>
                          <button
                            type="button"
                            onClick={() => {
                              const next = prompt('Rename search', chat.title)
                              setMenuFor(null)
                              if (next && next.trim() && next !== chat.title) onRename(chat.id, next.trim())
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="chat-item-delete"
                            onClick={() => {
                              setMenuFor(null)
                              if (confirm(`Delete "${chat.title}"? The candidates are not affected.`)) {
                                onDelete(chat.id)
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>

          {/* Said only when something is actually being held back — "and 0 more"
              is a control that lies about having a purpose. */}
          {hidden > 0 && (
            <button type="button" className="chat-more" onClick={() => setBrowsing(true)}>
              {hidden} more {hidden === 1 ? 'search' : 'searches'}
            </button>
          )}
        </>
      )}

      {browsing && (
        <AllSearches
          chats={chats}
          activeId={activeId}
          onOpen={(id) => { setBrowsing(false); onOpen(id) }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </aside>
  )
}

/** Opens the full list. Lives beside the rail heading — see HrPanel. */
export function AllSearchesButton({ onClick, count }) {
  return (
    <button
      type="button"
      className="icon-button rail-heading-button"
      aria-label={`All ${count} searches`}
      title="All searches"
      onClick={onClick}
    >
      <span aria-hidden="true">⋯</span>
    </button>
  )
}

/**
 * Every search, with a way to find one.
 *
 * The rail shows the recent ones; this is where a search from three weeks ago
 * is found. Searching is by name because that is what a saved search has — and
 * the order can be flipped, because "the oldest one I ran for this role" is as
 * real a question as "the last thing I did".
 */
export function AllSearches({ chats, activeId, onOpen, onClose }) {
  /*
   * Here, not in ChatSidebar.
   *
   * It was declared up there and read down here, which is a different function
   * and a different scope — so rendering this threw a ReferenceError, React
   * dropped the subtree, and the ⋯ beside Searches opened nothing at all. The
   * hook was also being run by a component that never used the ref.
   */
  const dialogRef = useDialogFocus()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  const [sortOpen, setSortOpen] = useState(false)

  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const found = needle ? chats.filter((chat) => chat.title.toLowerCase().includes(needle)) : chats
    /* On a copy: `chats` is the list the rail is drawing from. */
    return [...found].sort((a, b) => (sort === 'oldest'
      ? new Date(a.updated_at) - new Date(b.updated_at)
      : new Date(b.updated_at) - new Date(a.updated_at)))
  }, [chats, query, sort])

  const SORTS = [['recent', 'Newest first'], ['oldest', 'Oldest first']]

  /*
   * Mounted on the body, not where it was opened from.
   *
   * This renders inside the rail's search history, which scrolls — and the
   * dialog was being painted as part of that subtree rather than over the page.
   * The result was that the column beside the rail came out on top of it: the
   * first candidate card and the results header's info button were drawn
   * straight through the dialog, and a click at those points landed on the card
   * underneath rather than on the dialog.
   *
   * A portal is what the comment popover and the tag editor already do, for the
   * same reason. An overlay covers the page, so it has to be a child of the
   * page.
   */
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal all-searches"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label="All searches"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-title">
            <h2>Searches</h2>
            <p className="muted">{chats.length} saved</p>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">&times;</button>
        </header>

        <div className="list-tools">
          <div className="folder-search">
            <svg
              className="folder-search-icon" width="15" height="15" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              aria-hidden="true" focusable="false"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            {/* Which names. "Search by name", on a screen with a list of
                candidates behind it, reads as a candidate search — and typing
                one gets "no match" for a person plainly visible through the
                dialog. These are the briefs you have run. */}
            <input
              autoFocus
              type="search"
              value={query}
              placeholder="Search your saved searches"
              aria-label="Search saved searches by name"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="list-sort">
            <button
              type="button"
              className="btn btn-secondary btn-small list-sort-toggle"
              aria-expanded={sortOpen}
              aria-haspopup="true"
              onClick={() => setSortOpen((was) => !was)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
              {SORTS.find(([key]) => key === sort)?.[1]}
            </button>

            {sortOpen && (
              <div className="list-sort-menu">
                {SORTS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={key === sort ? 'list-sort-item list-sort-item-on' : 'list-sort-item'}
                    onClick={() => { setSort(key); setSortOpen(false) }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <ul className="drive-items all-searches-list">
          {shown.length === 0 && (
            <li className="muted folder-search-empty">
              No saved search is called “{query}”.
            </li>
          )}
          {shown.map((chat) => (
            <li
              key={chat.id}
              className={chat.id === activeId ? 'drive-item drive-item-ticked' : 'drive-item'}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(chat.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(chat.id) }
              }}
            >
              <SearchIcon />
              <span className="drive-item-name">
                <strong>{chat.title}</strong>
                <span className="muted">
                  {new Date(chat.updated_at).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' })}
                  {chat.saved > 0 && ` · ${chat.saved} saved`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  )
}

function SearchIcon() {
  return (
    <svg
      className="drive-icon" width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
