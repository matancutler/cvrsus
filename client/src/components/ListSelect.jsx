/**
 * Choosing several rows, and doing one thing to all of them.
 *
 * Folders and Triage are the same list of the same shape, so selection is one
 * module used by both rather than two that agree today. What is shared is the
 * behaviour people actually notice: that the tick replaces the row's icon
 * instead of appearing beside it (so nothing shifts sideways when select mode
 * opens), that clicking anywhere on a row ticks it rather than opening it, and
 * that deleting several asks once, by name, before it starts.
 *
 * The delete itself is not here — a folder and a Triage are deleted by
 * different routes with different consequences — so each page passes its own
 * one-row remove and this drives it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * @param ids  every id currently on screen, in order.
 *
 * Selections are pruned against that list, because a row can leave under the
 * selection's feet: deleted by this bar, filtered out by the search, or removed
 * by a colleague between polls. A tick against a row that is no longer there
 * would be counted in "3 selected" and then deleted invisibly.
 */
export function useSelection(ids) {
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState(() => new Set())

  /* Depend on the contents rather than the array: the parent rebuilds it on
     every render, and an array identity in the dependency list would prune on
     a loop. */
  const fingerprint = ids.join(',')

  useEffect(() => {
    const present = new Set(ids)
    setPicked((was) => {
      const next = new Set([...was].filter((id) => present.has(id)))
      return next.size === was.size ? was : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint])

  const toggle = useCallback((id) => {
    setPicked((was) => {
      const next = new Set(was)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const open = useCallback(() => setSelecting(true), [])

  const close = useCallback(() => {
    setSelecting(false)
    setPicked(new Set())
  }, [])

  const all = useCallback(() => setPicked(new Set(ids)), [fingerprint]) // eslint-disable-line react-hooks/exhaustive-deps
  const none = useCallback(() => setPicked(new Set()), [])

  return useMemo(() => ({
    selecting, picked, toggle, open, close, all, none,
    count: picked.size,
    isPicked: (id) => picked.has(id),
  }), [selecting, picked, toggle, open, close, all, none])
}

/** The way in and the way out, in the tools row beside the search and the sort. */
export function SelectButton({ selecting, onOpen, onClose }) {
  return (
    <button
      type="button"
      className={`btn btn-secondary btn-small list-select-toggle${selecting ? ' list-select-on' : ''}`}
      aria-pressed={selecting}
      onClick={selecting ? onClose : onOpen}
    >
      <TickIcon />
      {selecting ? 'Done' : 'Select'}
    </button>
  )
}

/**
 * What is ticked and what can be done with it.
 *
 * Delete asks first, and the question names the number and the kind — "Delete 3
 * folders?" — because the one thing this control makes easy is destroying
 * several things at once with a single press.
 */
export function SelectionBar({ count, total, noun, nounPlural, onAll, onNone, onDelete, busy, note }) {
  const [confirming, setConfirming] = useState(false)

  /* A confirmation that outlives the thing it was asked about is a trap: emptying
     the selection, or deleting it, must take the question away with it. */
  useEffect(() => { if (count === 0) setConfirming(false) }, [count])

  const things = `${count} ${count === 1 ? noun : nounPlural}`

  return (
    <div className="selection-bar" role="region" aria-label="Selected rows">
      <span className="selection-count">
        {count === 0 ? 'None selected' : `${things} selected`}
      </span>

      <button type="button" className="btn btn-quiet btn-small" onClick={count === total ? onNone : onAll}>
        {count === total ? 'Clear' : `Select all ${total}`}
      </button>

      <span className="selection-actions">
        {confirming ? (
          <>
            <span className="muted selection-ask">Delete {things}?</span>
            <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={onDelete}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
            <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-danger btn-small"
            disabled={count === 0}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
      </span>

      {note && <span className="muted selection-note">{note}</span>}
    </div>
  )
}

/**
 * The tick, in the cell the row's icon lives in.
 *
 * Not a real <input>: the row itself is the control — it is a button that
 * toggles the tick while select mode is open — and nesting a focusable input
 * inside it would put two tab stops and two click targets on one row that mean
 * the same thing. The state is announced on the row instead, by aria-checked.
 */
export function RowTick({ checked }) {
  return (
    <span className={`row-tick${checked ? ' row-tick-on' : ''}`} aria-hidden="true">
      {checked && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          <path d="m5 13 4.5 4.5L19 7" />
        </svg>
      )}
    </span>
  )
}

function TickIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M9 11.5 11.5 14 16 8.5" />
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    </svg>
  )
}
