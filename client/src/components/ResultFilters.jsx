import { useEffect, useRef, useState } from 'react'

import { AVAILABILITY, CAPACITY_OPTIONS } from './CandidateForm.jsx'
import InfoHint from './InfoHint.jsx'
import { ACTIVITY_FILTERS, EMPTY_RESULT_FILTERS } from './resultFilters.js'

// Re-exported so existing imports of this module keep working; the rules
// themselves live in resultFilters.js as plain JavaScript.
export { ACTIVITY_FILTERS, EMPTY_RESULT_FILTERS, applyResultFilters } from './resultFilters.js'

function Chevron() {
  return (
    <svg
      className="filter-toggle-caret" viewBox="0 0 24 24" width="14" height="14"
      fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/**
 * Seven controls, behind one button.
 *
 * Laid out flat they took three rows above every result list and pushed the
 * candidates — the thing being looked at — below the fold on anything smaller
 * than a desktop. Most searches never touch them, so they are collapsed by
 * default and opened when wanted.
 *
 * Two things make hiding them safe rather than merely tidier, and both matter:
 * the toggle carries a count of how many are set, and Clear stays in the bar
 * even while the panel is shut. Without those, someone leaves a filter on,
 * collapses the panel, and is left staring at a short result list with no
 * visible reason for it and nothing to undo.
 */
/** The funnel, drawn so it inherits the button's colour. */
export function Funnel() {
  return (
    <svg
      viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M3 4h18l-7 8.5V19l-4 2v-8.5L3 4Z" />
    </svg>
  )
}

/**
 * Narrow by one of your team's own tags.
 *
 * A list rather than a text box, because the tags are somebody's exact words
 * and half-remembering one is the normal case — but with a search over it,
 * because five tags per candidate across a page of results is more than a
 * dropdown should ask anybody to read. Only the tags actually worn by the rows
 * on screen are offered: a filter that can return nothing is a filter that
 * wastes a press.
 */
function TagFilter({ value, options, onPick }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const away = (event) => { if (!anchor.current?.contains(event.target)) setOpen(false) }
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (options.length === 0) return null

  const needle = query.trim().toLowerCase()
  const shown = needle
    ? options.filter((tag) => tag.label.toLowerCase().includes(needle))
    : options

  return (
    <div className="tag-filter" ref={anchor}>
      <button
        type="button"
        className={`tag-filter-toggle${value ? ' tag-filter-set' : ''}`}
        aria-expanded={open}
        /* A menu, not a listbox: the panel below holds a search field and a
           column of buttons, and `role="listbox"` promises a container of
           nothing but options — a screen reader announcing it as a list of
           choices then finds a text input among them. */
        aria-haspopup="menu"
        onClick={() => { setOpen((was) => !was); setQuery('') }}
      >
        {value || 'Any tag'}
      </button>

      {open && (
        <div className="tag-filter-menu" role="menu" aria-label="Filter by tag">
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="Search tags"
            aria-label="Search tags"
            onChange={(event) => setQuery(event.target.value)}
          />

          <button
            type="button"
            role="menuitemradio"
            aria-checked={!value}
            className={`tag-filter-item${value ? '' : ' tag-filter-item-on'}`}
            onClick={() => { onPick(''); setOpen(false) }}
          >
            Any tag
          </button>

          {shown.map((tag) => (
            <button
              key={tag.label}
              type="button"
              role="menuitemradio"
              aria-checked={value === tag.label}
              className={`tag-filter-item${value === tag.label ? ' tag-filter-item-on' : ''}`}
              onClick={() => { onPick(tag.label); setOpen(false) }}
            >
              <span className={`tag tag-${tag.colour}`}>{tag.label}</span>
            </button>
          ))}

          {shown.length === 0 && <p className="muted tag-filter-empty">No tag matches “{query}”.</p>}
        </div>
      )}
    </div>
  )
}

export default function ResultFilters({
  filters, onChange, shown, matched, total, note,
  /*
   * Two panels, one component.
   *
   * A folder is narrowed by the same questions a result list is — the answers
   * live on the candidate, not on the search — so it would be a second copy of
   * this to write a second one. What differs is at the edges: a folder item has
   * a place in a pipeline and no score, and a search result the other way
   * round. Both are passed in rather than guessed at, so neither screen can
   * offer a control that does nothing.
   */
  statuses = null,
  showScore = true,
  /* The tags worn by the rows this bar is narrowing — computed by the screen
     that owns them, since only it knows what is on the list. */
  tags = [],
  /*
   * Whether to offer a name box.
   *
   * On for the screens that are lists of people you already know — a folder,
   * the reveal history — where you arrive wanting one person and finding them
   * by eye means reading every row. Off for a search, where the list is a
   * ranked answer to a job description and you do not yet know whose names are
   * in it; a name box there invites you to narrow a ranking by something that
   * has nothing to do with the ranking.
   */
  nameSearch = false,
}) {
  const set = (key, value) => onChange({ ...filters, [key]: value })

  /*
   * How many of the collapsed controls are set — which is what the badge on the
   * funnel counts, and what decides whether the panel springs open.
   *
   * `name` is excluded: its box is in the bar and always visible, so counting it
   * would put a badge on the funnel for a control that is not behind the funnel
   * — and worse, the effect below would fling the panel open on the first
   * keystroke of a name.
   */
  const activeCount = Object.keys(EMPTY_RESULT_FILTERS)
    .filter((key) => key !== 'name')
    .filter((key) => filters[key] !== EMPTY_RESULT_FILTERS[key]).length

  /*
   * Opens itself when a search arrives with filters already set — carried over
   * from the previous search, or restored with a saved one. Collapsed state is
   * only honest when the panel matches what is actually being applied.
   *
   * An effect and not a useState initializer, which is what this was: the
   * initializer runs once, at mount, when the panel has just appeared with an
   * empty search and activeCount is always zero. It could never fire for the
   * case it was written for. This watches instead, and only ever opens — a
   * recruiter who closes the panel with filters still applied keeps it closed.
   */
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (activeCount > 0) setOpen(true)
  }, [activeCount])

  return (
    <div className="result-filters">
      <div className="result-filters-bar">
        {/* Counted against the matches, not the whole database. The old
            denominator was every candidate on file, which made "1 of 2" read as
            "one of two matches" when it meant something else entirely. */}
        <span className="result-filters-count" title={`${total} candidate${total === 1 ? '' : 's'} searched`}>
          <strong>{shown}</strong> of {matched} match{matched === 1 ? '' : 'es'}
        </span>

        {/*
          In the bar, not in the panel behind the funnel.

          Same reasoning as the folder list's own search box: a search you have
          to open something to reach is a search nobody uses once the list is
          long enough to need it. It is also the one control here that is not a
          question about the candidate — it is how you find a specific person —
          so it belongs beside the count rather than among the pickers.
        */}
        {nameSearch && (
          <label className="result-name-search">
            <svg
              className="result-name-search-icon" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              aria-hidden="true" focusable="false"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <span className="sr-only">Search by name</span>
            <input
              type="search"
              value={filters.name}
              placeholder="Search by name"
              onChange={(event) => set('name', event.target.value)}
            />
          </label>
        )}

        <button
          type="button"
          className={`filter-toggle${open ? ' filter-toggle-open' : ''}`}
          aria-expanded={open}
          aria-controls="result-filter-panel"
          aria-label={activeCount > 0 ? `Filters, ${activeCount} set` : 'Filters'}
          title="Filters"
          onClick={() => setOpen((was) => !was)}
        >
          {/* A funnel rather than the word. The row above the results is a
              strip of controls, and the only one that had to be read aloud was
              this one. The count beside it still says whether anything is set,
              which is the part a word could not carry anyway. */}
          <Funnel />
          <span className="sr-only">Filters</span>
          {/* The whole reason collapsing is safe. Shown whether open or shut,
              because a set filter is worth knowing about either way. */}
          {activeCount > 0 && <span className="filter-toggle-count">{activeCount}</span>}
          <Chevron />
        </button>

        {/*
          What the score means, folded into an (i) beside the filter.

          It was four sentences of standing explanation above every result list
          — true, worth being able to read, and re-read on every search whether
          or not anybody wanted it. The bubble is keyboard- and touch-reachable,
          not hover-only.
        */}
        {note && <InfoHint text={note} label="How scores are calculated" />}

        {activeCount > 0 && (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => onChange(EMPTY_RESULT_FILTERS)}>
            Clear
          </button>
        )}
      </div>

      {/*
       * `hidden` rather than unmounting: a select the browser has focus in
       * would otherwise be destroyed mid-interaction, and re-rendering seven
       * controls on every open is work for no gain.
       */}
      <div className="result-filters-panel" id="result-filter-panel" hidden={!open}>
        <select
          value={filters.availability}
          aria-label="Availability"
          onChange={(e) => set('availability', e.target.value)}
        >
          <option value="">Any availability</option>
          {AVAILABILITY.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>

        <select
          value={filters.relocation}
          aria-label="Relocation"
          onChange={(e) => set('relocation', e.target.value)}
        >
          <option value="">Relocation: any</option>
          <option value="yes">Open to relocation</option>
          <option value="no">Not open to relocation</option>
        </select>

        <select
          value={filters.capacity}
          aria-label="Capacity"
          onChange={(e) => set('capacity', e.target.value)}
        >
          <option value="">Any capacity</option>
          {CAPACITY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>

        <select
          value={filters.activity}
          aria-label="Activity"
          onChange={(e) => set('activity', e.target.value)}
        >
          <option value="">Any activity</option>
          {ACTIVITY_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>

        <TagFilter
          value={filters.tag}
          options={tags}
          onPick={(label) => set('tag', label)}
        />

        {/*
          Where they stand, on the screens that have a pipeline.

          Ahead of the two checkboxes, so every dropdown is in one run and every
          tick-box in another. It was last, which put a picker on the far side
          of two checkboxes from the four other pickers — the row read as
          [choose][choose][choose][choose][tick][tick][choose] and the eye had
          to go back for the last one.
        */}
        {statuses && (
          <select
            value={filters.status}
            onChange={(e) => set('status', e.target.value)}
            aria-label="Status"
          >
            <option value="">Any status</option>
            {statuses.map((status) => (
              <option key={status.key} value={status.key}>{status.label}</option>
            ))}
          </select>
        )}

        <label className="chip-toggle">
          <input
            type="checkbox"
            checked={filters.hasCoverLetter}
            onChange={(e) => set('hasCoverLetter', e.target.checked)}
          />
          Cover letter
        </label>

        <label className="chip-toggle">
          <input
            type="checkbox"
            checked={filters.hasExtras}
            onChange={(e) => set('hasExtras', e.target.checked)}
          />
          Extra documents
        </label>

        {/* Not on a folder: the people in one arrived from different searches,
            so there is no single number to compare them on. */}
        {showScore && (
          <label className="score-filter">
            Min score
            <input
              type="number" min="0" max="100" value={filters.minScore}
              onChange={(e) => set('minScore', e.target.value)}
            />
          </label>
        )}
      </div>
    </div>
  )
}
