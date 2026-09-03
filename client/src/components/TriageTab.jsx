import { useCallback, useEffect, useRef, useState } from 'react'

import { del, downloadFile, get, patch, post, sendForm } from '../api.js'
import Avatar from './Avatar.jsx'
import FolderDialog from './FolderDialog.jsx'
import Notice, { StatusNotice, useStandingNotice } from './Notice.jsx'
import PopMenu from './PopMenu.jsx'
import scoreBand from '../scoreBand.js'

/**
 * Cursus Triage — the recruiter's own applicant pile, sorted.
 *
 * Two screens behind one component, because they are two states of one object
 * rather than two places:
 *
 *   builder     a draft: the JD, the pile, and what it will cost to start
 *   workspace   a launched Triage: progress, and the results as they arrive
 *
 * There was a third — a dashboard listing every Triage the organization had
 * run. The rail lists them on every screen now, so the dashboard was a second
 * and worse copy of it with its own sort, its own filter and its own row
 * design for the same object.
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

export default function TriageTab({
  balance, onBalanceChanged, onBuy, admin, opens, folders = [], setFolders = () => {},
}) {
  /*
   * null is the list. { id } is one Triage — and { id: null } is one that is
   * being started and has not been written down yet, which is why this is an
   * object rather than an id: "no Triage open" and "a new Triage open" are
   * different states and a bare null cannot hold both.
   */
  const [open, setOpen] = useState(opens ? { id: opens.id } : null)

  /*
   * An instruction that arrived while this tab was already the one showing.
   *
   * `opens` is `{ at, id }` — `id: null` for a Triage being started, an id for
   * one to reopen — or null for "nothing was asked for, show the list".
   *
   * The initialiser above runs only on mount, and leaving the Triage tab is
   * what unmounts this, so it covers arriving from the rail but not a second
   * press without going anywhere in between. Keyed on `at`, a timestamp, so
   * pressing the same row twice is two instructions: the same id would be the
   * same object value and the effect would not fire, which is exactly the case
   * of somebody pressing a row, wandering into the builder and pressing it
   * again to get back.
   */
  useEffect(() => {
    if (opens) setOpen({ id: opens.id })
  }, [opens?.at])

  /*
   * There is no list screen. The rail is the list.
   *
   * A dashboard of Triages sat behind this tab, reachable only by a chevron on
   * the workspace — a second, worse copy of something the rail already shows
   * on every screen, with its own sort, its own filter and its own row design
   * for the same object. With the chevron gone it had no way in either.
   *
   * So arriving at this tab is arriving at a Triage: the one the rail named,
   * or a new one when nothing was named. That is the only state left, which is
   * why this returns a workspace unconditionally rather than branching.
   */
  return (
    <TriageWorkspace
      id={open?.id ?? null}
      /* The live figure from the wallet, so a purchase made in the Billing
         dialog over this screen reaches it. Billing opens as an overlay and
         this component is never unmounted, so without something changing
         underneath it the builder would keep the readiness it fetched when the
         Triage was opened. */
      balance={balance}
      onBalanceChanged={onBalanceChanged}
      folders={folders}
      setFolders={setFolders}
      onBuy={onBuy}
      admin={admin}
    />
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
function TriageWorkspace({
  id: initialId, balance, onBalanceChanged, onBuy, admin, folders = [], setFolders = () => {},
}) {
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
    /* No way back drawn here: the rail is on screen beside this and lists every
       Triage, so a failed load is one click from another one. */
    return (
      <div className="triage-page">
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
        onBalanceChanged={onBalanceChanged}
        folders={folders}
        setFolders={setFolders}
      />
    )
    : (
      <TriageBuilder
        id={id}
        onCreated={setId}
        state={state}
        reload={load}
        onBalanceChanged={onBalanceChanged}
        onBuy={onBuy}
        admin={admin}
      />
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
function TriageBuilder({ id, onCreated, state, reload, onBalanceChanged, onBuy, admin }) {
  const [jd, setJd] = useState(state.triage.jd ?? '')
  const [title, setTitle] = useState(state.triage.title ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [upload, setUpload] = useState(null)
  const [launching, setLaunching] = useState(false)

  const fileInput = useRef(null)
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
          {/*
            No way back from the builder.

            The chevron that was here went to the Triage dashboard, and it was
            the wrong thing on this screen: a half-built Triage with a job
            description typed into it and no back button is a screen you finish
            or abandon on purpose, not one you wander out of. The results view
            keeps its chevron — there the work is done and going back to the
            list is the ordinary next move — and the rail lists every Triage,
            so nothing here is a dead end.

            The row wrapper stays: it is what the results view uses too, and a
            bare h2 would take its own margins back.
          */}
          <div className="triage-title-row">
            {/* Its name once it has one. This was a literal, so reopening a
                draft saved last week presented it as "New Triage" — the same
                heading the builder shows before anything exists. */}
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
          {/* "Job title", not "Name this Triage". It is the same words the
              recruiter will type into a job board, and step 3 reads it back
              under the same label rather than translating it into "Role". */}
          <span className="field-label">Job title</span>
          <input
            type="text"
            value={title}
            placeholder="Senior Backend Engineer"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => saveJd(jd, title)}
          />
        </label>

        {/*
          A div, not a label, because the paperclip sits inside it now: a button
          inside a <label> is a button that also focuses the field it sits on,
          so pressing it opened the picker AND put a caret in the textarea.
          htmlFor does the same binding without that.
        */}
        <div className="field">
          <div className="field-label-row triage-jd-head">
            <label className="field-label" htmlFor="triage-jd">Job description</label>
            {/* The same paperclip the composer uses, on the line that names the
                field rather than stranded under a tall textarea where it read
                as belonging to whatever came next. */}
            <input
              ref={jdInput}
              type="file"
              accept=".pdf,.docx"
              className="visually-hidden"
              onChange={(event) => attachJd(event.target.files?.[0])}
            />
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
          <textarea
            id="triage-jd"
            rows={8}
            value={jd}
            placeholder="Paste the job description, or attach it as a PDF or Word file…"
            onChange={(event) => setJd(event.target.value)}
            onBlur={() => saveJd()}
          />
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
          {/*
            One control, whichever shape the pile arrives in.

            There was a second button here — "Choose a folder instead" — because
            `webkitdirectory` is a property of the PICKER and not of the pick, so
            no single file input can offer both. Dropping does not have that
            limitation: filesFromDrop walks directory entries, so a folder
            dragged onto this zone is read whole. The button is gone and the
            copy says which gesture does what, rather than making the recruiter
            choose between two controls before they know the difference.
          */}
          <strong>Drop the CVs or a folder here, or click to browse</strong>
          <span className="muted">PDF or DOCX. A whole folder can be dropped in</span>
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
            <dt>Job title</dt>
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
function TriageResults({ id, initial, onBalanceChanged, folders = [], setFolders }) {
  const [state, setState] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState(null)
  /* Which applicant is in which folder. The folder LIST itself is the
     workspace's — passed in — because the rail's count and the Folders tab read
     the same state, and a folder created here has to appear in both. */
  const [filed, setFiled] = useState({})
  /* Which applicant the folder dialog is open for, if any. */
  const [filing, setFiling] = useState(null)

  async function fileInto(applicantId, folderId) {
    try {
      /* Made first, then filed into — the same two steps a search takes, and
         for the same reason: the create returns the id the file needs, and a
         failure at either end leaves nothing half-done. */
      let target = folderId
      if (folderId === 'new') {
        const name = prompt('Name the new folder', 'Shortlist')
        if (name === null || !name.trim()) return
        const made = await post('/api/hr/folders', { name: name.trim() }, 'recruiter')
        setFolders(made.folders)
        target = made.id
      }

      const data = await post(`/api/hr/folders/${target}/triage-items`, { applicantId }, 'recruiter')
      if (data.folders) setFolders(data.folders)
      if (data.filed) setFiled(data.filed)
    } catch (err) {
      setError(err.message)
    } finally {
      setFiling(null)
    }
  }

  async function unfile(applicantId) {
    try {
      const data = await del(`/api/hr/folders/triage-items/${applicantId}`, 'recruiter')
      if (data.folders) setFolders(data.folders)
      setFiled(data.filed ?? {})
    } catch (err) {
      setError(err.message)
    } finally {
      setFiling(null)
    }
  }

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
      if (data.filed) setFiled(data.filed)
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

  /*
   * How many the button will actually add.
   *
   * It said "Show the next 25" whatever was left, so a Triage with 27 analysed
   * applicants offered 25 more and produced 2 — the one moment the count
   * matters is the last press, and that is exactly where it was wrong.
   *
   * Capped at the page size the server just reported rather than a 25 written
   * here: the tranche is configurable (TRIAGE_PAGE_SIZE), and a number typed
   * into the client would be a second opinion about it.
   */
  const nextPage = Math.min(
    state?.pageSize ?? 25,
    Math.max((state?.total ?? 0) - loaded, 0),
  )

  return (
    <div className="triage-page">
      <header className="triage-head">
        <div>
          <div className="triage-title-row">
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
                folder={filed[row.id] ?? null}
                onFile={() => setFiling(row.id)}
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
                {loadingMore ? 'Loading…' : `Show the next ${nextPage}`}
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

      {filing !== null && (
        <FolderDialog
          folders={folders}
          onPick={(folderId) => fileInto(filing, folderId)}
          /* Its own prop, not onPick('new') — the dialog calls this one for the
             "+ New folder…" row, and without it that row did nothing. */
          onNewFolder={() => fileInto(filing, 'new')}
          onClose={() => setFiling(null)}
          inFolderId={filed[filing]?.id ?? null}
          onRemove={() => unfile(filing)}
        />
      )}

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
 * One applicant, drawn as the card a search draws.
 *
 * It used to be its own row — a rank number, a middle column and a score on the
 * right — which made an applicant look like a different KIND of object from a
 * candidate. They are the same object seen from two places: somebody a
 * recruiter is deciding about. So this uses the search card's classes and the
 * search card's arrangement, and differs only where the difference is real:
 *
 *   no reveal chip and no reveal button — nothing is locked, because this CV
 *   arrived in the recruiter's own inbox rather than out of the marketplace;
 *
 *   no activity dot — an applicant has no Cursus profile whose freshness could
 *   be reported, and a dot that never lights is a column of nothing;
 *
 *   no rank number — the list is already in order, which is the same reason the
 *   search card dropped its own.
 *
 * The score keeps the corner it has everywhere else, and the CV download joins
 * the ⋮ rather than sitting beside the number as a second loud thing.
 */
function TriageResultCard({ row, triageId, onOpen, onFile, folder = null }) {
  const band = scoreBand(row.score)

  const menuItems = [
    onFile && {
      key: 'folder',
      label: 'Save in folder',
      onSelect: () => onFile(),
    },
    {
      key: 'cv',
      label: 'Download CV',
      onSelect: () => downloadFile(
        `/api/hr/triage/${triageId}/applicants/${row.id}/file`,
        row.fileName,
      ),
    },
  ].filter(Boolean)

  return (
    <li className="result">
      <div
        className="result-main"
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          /* Only what lands on the row itself — the corner holds its own
             controls, and a space typed into one of them should not open the
             applicant underneath. */
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
        }}
        title={`Open ${row.name}`}
      >
        <span className="result-lead">
          <span className="result-portrait">
            {/*
              Initials, always. An applicant has no photograph — a CV is a
              document, not a profile — so there is no src to pass and the
              component falls back to the letters, which is what it is for.
            */}
            <Avatar firstName={row.name?.split(/\s+/)[0]} lastName={row.name?.split(/\s+/)[1]} />
          </span>

          <div className="result-identity">
            <h3>
              <span className="result-name">{row.name}</span>
            </h3>
            <p className="muted">
              {[row.location, row.email, row.phone].filter(Boolean).join(' · ') || row.fileName}
            </p>
          </div>
        </span>

        <div className="result-side">
          <div className="result-chips">
            {/* Where they are filed, in the slot the search card keeps for it. */}
            {folder && (
              <span className="chip chip-folder" title={`Saved in your ${folder.name} folder`}>
                {folder.name}
              </span>
            )}
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

          <span className="result-menu" onClick={(event) => event.stopPropagation()}>
            <PopMenu
              vertical
              label={`Actions for ${row.name}`}
              items={menuItems}
            />
          </span>

          <div className={`score score-${band}`}>
            <span className="score-value">{row.score}%</span>
          </div>
        </div>

        {row.analysis.reasoning && (
          <p className="reasoning-line triage-reasoning">{row.analysis.reasoning}</p>
        )}
      </div>
    </li>
  )
}

/** The full read on one applicant, over the list rather than instead of it. */
function TriageApplicantDialog({ row, triageId, onClose }) {
  const { analysis } = row
  const [view, setView] = useState('profile')

  /* Score only when there is one. An applicant whose deep analysis failed still
     has a profile worth reading, and a Score tab over an empty panel is a tab
     that lies about what is behind it. */
  const TABS = [
    ['profile', 'Profile'],
    ...(Number.isFinite(row.score) ? [['score', 'Score']] : []),
  ]
  const showing = TABS.some(([key]) => key === view) ? view : 'profile'

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

        {/*
          The same two tabs the candidate profile has, and deliberately not its
          third.

          A candidate dialog offers Profile, Score and Messages. There is no
          Messages here and there cannot be: an applicant is a CV somebody sent
          to this recruiter, not a Cursus profile with an inbox, so a message
          tab would be a channel with nobody at the other end of it. The two
          that are real are the two that are here.

          Everything used to be on one scroll: the score, the reasoning, four
          lists, the evidence and the criteria, above the person's own details.
          That is the score's thought process, which is what you read when you
          are interrogating a number, not when you are asking who this is.
        */}
        <div
          className="role-switch dialog-tabs"
          role="tablist"
          aria-label="What to read"
          onKeyDown={(event) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
            if (!step) return
            event.preventDefault()
            const here = TABS.findIndex(([key]) => key === showing)
            setView(TABS[(here + step + TABS.length) % TABS.length][0])
          }}
        >
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={showing === key}
              id={`applicant-tab-${key}`}
              aria-controls="applicant-tabpanel"
              tabIndex={showing === key ? 0 : -1}
              className={`role-option${showing === key ? ' role-option-on' : ''}`}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          id="applicant-tabpanel"
          role="tabpanel"
          aria-labelledby={`applicant-tab-${showing}`}
          tabIndex={0}
        >
          {showing === 'profile' ? (
            <>
              {/*
                What is actually known about this person, as labelled rows.

                Everything here was read out of the CV by the parser, so a field
                it could not find is absent rather than blank: an empty "Phone"
                row would state that the CV has no phone number on it, which is
                a claim, and not one this screen can make.
              */}
              <dl className="triage-facts">
                {[
                  ['Name', row.name],
                  ['Email', row.email],
                  ['Phone', row.phone],
                  ['Location', row.location],
                  ['CV', row.fileName],
                  ['Size', formatBytes(row.fileSize)],
                ].filter(([, value]) => value).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>

              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => downloadFile(`/api/hr/triage/${triageId}/applicants/${row.id}/file`, row.fileName)}
              >
                Open the CV
              </button>
            </>
          ) : (
            <>
              <div className="triage-modal-score">
                <span className={`score score-${scoreBand(row.score)}`}>
                  <span className="score-value">{row.score}</span>
                  <span className="score-label">{analysis.fit ?? 'match'}</span>
                </span>
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
            </>
          )}
        </div>
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
