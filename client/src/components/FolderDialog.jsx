import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Where to file this candidate, asked rather than assumed.
 *
 * One dialog for both places a recruiter files somebody: the result card's ⋮
 * and the profile dialog's. The profile used to build its own flat menu — one
 * item per folder, "Move to Backend hires", "Move to Graduates", "Move to
 * Analytics", straight down a popover — which is a list pretending to be a
 * menu, and it grew a row longer every time anyone made a folder.
 *
 * A candidate is in at most one folder per company: the server takes them out
 * of every other one when it files them. So this shows where they are now,
 * separately and always, and offers the rest to move to.
 */
export default function FolderDialog({
  folders, inFolderId, onPick, onNewFolder, onRemove, onClose,
}) {
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const search = useRef(null)

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /* Typing is the first thing somebody with forty folders wants to do. */
  useEffect(() => { search.current?.focus() }, [])

  const here = folders.find((folder) => folder.id === inFolderId) ?? null

  /*
   * The folder they are in is never filtered away.
   *
   * It is held out of the searchable list entirely and shown above it, because
   * it is the one row that is not a destination — it is where they are, and it
   * carries the way out. A search that could hide it would hide Remove with
   * it, which is exactly the thing somebody typing a folder name is least
   * likely to expect.
   */
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return folders
      .filter((folder) => folder.id !== inFolderId)
      .filter((folder) => !wanted || folder.name.toLowerCase().includes(wanted))
  }, [folders, inFolderId, query])

  async function choose(run) {
    if (busy) return
    setBusy(true)
    try {
      await run()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-dialog-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="modal folder-dialog">
        <header className="modal-head">
          <h2 id="folder-dialog-title">Save in folder</h2>
          <p className="muted">
            A candidate sits in one folder at a time, so choosing another moves them.
          </p>
        </header>

        <div className="modal-body">
          {here && (
            <div className="folder-current">
              <p className="field-label">Filed in</p>
              <div className="folder-choice folder-choice-on">
                <span className="folder-choice-name">{here.name}</span>
                {onRemove && (
                  <button
                    type="button"
                    className="btn btn-quiet folder-choice-remove"
                    disabled={busy}
                    onClick={() => choose(() => onRemove())}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Always present, not revealed at a threshold: a box that appears
              once you have eleven folders is a box you have to notice twice. */}
          <label className="field folder-search">
            <span className="visually-hidden">Search folders</span>
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Search folders"
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          {folders.length === 0 && (
            <p className="muted">No folders yet. Make the first one below.</p>
          )}

          {folders.length > 0 && shown.length === 0 && (
            <p className="muted folder-search-empty">
              {query.trim()
                ? `No folder matches “${query.trim()}”.`
                : 'No other folders yet.'}
            </p>
          )}

          <ul className="folder-choices">
            {shown.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className="folder-choice"
                  disabled={busy}
                  onClick={() => choose(() => onPick(folder.id))}
                >
                  <span className="folder-choice-name">{folder.name}</span>
                  <span className="folder-choice-count">{folder.items?.length ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-foot folder-dialog-foot">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => choose(() => onNewFolder())}
          >
            <span aria-hidden="true">+</span> New folder…
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
