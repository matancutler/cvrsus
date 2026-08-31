import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Where to file this candidate, asked rather than assumed.
 *
 * The menu used to offer "Add to folder", which filed into whichever folder the
 * search owned, and then — once they were in one — a dead line reading "Saved
 * in Backend hires" that reported the fact and offered nothing. So the one
 * moment a recruiter is most likely to want a different folder, having just
 * read the candidate, was the one moment the menu stopped being a control.
 *
 * A candidate is in at most one folder per company: the server takes them out
 * of every other one when it files them. This asks which, marks the one they
 * are in, and says so out loud rather than letting the move look like a copy.
 */
export default function FolderDialog({ folders, inFolderId, onPick, onNewFolder, onClose }) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

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
          {folders.length === 0 && (
            <p className="muted">No folders yet. Make the first one below.</p>
          )}

          <ul className="folder-choices">
            {folders.map((folder) => {
              const here = folder.id === inFolderId
              return (
                <li key={folder.id}>
                  <button
                    type="button"
                    className={here ? 'folder-choice folder-choice-on' : 'folder-choice'}
                    aria-current={here ? 'true' : undefined}
                    disabled={busy}
                    onClick={() => { if (!here) choose(() => onPick(folder.id)) }}
                  >
                    <span className="folder-choice-name">{folder.name}</span>
                    <span className="folder-choice-count">
                      {/* Where they already are, said as a state and not as a
                          count, because that is the useful half of the row. */}
                      {here ? 'Filed here' : `${folder.items?.length ?? 0}`}
                    </span>
                  </button>
                </li>
              )
            })}
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
