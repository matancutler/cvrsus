import { useCallback, useEffect, useRef, useState } from 'react'

import PopMenu from './PopMenu.jsx'
import { RowTick, SelectButton, SelectionBar, useSelection } from './ListSelect.jsx'
import { del, downloadFile, get, patch, post, sendForm } from '../api.js'
import { DATE_LOCALE } from '../dates.js'
import Notice, { StatusNotice, useStandingNotice } from './Notice.jsx'
import scoreBand from '../scoreBand.js'

/**
 * Cursus Triage — the recruiter's own applicant pile, sorted.
 *
 * Three screens behind one component, because they are three states of one
 * object rather than three places:
 *
 *   dashboard   every Triage this organization has run
 *   builder     a draft: the JD, the pile, and what it will cost to start
 *   workspace   a launched Triage: progress, and the results as they arrive
 *
 * They share a component because moving between them must not lose what the
 * recruiter is holding — a half-uploaded pile of two hundred CVs is not
 * something to re-select because a route changed.
 *
 * The visual language is Search's throughout, deliberately. Section 4 requires
 * the score to be recognisable as the same Cursus matching system, and a second
 * card design for the same number would say the opposite.
 */

/* How often a running Triage asks how it is doing. Fast enough that the first
   results feel like they arrive, slow enough not to hammer a server that is
   already busy analysing CVs for this very recruiter. */
const POLL_MS = 2500

/* Files per request. The pile is chunked rather than sent as one body: a
   dropped connection then costs one chunk instead of the whole upload, and the
   progress bar has something real to report. Matches TRIAGE_UPLOAD_CHUNK. */
const CHUNK = 40

export default function TriageTab({ balance, onBalanceChanged, onBuy, admin }) {
  /*
   * null is the list. { id } is one Triage — and { id: null } is one that is
   * being started and has not been written down yet, which is why this is an
   * object rather than an id: "no Triage open" and "a new Triage open" are
   * different states and a bare null cannot hold both.
   */
  const [open, setOpen] = useState(null)

  return open
    ? (
      <TriageWorkspace
        id={open.id}
        /* The live figure from the wallet, so a purchase made in the Billing
           dialog over this screen reaches it. Billing opens as an overlay and
           this component is never unmounted, so without something changing
           underneath it the builder would keep the readiness it fetched when
           the Triage was opened. */
        balance={balance}
        onClose={() => setOpen(null)}
        onBalanceChanged={onBalanceChanged}
        onBuy={onBuy}
        admin={admin}
      />
    )
    : (
      <TriageDashboard
        balance={balance}
        onOpen={(id = null) => setOpen({ id })}
        onBalanceChanged={onBalanceChanged}
        onBuy={onBuy}
        admin={admin}
      />
    )
}

// ------------------------------------------------------------- dashboard ---

/* The same five orderings Folders offers, so one list does not sort by rules
   the other has never heard of. "Size" is the CV count here and the candidate
   count there; both run in each direction. */
const TRIAGE_SORTS = [
  ['recent', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['size', 'Most CVs'],
  ['smallest', 'Fewest CVs'],
  ['name', 'Name, A to Z'],
]

/*
 * The statuses a Triage actually has, in the order they happen.
 *
 * Read off the CHECK constraint on triages.status rather than invented for this
 * menu: a filter offering a state the column cannot hold is a filter that
 * always returns nothing. 'ready' and 'completed' are separate rows in the
 * database and separate words on the card, so they are separate here too.
 */
const TRIAGE_STATUSES = [
  ['all', 'Any status'],
  ['draft', 'Draft'],
  ['processing', 'Processing'],
  /* The words the rows use, not the words the column uses. A menu offering
     "Ready" and "Failed" beside a list of pills reading "Partially analysed"
     and "Needs attention" asks the recruiter to work out that they are the same
     thing; see TriageStatus, which is where these two came from. */
  ['ready', 'Partially analysed'],
  ['completed', 'Completed'],
  ['failed', 'Needs attention'],
]

function TriageDashboard({ balance, onOpen, onBalanceChanged, onBuy, admin }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /* Search and order, exactly as Folders does them — same controls, same place,
     same words. A recruiter who has learned one list has learned both. */
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  /* Status is a filter rather than an ordering, so it is its own control and
     its own menu — folding it into the sort list would offer "Draft" and
     "Newest first" as alternatives to each other, which they are not. */
  const [status, setStatus] = useState('all')
  /*
   * Which menu is open, or null — one piece of state rather than two flags.
   *
   * Two booleans let both popovers be open at once, overlapping each other in
   * the same corner of the toolbar. One value cannot: opening either closes the
   * other by construction, which is what a reader expects of two buttons that
   * sit side by side and drop the same kind of panel.
   */
  const [menu, setMenu] = useState(null)
  const sortOpen = menu === 'sort'
  const statusOpen = menu === 'status'
  const toggleMenu = (which) => setMenu((was) => (was === which ? null : which))
  /* Ticking several and deleting them in one go — the same module Folders
     uses, so the two lists behave identically. */
  const [bulkNote, setBulkNote] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await get('/api/hr/triages', 'recruiter'))
      setError('')
      /* The rail's count comes from the account payload and this list comes
         from its own route, so a Triage a colleague deleted since sign-in left
         the two disagreeing in the same viewport — four in the pill, three in
         the list. Refreshing the account alongside the list is what keeps the
         count a fact about the same moment as the rows. */
      await onBalanceChanged?.()
    } catch (err) {
      setError(err.message)
    }
  }, [onBalanceChanged])

  useEffect(() => { load() }, [load])

  /*
   * A Triage workspace costs nothing, and there is no limit on how many exist.
   *
   * Capacity is spent on CVs at confirmed launch, never on creating a
   * workspace, so this always works — even at zero balance. A recruiter with no
   * capacity meets the purchase gate inside the builder, once they can see how
   * many CVs they are buying for, rather than a disabled button that explains
   * nothing.
   */
  /*
   * Opens the builder. Writes nothing.
   *
   * This used to POST a draft, so pressing + and changing your mind left an
   * "Untitled Triage" in the list for the whole organization to wonder about.
   * The row is created by the first thing typed into the builder — see
   * ensureId there.
   */
  function create() {
    setError('')
    onOpen(null)
  }

  async function remove(id) {
    try {
      await del(`/api/hr/triage/${id}`, 'recruiter')
      await load()
      await onBalanceChanged?.()
    } catch (err) {
      setError(err.message)
    }
  }

  /**
   * Several at once.
   *
   * One request each, against the route a single delete uses, so a bulk delete
   * cannot be permitted where a single one would not be. Capacity is refreshed
   * afterwards because deleting a launched Triage can hand CVs back.
   */
  async function removeSelected(picked, done) {
    setBusy(true)
    setError('')
    setBulkNote('')

    const ids = [...picked]
    const failed = []
    for (const id of ids) {
      try {
        await del(`/api/hr/triage/${id}`, 'recruiter')
      } catch (err) {
        failed.push(err.message)
      }
    }

    await load()
    await onBalanceChanged?.()
    setBusy(false)
    done()

    if (failed.length) setError(`${failed.length} of ${ids.length} could not be deleted. ${failed[0]}`)
    else setBulkNote(`${ids.length} Triage${ids.length === 1 ? '' : 's'} deleted.`)
  }

  /*
   * What the list shows, worked out before the early returns below.
   *
   * useSelection is a hook, and a hook after a conditional return is a hook
   * that stops being called the moment the page is loading — so the rows it
   * needs have to be in hand up here, whether or not there are any yet.
   */
  const loaded = data?.triages ?? []

  /* Both at once, and in this order: narrowing by name and then by state is the
     same list as narrowing by state and then by name, and doing it in one pass
     means neither control can quietly override the other. */
  const wanted = query.trim().toLowerCase()
  const filtered = loaded.filter((t) => {
    if (status !== 'all' && t.status !== status) return false
    if (!wanted) return true
    return (t.title || 'Untitled Triage').toLowerCase().includes(wanted)
  })

  /* On a copy: `data.triages` is what the server sent, and ordering it in place
     would reorder it for anything else reading the same array. */
  const shown = [...filtered].sort((a, b) => {
    if (sort === 'name') return (a.title || '').localeCompare(b.title || '')
    if (sort === 'size') return b.counts.total - a.counts.total
    if (sort === 'smallest') return a.counts.total - b.counts.total
    if (sort === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt)
    return new Date(b.createdAt) - new Date(a.createdAt)
  })

  /* Which controls are actually narrowing the list, so the empty state can
     blame the right one. Asked separately, because "your search or filters" in
     front of an empty search box names something the recruiter never typed. */
  const searching = wanted !== ''
  const narrowed = status !== 'all'

  function clearFilters() {
    setQuery('')
    setStatus('all')
  }

  /* Over the rows actually on screen: "Select all" means all of what the search
     has left, not all of what the server holds. */
  const selection = useSelection(shown.map((triage) => triage.id))

  if (error && !data) return <p className="alert alert-error">{error}</p>
  if (!data) return <p className="muted">Loading your Triages…</p>

  /*
   * The wallet first, the list payload second.
   *
   * These were the other way round, and the list payload is fetched once when
   * the dashboard mounts. Billing opens as an overlay rather than a page, so an
   * admin who bought capacity from the banner came back to a screen still
   * holding the zero it loaded with — banner and all — and the obvious next
   * move was to buy again. The prop is refetched by the workspace whenever the
   * wallet changes, so it is the one that can be right.
   */
  const remaining = balance ?? data.balance ?? 0

  /* The dashboard is the Folders page with Triages in it: same container
     rhythm, same bar, same rows. .triage-dashboard carries the only difference,
     which is that the other Triage screens are laid out more loosely. */
  return (
    <div className="triage-page triage-dashboard">
      {/* Above the title and the full width of the content, which is where a
          banner belongs. Shown at zero only — see TriageBalance. */}
      <TriageBalance balance={remaining} admin={admin} onBuy={onBuy} />

      {/*
        The same bar Folders carries: what you are looking at on the left, and
        one + on the right to make another. Identical gesture, identical place,
        identical control — there is no reason for two ways to add a thing.
      */}
      <div className="drive-bar">
        <nav className="drive-crumbs" aria-label="Triage">
          <span className="drive-crumb drive-crumb-here">Triage</span>
        </nav>

        {/*
          No capacity figure here.

          It used to read "137 CVs of capacity left" on this bar and again in
          the builder, which turns every visit into a glance at a meter going
          down. Capacity is a thing you buy and then stop thinking about: what a
          recruiter needs to know is what the launch in front of them costs,
          which the builder's summary states, and whether they have run out,
          which the banner above says once and then stops.

          The figure is not hidden — Billing and Usage are the screens for
          looking at what the organization holds.
        */}

        <button
          type="button"
          className="drive-add"
          aria-label="New Triage"
          title="New Triage"
          onClick={create}
        >
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <p className="muted triage-lede">
        Sort through the CVs you have already received for a role. Upload the job description
        and the applicant CVs, and Cursus prioritises the whole batch before progressively
        analysing and scoring them, so you read the strongest matches first. Create as many
        Triage workspaces as you need; you only use capacity for the CVs you submit.
      </p>

      {/* One line for both: a failure and a confirmation are never both the
          latest thing that happened. */}
      <StatusNotice
        error={error}
        notice={bulkNote}
        onDismiss={() => { setError(''); setBulkNote('') }}
      />

      {/* Hidden while there is nothing to search — a control with no purpose is
          just another thing on the page. Same rule as Folders. */}
      {data.triages.length > 1 && (
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
            <input
              type="search"
              value={query}
              placeholder="Search Triages"
              aria-label="Search Triages"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="list-sort">
            <button
              type="button"
              className="btn btn-secondary btn-small list-sort-toggle"
              aria-expanded={sortOpen}
              aria-haspopup="true"
              onClick={() => toggleMenu('sort')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
              {TRIAGE_SORTS.find(([key]) => key === sort)?.[1]}
            </button>

            {sortOpen && (
              <div className="list-sort-menu">
                {TRIAGE_SORTS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={key === sort ? 'list-sort-item list-sort-item-on' : 'list-sort-item'}
                    onClick={() => { setSort(key); setMenu(null) }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/*
            Status, beside the ordering and built the same way.

            The same popover as the sort, because it answers the same kind of
            question about the same list and a second style of menu on one bar
            would be a second thing to learn. It names the current choice on the
            button for the same reason the sort does: a list that has been
            narrowed should say so, or it looks as though rows have gone
            missing.
          */}
          <div className="list-sort">
            <button
              type="button"
              className={status === 'all'
                ? 'btn btn-secondary btn-small list-sort-toggle'
                : 'btn btn-secondary btn-small list-sort-toggle list-sort-toggle-on'}
              aria-expanded={statusOpen}
              aria-haspopup="true"
              onClick={() => toggleMenu('status')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true" focusable="false">
                <path d="M3 5h18l-7 8v6l-4 2v-8Z" />
              </svg>
              {TRIAGE_STATUSES.find(([key]) => key === status)?.[1]}
            </button>

            {statusOpen && (
              <div className="list-sort-menu">
                {TRIAGE_STATUSES.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={key === status ? 'list-sort-item list-sort-item-on' : 'list-sort-item'}
                    onClick={() => { setStatus(key); setMenu(null) }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Ticking several, to delete them in one go. */}
          <SelectButton
            selecting={selection.selecting}
            onOpen={() => { selection.open(); setBulkNote('') }}
            onClose={selection.close}
          />
        </div>
      )}

      {selection.selecting && (
        <SelectionBar
          count={selection.count}
          total={shown.length}
          noun="Triage"
          nounPlural="Triages"
          onAll={selection.all}
          onNone={selection.none}
          onDelete={() => removeSelected(selection.picked, selection.close)}
          busy={busy}
        />
      )}


      {data.triages.length === 0 ? (
        <div className="empty">
          <h2>No Triages yet</h2>
          <p className="muted">
            Create as many as you need; you only use capacity for the CVs you submit for
            processing.
          </p>
          <button type="button" className="btn btn-primary" onClick={create}>
            New Triage
          </button>
        </div>
      ) : (
        <ul className="drive-items">
          {/*
            Nothing matched, and a way back.

            The sentence names both controls when both are narrowing, because
            "no Triage matches Sales" in front of a list filtered to Drafts
            explains half of why the screen is empty. The button clears
            everything at once: the alternative is a person deleting their own
            search text one character at a time wondering where their work went.
          */}
          {shown.length === 0 && (
            <li className="muted folder-search-empty">
              {searching && narrowed && <>No Triage matches your search and filters. </>}
              {searching && !narrowed && <>No Triage matches “{query}”. </>}
              {!searching && narrowed && (
                <>No Triage is {TRIAGE_STATUSES.find(([key]) => key === status)?.[1].toLowerCase()}. </>
              )}
              <button type="button" className="link-button" onClick={clearFilters}>
                Clear
              </button>
            </li>
          )}
          {shown.map((triage) => (
            <TriageRow
              key={triage.id}
              triage={triage}
              selecting={selection.selecting}
              ticked={selection.isPicked(triage.id)}
              onTick={() => selection.toggle(triage.id)}
              onOpen={() => onOpen(triage.id)}
              onDelete={() => remove(triage.id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * What is left, and how to get more.
 *
 * The number is shown to everyone and the way to buy only to an admin, which is
 * the same rule the reveal balance follows: offering a recruiter a route to a
 * screen they are refused is a dead end dressed as a solution.
 */
function TriageBalance({ balance, admin, onBuy }) {
  /* Dismissed until the capacity comes back and goes again — see
     useStandingNotice, which is told the fact rather than asked to encode it in
     the key. Putting the balance in the key looked like it did that, and could
     not: this returns null above zero, so `triage-0` was the only key it ever
     wrote. */
  const [show, dismiss] = useStandingNotice('triage-exhausted', balance === 0)

  /*
   * Nothing at all while there is capacity.
   *
   * A banner that starts warning at "running low" is on screen for most of a
   * balance's life, and by the time it means something nobody reads it. This
   * one appears when the number reaches zero and not before.
   */
  if (balance > 0 || !show) return null

  return (
    <Notice tone="warn" className="page-banner" onDismiss={dismiss}>
      <div className="triage-banner-body">
        <div>
          <strong>No Triage capacity remaining.</strong> You can still create workspaces, add a job
          description and upload CVs; only processing them is paused.
        </div>
        {admin
          ? (
            /* Names the product it is about, and lands on it — this said "Buy
               more" and opened Billing on Reveals. */
            <button type="button" className="btn btn-secondary btn-small" onClick={onBuy}>
              Add Triage capacity
            </button>
          )
          : <span className="muted">Your administrator can add more.</span>}
      </div>
    </Notice>
  )
}

/** A stack of paper — the Triage equivalent of the folder tab. */
function TriageIcon() {
  return (
    <svg
      className="drive-icon" viewBox="0 0 24 24" width="22" height="22"
      fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <path d="M8 3h6l4 4v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v4h4" />
      <path d="M4 8v11a2 2 0 0 0 2 2h9" />
    </svg>
  )
}

/*
 * A Triage row IS a folder row.
 *
 * It was a card with its own open-button, its own delete-and-confirm pair and
 * its own spacing, sitting one screen away from a list of folders that is the
 * same idea — a named container of candidates you open. Two treatments for one
 * concept is the thing that makes a product feel assembled, so this now uses
 * the drive row wholesale: same icon column, same name-over-meta, same owner
 * column, same actions behind the same dots.
 */
function TriageRow({ triage, onOpen, onDelete, selecting, ticked, onTick }) {
  const { counts } = triage
  const name = triage.title || 'Untitled Triage'
  /* While selecting, the row ticks instead of opening — the same rule Folders
     follows, from the same module. */
  const act = selecting ? onTick : onOpen

  return (
    <li
      className={[
        'drive-item drive-item-triage',
        selecting ? 'drive-item-selecting' : '',
        ticked ? 'drive-item-ticked' : '',
      ].filter(Boolean).join(' ')}
      role={selecting ? 'checkbox' : 'button'}
      aria-checked={selecting ? ticked : undefined}
      tabIndex={0}
      onClick={act}
      onKeyDown={(event) => {
        /* Only what lands on the row itself — the corner has its own menu. */
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act() }
      }}
    >
      {selecting ? <RowTick checked={ticked} /> : <TriageIcon />}

      <span className="drive-item-name">
        <strong>{name}</strong>
        <span className="muted">
          {[
            `${counts.total} CV${counts.total === 1 ? '' : 's'}`,
            new Date(triage.createdAt).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' }),
          ].filter(Boolean).join(' · ')}
        </span>
      </span>

      <TriageStatus triage={triage} />

      <span className="drive-item-owner muted">{triage.author ?? 'A colleague'}</span>

      <span
        className="drive-item-menu"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <PopMenu
          label={`Actions for ${name}`}
          items={[
            { key: 'open', label: 'Open', onSelect: onOpen },
            { key: 'delete', label: 'Delete', danger: true, onSelect: onDelete },
          ]}
        />
      </span>
    </li>
  )
}

/**
 * The status, said honestly.
 *
 * "Ready" never means finished — Section 5 asks for "50 of 327 fully analysed"
 * rather than a bar that implies the whole pile has final scores, so a Triage
 * in progress reports both numbers and lets the recruiter judge.
 */
function TriageStatus({ triage }) {
  const { counts, status } = triage

  const label = {
    draft: 'Draft',
    processing: 'Processing',
    ready: 'Partially analysed',
    completed: 'Completed',
    failed: 'Needs attention',
  }[status] ?? status

  return (
    <span className={`triage-status triage-status-${status}`}>
      <span className="triage-status-label">{label}</span>
      {status !== 'draft' && counts.usable > 0 && (
        <span className="muted triage-status-count">
          {counts.analysed} of {counts.usable} analysed
        </span>
      )}
    </span>
  )
}

// --------------------------------------------------------------- one job ---

/**
 * One Triage — including the one that does not exist yet.
 *
 * `initialId` is null for a Triage being started. The row is created by the
 * first thing the recruiter writes into the builder (see ensureId there), and
 * the id lands here rather than in TriageTab so that the builder is not
 * remounted at the moment of saving — remounting mid-edit would throw away the
 * text being typed and the caret with it.
 */
function TriageWorkspace({ id: initialId, balance, onClose, onBalanceChanged, onBuy, admin }) {
  const [id, setId] = useState(initialId)
  const [state, setState] = useState(null)
  const [error, setError] = useState('')

  /* Takes the id explicitly because the caller that has just created the row
     knows it before this component's state does. */
  const load = useCallback(async (which = id) => {
    try {
      setState(await get(which ? `/api/hr/triage/${which}` : '/api/hr/triages/new', 'recruiter'))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [id])

  /*
   * Reloaded when the wallet's capacity changes, not only when the id does.
   *
   * `readiness` comes down with this fetch and decides whether the builder
   * shows a Start button or a purchase gate. Buying happens in a dialog over
   * this screen, which never unmounts it, so without the balance in the
   * dependencies an admin who had just bought 500 CVs went on being told they
   * had none.
   */
  useEffect(() => { load() }, [load, balance])

  if (error && !state) {
    return (
      <div className="triage-page">
        <BackLink onClose={onClose} />
        <p className="alert alert-error">{error}</p>
      </div>
    )
  }
  if (!state) return <p className="muted">Loading…</p>

  return state.triage.launched
    ? (
      <TriageResults
        id={id}
        initial={state}
        onClose={onClose}
        onBalanceChanged={onBalanceChanged}
      />
    )
    : (
      <TriageBuilder
        id={id}
        onCreated={setId}
        state={state}
        reload={load}
        onClose={onClose}
        onBalanceChanged={onBalanceChanged}
        onBuy={onBuy}
        admin={admin}
      />
    )
}

function BackLink({ onClose }) {
  return (
    <button
      type="button"
      className="btn btn-quiet triage-back"
      onClick={onClose}
      aria-label="All Triages"
      title="All Triages"
    >
      <span aria-hidden="true">‹</span>
    </button>
  )
}

// --------------------------------------------------------------- builder ---

/**
 * JD, then pile, then confirm.
 *
 * The order is the order the recruiter thinks in, and the confirmation step is
 * required rather than decorative: Section 2.4 wants the JD, the valid count,
 * the excluded count and the price all on screen before a credit moves.
 */
function TriageBuilder({ id, onCreated, state, reload, onClose, onBalanceChanged, onBuy, admin }) {
  const [jd, setJd] = useState(state.triage.jd ?? '')
  const [title, setTitle] = useState(state.triage.title ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [upload, setUpload] = useState(null)
  const [launching, setLaunching] = useState(false)

  const fileInput = useRef(null)
  const folderInput = useRef(null)
  const jdInput = useRef(null)

  /**
   * The id, creating the Triage if this is the first thing written into it.
   *
   * Opening New Triage used to POST a draft straight away, so every recruiter
   * who looked at the screen and left added a row to everybody's list. Nothing
   * is written until there is something to write: a name, a job description, a
   * file. It still costs nothing — capacity is spent at launch — this is about
   * not inventing work nobody asked for.
   *
   * A ref, not state: two saves can be triggered close together (blurring the
   * title straight into a file drop), and a state update would not have landed
   * before the second one read it, which would create two Triages for one.
   */
  const idRef = useRef(id)
  useEffect(() => { idRef.current = id }, [id])

  async function ensureId() {
    if (idRef.current) return idRef.current
    const result = await post('/api/hr/triage', { title: title || null }, 'recruiter')
    idRef.current = result.triage.id
    onCreated?.(result.triage.id)
    /*
     * The rail counts Triage workspaces, and this is the moment one starts
     * existing — the first thing typed into a new builder writes the row.
     * Without this the number beside "Triage" stayed a draft behind until
     * something else happened to reload the account.
     *
     * Not awaited: the count catching up a moment later is fine, and making
     * the first keystroke of a job description wait on an account refetch is
     * not.
     */
    onBalanceChanged?.().catch(() => { /* the count catches up on the next read */ })
    return idRef.current
  }

  const { triage, files, readiness, balance, allowance } = state

  async function saveJd(next = jd, nextTitle = title) {
    /* Nothing typed and nothing saved: there is no edit to record and no reason
       to bring a Triage into existence. Blurring an untouched field is the most
       common way to reach this. */
    if (!idRef.current && !String(next).trim() && !String(nextTitle).trim()) return

    setSaving(true)
    setError('')
    try {
      const tid = await ensureId()
      await patch(`/api/hr/triage/${tid}`, { jd: next, title: nextTitle || null }, 'recruiter')
      await reload(tid)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  /** A JD as a document, read for its text exactly as Search reads one. */
  async function attachJd(file) {
    if (!file) return
    setSaving(true)
    setError('')
    try {
      const form = new FormData()
      form.append('jd', file)
      const result = await sendForm('/api/hr/jd-text', form)
      setJd(result.text)
      await saveJd(result.text, title)
      setNotice(`Read the job description from ${result.fileName}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
      if (jdInput.current) jdInput.current.value = ''
    }
  }

  /**
   * The pile, in chunks.
   *
   * Progress is reported per chunk rather than per file because that is what
   * the browser can actually tell us without a second protocol — and a count
   * that moves in forties still answers the question somebody staring at a
   * three-hundred-file upload is asking, which is whether it is moving at all.
   */
/**
 * Every file inside whatever was dropped, folders included.
 *
 * `dataTransfer.files` is empty for a directory, so dropping the folder a
 * recruiter has been collecting CVs in did precisely nothing — the one gesture
 * the dropzone most invites. The entries API is the only way to walk one.
 *
 * The entry list has to be taken synchronously, before the first await: the
 * browser empties `dataTransfer.items` as soon as the drop handler returns, and
 * reading it afterwards finds nothing. Everything after that point works from
 * the entries already in hand.
 */
async function filesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])]
    .map((item) => (item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean)

  /* No entries API, or nothing that answered to it: the plain list is right. */
  if (entries.length === 0) return [...(dataTransfer.files ?? [])]

  const found = []

  async function walk(entry) {
    if (entry.isFile) {
      found.push(await new Promise((resolve, reject) => entry.file(resolve, reject)))
      return
    }
    if (!entry.isDirectory) return

    const reader = entry.createReader()
    /*
     * readEntries hands back at most a hundred at a time and signals the end
     * with an empty batch. One call reads a folder of five hundred CVs as a
     * hundred and reports no error at all, which is the worst way to be wrong
     * about how many CVs somebody handed you.
     */
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
      if (batch.length === 0) break
      for (const child of batch) await walk(child)
    }
  }

  for (const entry of entries) await walk(entry)
  return found
}

  async function addFiles(list) {
    const offered = [...list]

    /*
     * A folder arrives wholesale.
     *
     * Whatever else lives in it comes too — the screenshots, the .DS_Store, the
     * old offer letter in the same directory — and posting those to be refused
     * one at a time turns "12 CVs ready" into a notice mostly about files the
     * recruiter never meant to send. They are dropped here instead, and counted,
     * so the number is still accounted for rather than quietly different from
     * what was handed over.
     */
    const chosen = offered.filter((file) => /\.(pdf|docx)$/i.test(file.name))
    const ignored = offered.length - chosen.length

    if (chosen.length === 0) {
      setNotice('')
      setError(ignored > 0
        ? `Nothing there was a PDF or Word file — ${ignored} ${ignored === 1 ? 'file' : 'files'} ignored.`
        : '')
      return
    }

    setError('')
    setNotice('')
    setUpload({ done: 0, total: chosen.length, results: [] })

    const collected = []
    try {
      /* The first CV is as good a reason to create the Triage as the first
         word of the job description. */
      const tid = await ensureId()

      for (let at = 0; at < chosen.length; at += CHUNK) {
        const slice = chosen.slice(at, at + CHUNK)
        const form = new FormData()
        for (const file of slice) form.append('cvs', file)

        const result = await sendForm(`/api/hr/triage/${tid}/files`, form)
        collected.push(...result.results)
        setUpload({ done: Math.min(at + slice.length, chosen.length), total: chosen.length, results: [...collected] })
      }

      await reload(idRef.current)

      const added = collected.filter((r) => r.status === 'added').length
      const duplicates = collected.filter((r) => r.status === 'duplicate').length
      const rejected = collected.filter((r) => r.status === 'rejected').length

      setNotice([
        `${added} CV${added === 1 ? '' : 's'} ready`,
        duplicates > 0 ? `${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped` : '',
        rejected > 0 ? `${rejected} could not be accepted` : '',
        ignored > 0 ? `${ignored} not a PDF or Word file` : '',
      ].filter(Boolean).join(' · '))
    } catch (err) {
      setError(err.message)
    } finally {
      setUpload((was) => (was ? { ...was, finished: true } : was))
      if (fileInput.current) fileInput.current.value = ''
      if (folderInput.current) folderInput.current.value = ''
    }
  }

  async function removeFile(fileId) {
    try {
      await del(`/api/hr/triage/${idRef.current}/files/${fileId}`, 'recruiter')
      await reload(idRef.current)
    } catch (err) {
      setError(err.message)
    }
  }

  async function launch() {
    setLaunching(true)
    setError('')
    try {
      await post(`/api/hr/triage/${idRef.current}/launch`, {}, 'recruiter')
      await onBalanceChanged?.()
      await reload(idRef.current)
    } catch (err) {
      setError(err.message)
      setLaunching(false)
    }
  }

  const rejected = files.filter((file) => file.status === 'unreadable' || file.status === 'failed')
  /* What this launch will cost and whether the two limits allow it. Both come
     from the server, so the arithmetic on screen is the arithmetic the charge
     will use. */
  const cvs = readiness.cvs ?? triage.counts.total
  const shortOnCapacity = readiness.problems.some((p) => p.code === 'no_capacity')
  const overAllowance = readiness.problems.some((p) => p.code === 'over_allowance')

  return (
    <div className="triage-page">
      <TriageBalance balance={balance} admin={admin} onBuy={onBuy} />

      <header className="triage-head">
        <div>
          {/* pic 7 — the way back sits on the title's line, not above it. */}
          <div className="triage-title-row">
            <BackLink onClose={onClose} />
            {/* Its name once it has one. This was a literal, so reopening a draft
          saved last week presented it as "New Triage" — the same heading the
          builder shows before anything exists. */}
      <h2>{triage.title || 'New Triage'}</h2>
          </div>
          <p className="muted triage-lede">
            One job description and the CVs you received for it, up to {triage.fileCap} at a time.
            Nothing is charged until you confirm.
          </p>
        </div>
      </header>

      <StatusNotice error={error} notice={notice} onDismiss={() => { setError(''); setNotice('') }} />

      <section className="triage-step">
        <h3>Step 1 · The role</h3>

        <label className="field">
          <span className="field-label">Name this Triage</span>
          <input
            type="text"
            value={title}
            placeholder="Senior Backend Engineer"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => saveJd(jd, title)}
          />
        </label>

        <label className="field">
          <span className="field-label">Job description</span>
          <textarea
            rows={8}
            value={jd}
            placeholder="Paste the job description, or attach it as a PDF or Word file…"
            onChange={(event) => setJd(event.target.value)}
            onBlur={() => saveJd()}
          />
        </label>

        <div className="triage-jd-actions">
          <input
            ref={jdInput}
            type="file"
            accept=".pdf,.docx"
            className="visually-hidden"
            onChange={(event) => attachJd(event.target.files?.[0])}
          />
          {/* The same paperclip the composer uses. An attachment control that is
              a word here and an icon there is two things to learn for one
              gesture. */}
          <button
            type="button"
            className="icon-button attach-button"
            onClick={() => jdInput.current?.click()}
            aria-label="Attach the job description as a file"
            title="Attach the job description as a file"
          >
            <PaperclipIcon />
          </button>
          {saving && <span className="muted">Saving…</span>}
        </div>
      </section>

      <section className="triage-step">
        <h3>Step 2 · The CVs</h3>
        <p className="muted">
          Select every CV you received for this role: PDF or Word, up to {triage.fileCap} files.
          Duplicates are detected and skipped, so you are never charged for reading the same CV
          twice.
        </p>

        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.docx"
          className="visually-hidden"
          onChange={(event) => addFiles(event.target.files ?? [])}
        />
        {/*
          The same control pointed at a directory.

          A separate input because `webkitdirectory` is a property of the picker
          and not of the pick: one input cannot offer both, and a recruiter with
          a folder of applications should not have to open it and select five
          hundred files to hand over the folder they already have.

          `accept` is deliberately absent — it is advisory at best on a
          directory pick and browsers differ on whether they honour it — so the
          filtering that matters is done on what comes back, in addFiles.
        */}
        <input
          ref={folderInput}
          type="file"
          multiple
          webkitdirectory=""
          directory=""
          className="visually-hidden"
          onChange={(event) => addFiles(event.target.files ?? [])}
        />

        <div
          className="dropzone triage-dropzone"
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              fileInput.current?.click()
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            /* Not `dataTransfer.files`: that is empty when what was dropped is
               a folder, which is most of the reason anybody drags onto this. */
            filesFromDrop(event.dataTransfer).then(addFiles)
          }}
        >
          <strong>Drop the CVs or a folder here, or click to browse</strong>
          <span className="muted">PDF or DOCX. Select them all at once</span>

          {/*
            Its own control, because clicking the zone opens the file picker and
            a folder needs the other one. stopPropagation, or pressing it opens
            both pickers — the zone underneath is itself a button.
          */}
          <button
            type="button"
            className="btn btn-quiet btn-small triage-folder-pick"
            onClick={(event) => { event.stopPropagation(); folderInput.current?.click() }}
          >
            Choose a folder instead
          </button>
        </div>

        {upload && !upload.finished && (
          <div className="triage-upload-progress">
            <div className="usage-bar">
              <span style={{ width: `${Math.round((upload.done / upload.total) * 100)}%` }} />
            </div>
            <span className="muted">Uploading {upload.done} of {upload.total}…</span>
          </div>
        )}

        {files.length > 0 && (
          <>
            <p className="triage-file-summary">
              <strong>{files.length}</strong> file{files.length === 1 ? '' : 's'} ready
              {rejected.length > 0 && (
                <> · <span className="triage-file-bad">{rejected.length} with problems</span></>
              )}
            </p>

            <ul className="triage-files">
              {files.map((file) => (
                <li key={file.id} className={file.error ? 'triage-file triage-file-error' : 'triage-file'}>
                  <span className="triage-file-name">{file.name}</span>
                  {file.error
                    ? <span className="triage-file-why">{file.error}</span>
                    : <span className="muted">{formatBytes(file.size)}</span>}
                  <button
                    type="button"
                    className="btn btn-quiet btn-small"
                    onClick={() => removeFile(file.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="triage-step triage-confirm">
        <h3>Step 3 · Start</h3>

        <dl className="triage-summary">
          <div>
            <dt>Role</dt>
            <dd>{triage.title || <span className="muted">Not named yet</span>}</dd>
          </div>
          <div>
            <dt>Job description</dt>
            <dd>{triage.hasJd ? `${triage.jd.trim().length} characters` : <span className="muted">Not added yet</span>}</dd>
          </div>
          <div>
            <dt>CVs to sort</dt>
            <dd>{triage.counts.total}</dd>
          </div>
          <div>
            <dt>This Triage will use</dt>
            <dd>{cvs} CV{cvs === 1 ? '' : 's'} of capacity</dd>
          </div>

        </dl>

        {!readiness.ready && (
          <ul className="triage-problems">
            {readiness.problems.map((problem) => (
              <li key={problem.code}>{problem.message}</li>
            ))}
          </ul>
        )}

        {/*
          The purchase gate.

          Reached only once the recruiter can see what they have built, which is
          the moment buying makes sense. The addendum asks for the interrupted
          flow to be returned to afterwards — buying happens in the Billing
          dialog over this one, so this draft is still here when it closes.
        */}
        {shortOnCapacity ? (
          <div className="triage-gate">
            <p>
              <strong>
                This Triage needs {cvs} CV{cvs === 1 ? '' : 's'} and your organization has{' '}
                {balance ?? 0}.
              </strong>{' '}
              Your draft is saved. Buy more capacity and come straight back to it, with the job
              description and every file still here.
            </p>
            {admin ? (
              <button type="button" className="btn btn-primary" onClick={onBuy}>Buy more capacity</button>
            ) : (
              <p className="muted">Ask your administrator to buy more Triage capacity for your team.</p>
            )}
          </div>
        ) : overAllowance ? (
          /*
           * A different problem with a different answer. The organization has
           * the capacity; this seat is capped below what the launch needs, so
           * sending them to a checkout would sell them something that does not
           * unblock them.
           */
          <div className="triage-gate">
            <p>
              <strong>
                Your Triage allowance leaves you {allowance} of the {cvs} CV
                {cvs === 1 ? '' : 's'} this needs.
              </strong>{' '}
              Your organization has capacity. Ask your administrator to raise your allowance. Your
              draft is saved.
            </p>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={!readiness.ready || launching}
            onClick={launch}
          >
            {launching
              ? 'Starting…'
              : 'Start'}
          </button>
        )}
      </section>
    </div>
  )
}

// --------------------------------------------------------------- results ---

/**
 * A launched Triage.
 *
 * Polls while work is outstanding and stops when it is not, so a completed
 * Triage costs nothing to sit on. Reaching the end of the loaded results asks
 * for the next tranche — which is the whole progressive design, and the reason
 * this component never needs to know that a tranche is twenty-five.
 */
function TriageResults({ id, initial, onClose, onBalanceChanged }) {
  const [state, setState] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState(null)

  const loaded = rows.length

  /*
   * `advance` tells the server the recruiter has reached the end of what is
   * loaded, which is what queues the next twenty-five. Sent with the fetch
   * rather than as a separate call: it is a consequence of the read, and a
   * second round trip would put a gap between reaching the boundary and the
   * work starting.
   */
  const fetchPage = useCallback(async (offset, advance) => {
    const query = `offset=${offset}${advance ? '&advance=1' : ''}`
    return get(`/api/hr/triage/${id}/results?${query}`, 'recruiter')
  }, [id])

  const refresh = useCallback(async () => {
    try {
      const data = await fetchPage(0, false)
      setState(data)
      /* Only the first page is re-read on a poll. Re-fetching everything the
         recruiter has scrolled through would reorder the list under their
         cursor every two and a half seconds. */
      setRows((was) => (was.length <= data.results.length ? data.results : was))
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [fetchPage])

  useEffect(() => { refresh() }, [refresh])

  /* Poll only while something is actually being worked on. */
  const working = state?.working ?? initial.working
  useEffect(() => {
    if (!working) return undefined
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [working, refresh])

  /*
   * Work stopping is the moment refunds have landed.
   *
   * A Triage hands capacity back for files it could not read, and the run tells
   * nobody: this screen had onBalanceChanged passed to it and never called it,
   * so the returned CVs did not show up anywhere until the account happened to
   * reload for some other reason. Fired on the edge rather than every poll, so
   * a long run does not refetch the account every few seconds.
   */
  useEffect(() => {
    if (working) return
    onBalanceChanged?.().catch(() => { /* the balance catches up on the next read */ })
  }, [working, onBalanceChanged])

  async function showMore() {
    setLoadingMore(true)
    try {
      const data = await fetchPage(loaded, true)
      setRows((was) => [...was, ...data.results])
      setState(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  const triage = state?.triage ?? initial.triage
  const states = state?.states ?? initial.states
  const failures = initial.failures ?? []

  return (
    <div className="triage-page">
      <header className="triage-head">
        <div>
          <div className="triage-title-row">
            <BackLink onClose={onClose} />
            <h2>{triage.title || 'Untitled Triage'}</h2>
          </div>
          <p className="muted triage-progress-line">
            {/* Section 5 — the honest sentence, not a bar implying final scores
                for everybody. */}
            <strong>{triage.counts.analysed}</strong> of {triage.counts.usable} applicants fully
            analysed
            {triage.counts.failed > 0 && ` · ${triage.counts.failed} could not be read`}
            {working && <span className="triage-working"> · working…</span>}
          </p>
        </div>
        <TriageStatus triage={triage} />
      </header>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      {triage.status === 'failed' && (
        <p className="alert alert-error">{triage.error ?? 'This Triage could not be processed.'}</p>
      )}

      {triage.interpretation && (
        <p className="triage-interpretation">{triage.interpretation}</p>
      )}

      {rows.length === 0 ? (
        <TriageWaiting states={states} working={working} />
      ) : (
        <>
          <ol className="results triage-results">
            {rows.map((row) => (
              <TriageResultCard
                key={row.id}
                row={row}
                triageId={id}
                onOpen={() => setOpen(row)}
              />
            ))}
          </ol>

          <div className="triage-more">
            {state?.hasMore ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={loadingMore}
                onClick={showMore}
              >
                {loadingMore ? 'Loading…' : 'Show the next 25'}
              </button>
            ) : working ? (
              <p className="muted">
                Analysing the next applicants. They will appear here when they are ready.
              </p>
            ) : triage.status === 'completed' ? (
              <p className="muted">Every applicant in this Triage has been analysed.</p>
            ) : null}

            <p className="muted triage-scoring-note">{state?.scoring?.explanation}</p>
          </div>
        </>
      )}

      {failures.length > 0 && <TriageFailures failures={failures} />}

      {open && (
        <TriageApplicantDialog
          row={open}
          triageId={id}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

/**
 * What is happening while nothing can be shown yet.
 *
 * Section 4 gives every state its own meaning, and this is where that pays off:
 * "reading 300 CVs" and "analysing the first 50" are different waits, and a
 * single spinner for both leaves a recruiter unable to tell progress from a
 * hang.
 */
function TriageWaiting({ states, working }) {
  const stage = states.uploaded > 0
    ? { title: 'Reading the CVs', detail: `${states.uploaded} still to read` }
    : states.processing > 0 || states.prioritized > 0
      ? { title: 'Analysing the strongest matches first', detail: 'The first results appear as soon as they are scored' }
      : { title: 'Getting started', detail: 'This usually takes a minute or two' }

  if (!working && states.scored === 0 && states.failed > 0) {
    return (
      <div className="triage-waiting">
        <h3>No applicants could be analysed</h3>
        <p className="muted">Every uploaded file failed to read. The list below says why.</p>
      </div>
    )
  }

  return (
    <div className="triage-waiting">
      <h3>{stage.title}</h3>
      <p className="muted">{stage.detail}</p>
      <p className="muted">
        You can close this and come back; processing carries on without the page open.
      </p>
    </div>
  )
}

function TriageFailures({ failures }) {
  const [open, setOpen] = useState(false)

  return (
    <section className="triage-failures">
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen((was) => !was)}>
        {open ? 'Hide' : 'Show'} the {failures.length} file{failures.length === 1 ? '' : 's'} that could not be read
      </button>

      {open && (
        <ul className="triage-files">
          {failures.map((file) => (
            <li key={file.id} className="triage-file triage-file-error">
              <span className="triage-file-name">{file.name}</span>
              <span className="triage-file-why">{file.error}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * One applicant.
 *
 * The same shape as a Search result card, minus the two things that would be
 * lies here: there is no reveal chip, because nothing is locked — this CV
 * arrived in the recruiter's own inbox — and no activity dot, because an
 * applicant has no Cursus profile whose freshness could be reported.
 */
function TriageResultCard({ row, triageId, onOpen }) {
  const band = scoreBand(row.score)

  return (
    <li className="result">
      <div
        className="result-main triage-result-main"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          /* Only what lands on the row itself. */
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
        }}
        title={`Open ${row.name}`}
      >
        <span className="result-rank">{row.rank}</span>

        <div className="result-identity">
          <h3>{row.name}</h3>
          <p className="muted">
            {[row.location, row.email, row.phone].filter(Boolean).join(' · ') || row.fileName}
          </p>

          <div className="result-tags">
            {row.reviewedAt && <span className="chip chip-neutral">Opened</span>}
            {row.analysis.confidence && (
              <span className="chip chip-neutral">{row.analysis.confidence} confidence</span>
            )}
            {row.analysis.source === 'deterministic' && (
              <span
                className="chip chip-neutral"
                title="Scored on requirement matching alone: the reasoning pass was unavailable for this CV."
              >
                Keyword score
              </span>
            )}
          </div>

          {row.analysis.reasoning && <p className="reasoning-line">{row.analysis.reasoning}</p>}
        </div>

        <div className="result-side">
          <div className={`score score-${band}`}>
            <span className="score-value">{row.score}</span>
            <span className="score-label">{row.analysis.fit ?? 'match'}</span>
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={(event) => {
              event.stopPropagation()
              downloadFile(`/api/hr/triage/${triageId}/applicants/${row.id}/file`, row.fileName)
            }}
          >
            CV
          </button>
        </div>
      </div>
    </li>
  )
}

/** The full read on one applicant, over the list rather than instead of it. */
function TriageApplicantDialog({ row, triageId, onClose }) {
  const { analysis } = row

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal triage-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{row.name}</h2>
            <p className="muted">
              {[row.email, row.phone, row.location].filter(Boolean).join(' · ') || row.fileName}
            </p>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="triage-modal-score">
          <span className={`score score-${scoreBand(row.score)}`}>
            <span className="score-value">{row.score}</span>
            <span className="score-label">{analysis.fit ?? 'match'}</span>
          </span>
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => downloadFile(`/api/hr/triage/${triageId}/applicants/${row.id}/file`, row.fileName)}
          >
            Open the CV
          </button>
        </div>

        {analysis.reasoning && <p className="triage-modal-reasoning">{analysis.reasoning}</p>}

        <TriageList title="Strengths" items={analysis.strengths} tone="hit" />
        <TriageList title="Gaps" items={analysis.gaps} tone="miss" />
        <TriageList title="Transferable" items={analysis.transferable} />
        <TriageList title="Worth asking about" items={analysis.probes} />

        {analysis.evidence?.length > 0 && (
          <section className="triage-evidence">
            <h3>Evidence from the CV</h3>
            <ul>
              {analysis.evidence.map((item, index) => (
                <li key={index}>
                  <strong>{item.claim}</strong>
                  <q>{item.quote}</q>
                </li>
              ))}
            </ul>
          </section>
        )}

        {analysis.criteria?.length > 0 && (
          <section className="triage-criteria">
            <h3>Against the job description</h3>
            <ul>
              {analysis.criteria.map((item, index) => (
                <li key={index} className={item.assessment === 'meets' ? 'criteria-hit' : 'criteria-miss'}>
                  <span>{item.requirement}</span>
                  <span className="muted">{item.class === 'must-have' ? 'Required' : 'Preferred'}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

function TriageList({ title, items, tone = null }) {
  if (!items || items.length === 0) return null

  return (
    <section className="triage-facet">
      <h3>{title}</h3>
      <ul className={tone ? `triage-facet-list triage-facet-${tone}` : 'triage-facet-list'}>
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </section>
  )
}

/**
 * One paperclip, everywhere something can be attached.
 *
 * Drawn here rather than imported so the component stays self-contained, but
 * deliberately the same path and stroke as the search composer's — .attach-button
 * is what makes the two render identically.
 */
function PaperclipIcon() {
  return (
    <svg
      width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.18 5.18l-9.2 9.2a1.83 1.83 0 0 1-2.59-2.6l8.49-8.48" />
    </svg>
  )
}

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export { TriageBalance }
