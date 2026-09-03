import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import ChatPanel from '../components/ChatPanel.jsx'
import ChatSidebar, { AllSearches, AllSearchesButton } from '../components/ChatSidebar.jsx'
import FolderDialog from '../components/FolderDialog.jsx'
import TriageRail from '../components/TriageRail.jsx'
import Avatar from '../components/Avatar.jsx'
import CompanySignUpForm from '../components/CompanySignUpForm.jsx'
import EyeIcon from '../components/EyeIcon.jsx'
import { PencilIcon, TickIcon } from '../components/EditIcons.jsx'
import PopMenu from '../components/PopMenu.jsx'
import CommentsPopover from '../components/CommentsPopover.jsx'
import TagEditor, { TagStrip } from '../components/CandidateTags.jsx'
import AddPhotoIcon from '../components/AddPhotoIcon.jsx'
import Notice, { StatusNotice, useStandingNotice } from '../components/Notice.jsx'
import scoreBand from '../scoreBand.js'
import useDialogFocus from '../useDialogFocus.js'
import useDismissOnOutside from '../useDismiss.js'
import { RowTick, SelectButton, SelectionBar, useSelection } from '../components/ListSelect.jsx'
import PersonIcon from '../components/PersonIcon.jsx'
import PortalBar from '../components/PortalBar.jsx'
import ProfessionalSummary from '../components/ProfessionalSummary.jsx'
import { usePortalChrome } from '../chrome.jsx'
import Req from '../components/Req.jsx'
import VerifiedField from '../components/VerifiedField.jsx'
import SearchHero from '../components/SearchHero.jsx'
import TriageTab from '../components/TriageTab.jsx'
import { PASSWORD_RULES, passwordMeetsRules } from '../passwordRules.js'
import ResultFilters, {
  EMPTY_RESULT_FILTERS,
  applyResultFilters,
} from '../components/ResultFilters.jsx'
import { del, downloadFile, get, getToken, patch, post, put, sendForm, SESSION_ENDED, signOut as signOutRequest, withToken } from '../api.js'
import { DATE_LOCALE, formatDate, formatSeatDate } from '../dates.js'

export default function HrPanel() {
  const [ready, setReady] = useState(false)
  const [me, setMe] = useState(null)
  /* Why the workspace closed, when it was not this person who closed it. */
  const [ended, setEnded] = useState('')

  const load = useCallback(async () => {
    const data = await get('/api/recruiter/me', 'recruiter')
    setMe(data)
    return data
  }, [])

  useEffect(() => {
    if (!getToken('recruiter')) {
      setReady(true)
      return
    }
    load().catch(() => signOutRequest()).finally(() => setReady(true))
  }, [load])

  /*
   * The account was signed in somewhere else, so this device is done.
   *
   * The server has already cleared the cookies and will refuse everything from
   * here; what is left is to stop showing a workspace that cannot act. Said
   * plainly on the sign-in screen, because the alternative — a page that
   * silently empties — reads as the product breaking rather than as a rule
   * doing exactly what it says.
   */
  useEffect(() => {
    const onEnded = (event) => {
      setEnded(event.detail || 'Signed out: this account was signed in on another device.')
      setMe(null)
      setReady(true)
    }
    window.addEventListener(SESSION_ENDED, onEnded)
    return () => window.removeEventListener(SESSION_ENDED, onEnded)
  }, [])

  /*
   * The marketing header and the legal footer belong to the sign-in screen, not
   * to the workspace behind it. Declared from the same value that decides which
   * of the two is rendered, so the two can never disagree.
   */
  usePortalChrome(Boolean(me))

  if (!ready) return <div className="panel panel-narrow muted">Checking your session…</div>
  if (!me) {
    return (
      <AuthCard
        notice={ended}
        onSignedIn={() => { setEnded(''); return load().then(() => setReady(true)) }}
      />
    )
  }

  return (
    <Workspace
      me={me}
      onReload={load}
      onSignOut={() => { signOutRequest().then(() => setMe(null)) }}
    />
  )
}

// ----------------------------------------------------------------- auth ---

/**
 * Setting a new password from the link in a reset email.
 *
 * Shown instead of the sign-in form when the URL carries a token, and it does
 * not sign anybody in when it succeeds: knowing a mailbox is not knowing the
 * company key, and the key is the thing an attacker holding only the mailbox
 * would not have. So this ends by handing them back to the ordinary sign-in.
 */
function ResetCard({ token, onDone }) {
  const [password, setPassword] = useState('')
  /*
   * Typed twice, because it cannot be read back.
   *
   * This is the one screen where a typo is unrecoverable in a way the others
   * are not: there is no current password to fall back on, the link is spent
   * once it is used, and the field is masked — so somebody who mistypes here
   * locks themselves out of an account they had just proved was theirs, and
   * the only way back is another reset email.
   */
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)

  function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    post('/api/recruiter/reset-password', { token, password, confirmPassword: confirm })
      .then(setDone)
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false))
  }

  if (done) {
    return (
      <div className="panel panel-login">
        <h1>Password changed</h1>
        <p className="muted">
          Sign in as <strong>{done.username}</strong> with your company key and the new
          password.
        </p>
        <button type="button" className="btn btn-primary btn-block" onClick={onDone}>
          Go to sign in
        </button>
      </div>
    )
  }

  return (
    <form className="panel panel-login" onSubmit={submit}>
      <h1>Choose a new password</h1>
      <p className="muted">This link is good for one hour and can be used once.</p>

      <div className="field">
        <label className="field-label" htmlFor="reset-password">New password</label>
        <input
          id="reset-password" type="password" autoFocus value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <ul className="rule-list">
        {PASSWORD_RULES.map(({ key, label, test }) => (
          <li key={key} className={test(password) ? 'rule-met' : undefined}>{label}</li>
        ))}
      </ul>

      <div className="field">
        <label className="field-label" htmlFor="reset-confirm">Confirm password</label>
        <input
          id="reset-confirm" type="password" value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {/* Said while they are still typing, not after they press the button.
            Nothing appears until there is something to compare. */}
        {confirm && (
          <p className={`match-line ${password === confirm ? 'match-ok' : 'match-bad'}`}>
            {password === confirm ? 'Passwords match' : 'Passwords do not match yet'}
          </p>
        )}
      </div>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      <button
        type="submit"
        className="btn btn-primary btn-block"
        disabled={busy || !passwordMeetsRules(password) || password !== confirm}
      >
        {busy ? 'Saving…' : 'Set my password'}
      </button>
    </form>
  )
}

function AuthCard({ onSignedIn, notice = '' }) {
  /*
   * A reset link lands here, on the ordinary recruiter door, carrying its token
   * in the query string. Read once into state and stripped from the URL so the
   * token does not sit in the address bar, in history, or in whatever the next
   * page sends as a referrer.
   */
  const [params, setParams] = useSearchParams()
  const [resetToken, setResetToken] = useState(() => params.get('reset'))
  useEffect(() => {
    if (!params.get('reset')) return
    const next = new URLSearchParams(params)
    next.delete('reset')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const [form, setForm] = useState({ joinKey: '', username: '', password: '' })
  /* What came back from a reset request: either where the link went, or the
     instruction to ask an administrator. Null until asked. */
  const [reset, setReset] = useState(null)

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const signIn = (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    // The response sets an httpOnly session cookie; nothing to keep here.
    post('/api/recruiter/login', form)
      .then(() => onSignedIn())
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false))
  }

  /**
   * Ask for a reset.
   *
   * Needs the company key as well as the username, because a username on its
   * own is not scoped to anything — without the key this would be asking the
   * server about every company at once.
   */
  function forgot() {
    setError('')
    setReset(null)

    if (!form.joinKey.trim() || !form.username.trim()) {
      setError('Enter your company key and username first, so we know which account to reset.')
      return
    }

    setBusy(true)
    post('/api/recruiter/forgot-password', { joinKey: form.joinKey, username: form.username })
      .then(setReset)
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false))
  }

  /*
   * The company form itself lives in CompanySignUpForm, because the landing
   * page renders the same thing when someone answers "I am: Recruiter". Two
   * copies of a form this long is how the profile-picture block drifted apart.
   *
   * It no longer signs anyone in — registering creates the account but not a
   * session — so this goes to the same confirmation page the landing card uses.
   */
  if (resetToken) {
    return <ResetCard token={resetToken} onDone={() => setResetToken(null)} />
  }

  if (mode === 'company') {
    return (
      <CompanySignUpForm onCreated={(created) => navigate('/in-review', { state: created })} />
    )
  }


  return (
    <form className="panel panel-login" onSubmit={signIn}>
      {/* §14 — "Sign in". The company key field below is what distinguishes this
          from the candidate screen of the same name. */}
      <h1>Sign in</h1>
      <p className="muted">
        Use the company key, username and password your administrator gave you.
      </p>

      {/* Not an error: nothing went wrong and nothing needs fixing — the seat
          is simply in use elsewhere, and signing in here takes it back. */}
      <StatusNotice notice={notice} onDismiss={() => setNotice('')} />

      <div className="field">
        <label className="field-label" htmlFor="recruiter-key">Company key</label>
        {/* Kept as a format hint: it is a shape nobody can guess at, and unlike
            a name or an email there is nothing here to mistake for a value that
            has already been filled in. */}
        <input
          id="recruiter-key" autoFocus value={form.joinKey} placeholder="ABCD-EFGH-JKLM"
          onChange={(e) => update('joinKey', e.target.value.toUpperCase())}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="recruiter-username">Username</label>
        {/* §14 — the "first.last" sample is gone: the label says what to type. */}
        <input
          id="recruiter-username" value={form.username}
          onChange={(e) => update('username', e.target.value.toLowerCase())}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="recruiter-password">Password</label>
        <input
          id="recruiter-password" type="password" value={form.password}
          onChange={(e) => update('password', e.target.value)}
        />
      </div>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      {/*
        The answer to "I have forgotten it" is different for the two kinds of
        account, and the difference is the point rather than an inconvenience.
        An administrator registered themselves and proved the address on the
        account, so a link can be sent to it. Everyone else was given their
        account — and their password — by that administrator, who is the person
        accountable for the seat; routing recovery around them would defeat the
        arrangement.
      */}
      {reset?.sent && (
        <p className="alert alert-ok">
          A reset link is on its way to {reset.hint}. It is good for the next hour.
        </p>
      )}
      {reset?.askAdministrator && (
        <p className="alert alert-muted">
          Your company administrator manages this account and can set a new password for
          you from the Team tab. Ask them. We cannot reset it for you.
        </p>
      )}
      {/* An administrator with no address on the account — which accounts made
          before email became mandatory can be. Telling them to ask their
          administrator would be absurd, since they are it. */}
      {reset?.noAddress && (
        <p className="alert alert-muted">
          This account has no email address on it, so there is nowhere to send a reset link.
          Add one under My profile once you are signed in, or contact us and we will set a
          new password for you.
        </p>
      )}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>

      <div className="auth-links">
        <button type="button" className="btn btn-quiet" onClick={forgot} disabled={busy}>
          Forgot my password
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setMode('company')}>
          Create a company account
        </button>
      </div>
    </form>
  )
}

// ------------------------------------------------------------ workspace ---

/**
 * The organization balance, shared across the workspace.
 *
 * A context rather than props because the two places that read it — the header
 * and the low-balance banner — and the place that changes it — the reveal
 * dialog, four components down inside whichever tab is open — are in unrelated
 * parts of the tree. Threading a setter through Search, Folders and every card
 * between them would touch a dozen components that have nothing to do with
 * money.
 */
const WalletContext = createContext({ wallet: null, spend: () => {} })

function Workspace({ me, onReload, onSignOut }) {
  /*
   * ?tab= lets the rest of the site point at a specific screen — the pricing
   * page sends an admin here after a purchase, and the seat and balance
   * warnings link to Billing. Only honoured for a tab this recruiter is allowed
   * to see; the effect below sends a non-admin back to Search either way.
   */
  const [params] = useSearchParams()

  /*
   * Two kinds of destination, held apart.
   *
   * `tab` is where you are working — search or folders — and fills the main
   * column. `dialog` is an account screen opened over the top of it: My
   * profile, Team, Usage & billing. Those are errands rather than places, and
   * running one used to replace the search you were reading with a billing
   * table, so coming back meant running the search again.
   */
  const [tab, setTab] = useState(() => (
    ['folders', 'triage'].includes(params.get('tab')) ? params.get('tab') : 'search'
  ))
  const [dialog, setDialog] = useState(() => {
    /* ?tab= from elsewhere on the site — the pricing page sends an admin here
       after a purchase. Only honoured for a screen that exists. */
    const wanted = params.get('tab')
    return ['team', 'billing', 'profile'].includes(wanted) ? wanted : null
  })

  /*
   * Which of Reveals / Seats / Triage the Billing screen opens on.
   *
   * Held here rather than inside BillingTab because the thing that knows which
   * product is at issue is the banner that sent you: a warning about Triage
   * capacity that lands you on Reveals has answered a question you did not ask,
   * and every CTA did exactly that before this existed. BillingTab is unmounted
   * with the dialog, so this has to be set at open time and cannot be set
   * afterwards.
   *
   * ?product= is honoured alongside ?tab=billing so the pricing page and any
   * future link can arrive on the right one.
   */
  const [billingProduct, setBillingProduct] = useState(() => {
    const wanted = params.get('product')
    return ['reveals', 'seats', 'triage'].includes(wanted) ? wanted : 'reveals'
  })

  const openBilling = useCallback((product = 'reveals') => {
    setBillingProduct(product)
    setDialog('billing')
  }, [])
  const [folders, setFolders] = useState([])
  /* The full list of searches, open over the rail. Here rather than inside
     ChatSidebar because the ⋯ that opens it sits beside the rail's heading,
     which the workspace draws and the sidebar does not. */
  const [browsingSearches, setBrowsingSearches] = useState(false)

  /*
   * "Start a Triage" has to survive a mount.
   *
   * TriageTab is unmounted whenever the recruiter is anywhere else, so its own
   * state cannot carry the instruction — by the time it exists, the press that
   * meant it is over. A timestamp rather than a boolean: pressing + Triage
   * twice in a row is two instructions, and a flag that is already true says
   * nothing the second time.
   */
  const [triageOpens, setTriageOpens] = useState(null)

  /*
   * Which of the two lists the rail is showing, and the Triages it needs to
   * show one of them.
   *
   * The searches arrive already loaded — SearchTab publishes them upward — but
   * nothing else in the workspace holds the company's Triages, so they are
   * fetched here the first time the toggle asks for them and refreshed
   * whenever it is pressed. Not on mount: a recruiter who never opens this
   * side should not pay for a list they did not ask for.
   */
  const [railList, setRailList] = useState('searches')
  const [triageRows, setTriageRows] = useState(null)

  const loadTriages = useCallback(async () => {
    try {
      const data = await get('/api/hr/triages', 'recruiter')
      setTriageRows(data.triages ?? [])
    } catch {
      /* A rail that cannot load its list shows an empty one rather than an
         error: it is a way back to work, not the work itself, and the Triage
         screen it leads to reports its own failures properly. */
      setTriageRows([])
    }
  }, [])
  /*
   * Rename and delete, for the rail.
   *
   * Both re-read the list rather than editing the copy in state. A Triage is
   * the company's, so the row being renamed may be open in a colleague's tab
   * and may have been renamed by them a second ago; the server's answer is the
   * one that is true for everybody.
   */
  const renameTriage = useCallback(async (id, title) => {
    try {
      await patch(`/api/hr/triage/${id}`, { title }, 'recruiter')
      await loadTriages()
    } catch { /* the rail reloads on its next open */ }
  }, [loadTriages])

  const deleteTriage = useCallback(async (id) => {
    try {
      await del(`/api/hr/triage/${id}`, 'recruiter')
      /* If the deleted one was on screen, leave the Triage tab holding nothing
         rather than a workspace whose files are gone. */
      setTriageOpens((was) => (was?.id === id ? { at: Date.now(), id: null } : was))
      await loadTriages()
    } catch { /* the rail reloads on its next open */ }
  }, [loadTriages])

  /* The status vocabulary, as the server defines it. Held rather than retyped
     here so the picker cannot offer a stage the server would reject. */
  const [statuses, setStatuses] = useState([])
  const [threads, setThreads] = useState([])
  /* Why the inbox is empty, when it is empty because something broke rather
     than because nothing has been said. */
  const [threadsError, setThreadsError] = useState('')

  /*
   * Seeded from /api/recruiter/me and then kept current by the reveal response,
   * which carries the new balance — so the header falls the moment a reveal is
   * spent instead of waiting for the next page load. Re-seeded whenever the
   * profile reloads, which is what makes a purchase elsewhere show up here.
   */
  const [wallet, setWallet] = useState(me.wallet ?? null)
  useEffect(() => { setWallet(me.wallet ?? null) }, [me.wallet])

  const spend = useCallback((balance) => {
    setWallet((was) => (was ? { ...was, balance, seatUsed: was.seatUsed + 1 } : was))
  }, [])

  const loadFolders = useCallback(async () => {
    const data = await get('/api/hr/folders', 'recruiter')
    setFolders(data.folders)
    if (data.statuses) setStatuses(data.statuses)
    return data.folders
  }, [])

  // Loaded here rather than inside the tab so the unread badge is right even
  // while the recruiter is on Search.
  const loadThreads = useCallback(async () => {
    try {
      const data = await get('/api/hr/threads', 'recruiter')
      setThreads(data.threads)
      setThreadsError('')
      return data.threads
    } catch (error) {
      /*
       * A failed load used to be swallowed by a bare `.catch(() => {})` at the
       * call site, which left the dock showing "reveal a candidate and message
       * them" — the empty state — over an inbox that was never fetched. The two
       * are indistinguishable to the reader and mean opposite things, so the
       * failure says so now.
       */
      setThreadsError(error.message)
      throw error
    }
  }, [])

  useEffect(() => { loadFolders().catch(() => {}) }, [loadFolders])
  useEffect(() => { loadThreads().catch(() => {}) }, [loadThreads])

  const unread = threads.reduce((total, thread) => total + thread.unread, 0)
  const admin = me.recruiter.isOrgAdmin
  /* §15 — registration is open now, and a company is checked before it can see
     anybody. Until then the candidate-facing routes all refuse, so the reason
     is said once at the top rather than discovered as an error per tab.

     Declined is the same shape of problem with a different answer, and it needs
     saying too: without it the workspace looks broken rather than closed —
     every search returns an error and nothing on the page explains why. */
  const pending = me.approval === 'pending'
  const declined = me.approval === 'declined'

  // A non-admin who was sitting on an admin-only tab when their role changed
  // would otherwise be left staring at a blank panel.
  // My profile stays available to everyone; only Team and Billing are gated.
  useEffect(() => {
    if (!admin && ['team', 'billing'].includes(dialog)) setDialog(null)
  }, [admin, dialog])

  /*
   * The search screen's own controls, handed up so the rail can drive them.
   *
   * SearchTab owns the search: the query, the results, the session, and the
   * chat it belongs to. The rail needs to start a new one and reopen an old
   * one, which are two of those. Rather than lift the whole of that state into
   * the shell — where nothing else would use it — SearchTab publishes the four
   * functions it already has and the shell calls them.
   *
   * This is why SearchTab stays mounted when another section is showing rather
   * than being swapped out: unmounting would take the controls with it, and it
   * also means walking over to Folders and back no longer throws away a search
   * you were in the middle of reading.
   */
  const [search, setSearch] = useState(null)

  return (
    <WalletContext.Provider value={{ wallet, spend }}>
    <div className="workspace-shell">
      {/*
        In place of the site header, which is gone from here — see chrome.jsx.

        Down to a wordmark and the way out. The company name and the reveal
        balance both left it: the company is named in the account block at the
        foot of the rail, and the balance is on Usage & billing and My profile
        as a meter that says how much of the allowance is gone rather than a
        bare number. A bar that carries a running total is a bar that argues
        with you on every screen.
      */}
      <PortalBar onSignOut={onSignOut} />

      {pending && (
        <div className="alert alert-warn ws-notice">
          <strong>{me.recruiter.company} is waiting to be approved.</strong>
          <p>
            We check every new company before it can see candidate profiles: searching, opening a
            profile and revealing contact details are all closed until then. Everything else, like
            setting up your team, works now. We will email you as soon as you are cleared.
          </p>
        </div>
      )}

      {/* Red rather than amber: pending is a wait, this is an outcome. No date
          is promised, because there is nothing to wait for — the way forward is
          to write to us, so that is what it says. */}
      {declined && (
        <div className="alert alert-error ws-notice">
          <strong>{me.recruiter.company} has not been approved.</strong>
          <p>
            Searching, opening a profile and revealing contact details are closed for this account.
            If you think this is a mistake, reply to the address you registered with, or{' '}
            <Link to="/contact">get in touch</Link>. We will take another look.
          </p>
        </div>
      )}

      {/*
        The running-low banner is gone from here.

        It sat above the rail on every screen, pushing the work down a band to
        repeat a number that is now a meter on Usage & billing and My profile.
        Running out is still said where it matters and cannot be missed: the
        reveal button in the candidate dialog names the price before it is
        pressed and refuses at zero with the reason.
      */}

      {/*
        Search first, everything else in a rail beside it.
        
        The workspace used to be a strip of six tabs above whichever one was
        open, which put the thing recruiters are here to do — describe a role
        and read who matches — on equal footing with Billing. The rail keeps the
        search history in reach the way a chat product does, and demotes the
        administrative screens to what they are: places you visit occasionally.
      */}
      <div className="ws-body">
        <aside className="ws-rail" aria-label="Workspace">
          {/*
            One button for both kinds of work.

            A search and a Triage are the two things a recruiter starts, and
            only one of them had a control in the rail — the other was a bare
            `+` on a dashboard you had to navigate to first. Naming the pair
            here puts them at the same distance from a standing start, which is
            what they are.
          */}
          <NewMenu
            onSearch={() => { setTab('search'); search?.newSearch() }}
            onTriage={() => { setTab('triage'); setTriageOpens({ at: Date.now(), id: null }) }}
          />

          {/*
            One destination beside the search.

            The administrative screens live in the account menu at the foot of
            the rail — they are things you visit occasionally and they belong
            with the identity they are about.

            Triage used to be a second entry here. It has moved to the toggle
            over the history list below, which is the more honest place for it:
            a Triage is not a destination you visit, it is a thing you made and
            come back to, exactly like a search. Two nav entries and a list of
            searches underneath said the two were different kinds of object.
            They are not — one is yours and one is the company's, and that is
            what the toggle now says.

            It is still NOT filed under Folders. The addendum is explicit that
            it is a separately monetized product area with its own workspaces,
            and putting a paid product inside a free one makes "which of these
            costs a credit" unanswerable at a glance.
          */}
          <nav className="ws-nav" aria-label="Sections">
            <button
              type="button"
              className={tab === 'folders' ? 'ws-nav-item ws-nav-item-on' : 'ws-nav-item'}
              aria-current={tab === 'folders' ? 'page' : undefined}
              onClick={() => setTab('folders')}
            >
              Folders
              {/* pic 3 — the same pill Triage uses, rather than a number in
                  parentheses. One way of showing a count across the rail. */}
              <span className="ws-nav-count">{folders.length}</span>
            </button>

            {/*
              Under Folders, because it is the other standing list of people.

              No count pill. Folders holds a number a recruiter chose and can
              act on; this one only ever goes up, and a rail item that ticks
              upward on its own reads as an inbox with unread items in it.
            */}
            <button
              type="button"
              className={tab === 'reveals' ? 'ws-nav-item ws-nav-item-on' : 'ws-nav-item'}
              aria-current={tab === 'reveals' ? 'page' : undefined}
              onClick={() => setTab('reveals')}
            >
              Reveals
            </button>
          </nav>

          {/*
            What you have already made, on one rail with a switch over it.

            Reopening a search re-runs it rather than restoring a frozen list —
            candidates come and go. Reopening a Triage opens the pile it was
            built from, which does not.
          */}
          <div className="ws-history">
            <div className="ws-rail-head">
              {/*
                The heading became a switch.

                It keeps .ws-rail-heading so both labels are set in the same
                small caps the single heading was, and so the optical nudge
                that aligns the S of SEARCHES with the Y of YESTERDAY still
                applies to whichever word is showing.
              */}
              <div className="rail-toggle ws-rail-heading" role="group" aria-label="What this list shows">
                <button
                  type="button"
                  className={railList === 'searches' ? 'rail-toggle-on' : ''}
                  aria-pressed={railList === 'searches'}
                  onClick={() => setRailList('searches')}
                >
                  Searches
                </button>
                <button
                  type="button"
                  className={railList === 'triage' ? 'rail-toggle-on' : ''}
                  aria-pressed={railList === 'triage'}
                  onClick={() => { setRailList('triage'); loadTriages() }}
                >
                  {/*
                    No count.

                    It carried one while it was a destination in the nav, where
                    a number says "this is how much is behind this door". Here
                    it is one half of a switch, and the list it switches to is
                    the count — visible, and correct, in a way a pill saying 0
                    beside the word is not. A zero on a switch reads as
                    something being wrong rather than as an empty list.
                  */}
                  Triage
                </button>
              </div>

              {/* The rail holds the recent ones; everything else is behind
                  this. Only on the searches side, and only once there is a
                  list worth browsing. */}
              {railList === 'searches' && (search?.chats?.length ?? 0) > 0 && (
                <AllSearchesButton
                  count={search.chats.length}
                  onClick={() => setBrowsingSearches(true)}
                />
              )}
            </div>

            {/*
              No line about who can see these.

              There was one — "Only you can see these" over the searches,
              "Shared with your whole team" over the Triages — on the reasoning
              that the two lists are scoped differently and hiding it would be a
              poor trick. That is still true, and the caption is still not worth
              it: it sat between the switch and the list on every visit to say
              something that changes nothing about what you do next, and the
              rail is the one column on this screen with no room to spare.

              The Triage screen itself still says whose it is where it matters —
              a colleague's Triage carries their name on the row.
            */}

            {railList === 'searches' ? (
              <ChatSidebar
                chats={search?.chats ?? []}
                activeId={search?.chatId ?? null}
                onNew={() => { setTab('search'); search?.newSearch() }}
                onOpen={(id) => { setTab('search'); search?.openChat(id) }}
                onRename={(id, title) => search?.renameChat(id, title)}
                onDelete={(id) => search?.deleteChat(id)}
                bare
              />
            ) : (
              <TriageRail
                triages={triageRows}
                meId={me?.recruiter?.id ?? null}
                activeId={tab === 'triage' ? triageOpens?.id ?? null : null}
                /* Both, in this order: the tab has to be the Triage one before
                   an instruction to open a row can mean anything, and the
                   timestamp makes pressing the same row twice two instructions
                   rather than one repeated value. */
                onOpen={(id) => { setTab('triage'); setTriageOpens({ at: Date.now(), id }) }}
                onRename={renameTriage}
                onDelete={deleteTriage}
              />
            )}

            {browsingSearches && (
              <AllSearches
                chats={search?.chats ?? []}
                activeId={search?.chatId ?? null}
                onOpen={(id) => { setBrowsingSearches(false); setTab('search'); search?.openChat(id) }}
                onClose={() => setBrowsingSearches(false)}
              />
            )}
          </div>

          {/* Who you are signed in as, and everything that is about you: the
              profile, the team, the money. */}
          {/* Billing goes through openBilling like every other route into it,
              so arriving from the menu lands on Reveals rather than on whatever
              product a banner named the last time one was followed. */}
          <AccountMenu
            me={me}
            admin={admin}
            current={dialog}
            onGo={(key) => (key === 'billing' ? openBilling() : setDialog(key))}
          />
        </aside>

        <main className="ws-main">
          {/*
            The two standing facts that stop something working, at the top of
            the work rather than repeated on every card that is affected. Each
            appears when it becomes true, carries a cross, and does not come
            back until it becomes true again.
          */}
          {/* Not on Triage: reveals are spent on marketplace candidates, and a
              warning about them over a screen that cannot spend one is noise on
              the way to somewhere else. Triage has its own banner, inside the
              tab it is about. */}
          {tab !== 'triage' && (
            <BalanceBanner wallet={wallet} admin={admin} onBuy={() => openBilling('reveals')} />
          )}
          <SeatPlanBanner
            seats={wallet?.seats}
            admin={admin}
            onGo={() => openBilling('seats')}
          />

          {/* Hidden rather than unmounted — see the note on `search` above. */}
          <div className={tab === 'search' ? 'ws-section' : 'ws-section ws-section-off'}>
            <SearchTab
              me={me}
              folders={folders}
              setFolders={setFolders}
              onControls={setSearch}
            />
          </div>

          {tab === 'folders' && (
            <FoldersTab me={me} folders={folders} setFolders={setFolders} statuses={statuses} />
          )}
          {tab === 'reveals' && (
            <RevealsTab me={me} folders={folders} setFolders={setFolders} statuses={statuses} />
          )}
          {tab === 'triage' && (
            <TriageTab
              opens={triageOpens}
              balance={wallet?.triage?.balance ?? 0}
              admin={admin}
              /*
               * The one folder list, passed down rather than fetched again.
               *
               * Filing an applicant can create a folder, and the rail's count
               * and the Folders tab both read this state. A second copy inside
               * the Triage screen meant a folder made there was invisible
               * everywhere else until the page happened to reload.
               */
              folders={folders}
              setFolders={setFolders}
              onBalanceChanged={onReload}
              /* Buying opens the Billing dialog over this screen rather than
                 navigating away, so the draft the recruiter was building is
                 still underneath when it closes — the addendum's "return the
                 recruiter to the interrupted New Triage flow". */
              onBuy={() => openBilling('triage')}
            />
          )}
          {/* Team, billing and the profile open over the workspace — see dialog. */}
        </main>
      </div>

      {/* Messaging follows the candidate portal: docked bottom right, so a
          conversation stays open while you keep searching. */}
      {/* Keyed, so moving between two account screens remounts rather than
          reconciling one into the other. Without it the dialog is the same
          instance with different children, and anything seeded from a prop at
          mount — BillingTab's opening product — keeps the old value. */}
      {dialog && (
        <WorkspaceDialog
          key={dialog}
          title={DIALOG_TITLES[dialog]}
          onClose={() => setDialog(null)}
        >
          {dialog === 'team' && admin && (
            <TeamTab
              me={me}
              onSaved={onReload}
              admin={admin}
              onManageSeats={() => openBilling('seats')}
            />
          )}
          {dialog === 'billing' && admin && (
            <BillingTab product={billingProduct} onSeatsChanged={onReload} />
          )}
          {dialog === 'usage' && (
            admin
              ? <OrganizationUsageTab me={me} wallet={wallet} onSaved={onReload} />
              : <UsageTab wallet={wallet} />
          )}
          {dialog === 'profile' && <MyProfileTab me={me} onSaved={onReload} />}
        </WorkspaceDialog>
      )}

      <RecruiterMessagingDock
        me={me}
        threads={threads}
        reloadThreads={loadThreads}
        loadError={threadsError}
      />
    </div>
    </WalletContext.Provider>
  )
}

/**
 * §16 — the balance, permanently visible.
 *
 * A recruiter deciding whether to reveal someone needs to know what is left
 * before they click, not after. It sits in the workspace header for exactly
 * that reason, carries the eye so it reads as the same currency the reveal
 * button spends, and updates from the reveal response without a refetch.
 *
 * Everyone sees the number; only an admin gets the button, because only an
 * admin can act on it. Offering a recruiter a route to a screen they are
 * refused would be a dead end dressed as a solution.
 *
 * It opens the Billing tab rather than the public pricing page. Inside a portal
 * a control that throws you out to a marketing site is a trapdoor, and Billing
 * holds the same packs plus the balance the click was about.
 */
/*
 * There is no reveal-balance chip.
 *
 * A `RevealBalance` component lived here — an eye, a figure and the words
 * "reveals left", amber below a threshold and red at zero. It had no call site
 * for some time and would not get one now: a balance on screen at all times is
 * a meter a recruiter watches go down, and watching it is not the work. What
 * replaced it is the pair below — nothing at all while the product works, one
 * banner when it stops — and the figure itself on Billing and on Usage, which
 * are the screens for looking at what the organization holds.
 */

/**
 * §11.1 and §11.2 — running low, and run out.
 *
 * Two different states with two different messages, shown once at the top of
 * the workspace rather than repeated on every candidate card. Silent above the
 * threshold: an organization with two hundred reveals does not need reminding
 * that it has them.
 */
function BalanceBanner({ wallet, admin, onBuy }) {
  /*
   * Dismissable, and it stays dismissed until the fact changes.
   *
   * The key carries the balance, so running out, buying a pack and running out
   * again is a NEW fact and says so — while clicking between tabs of the same
   * workspace does not bring back a banner just waved away.
   */
  const [show, dismiss] = useStandingNotice('reveals-exhausted', wallet?.balance === 0)

  if (!wallet || !show) return null

  if (wallet.balance === 0) {
    /*
     * warn, not error, and the same tone the other two standing facts use.
     *
     * As an error it took role="alert" and an assertive live region, which
     * interrupts a screen-reader user mid-sentence to say that a purchase is
     * due — the same shape of news as the two banners beside it.
     */
    return (
      <Notice tone="warn" className="page-banner" onDismiss={dismiss}>
        <strong>No reveals remaining.</strong>
        <p>
          Searching, filtering and shortlisting still work; only opening a candidate's contact
          details is paused.{' '}
          {admin
            /* Names the product and lands on it. It used to say "Billing",
               which is a place rather than an action and opened on whichever
               product Billing happened to default to. */
            ? <><button type="button" className="link-button" onClick={onBuy}>Add reveals</button> to continue.</>
            : 'Your account administrator can add more.'}
        </p>
      </Notice>
    )
  }

  /*
   * Silent at every level above zero.
   *
   * There used to be a second, amber branch here that warned from the loosest
   * configured threshold downwards. That put a banner on screen for the whole
   * tail of a balance's life, and a warning which is nearly always there is one
   * nobody reads by the time it matters. The meter on Usage still says how much
   * is left; this speaks only when something has actually stopped working.
   */
  return null
}

/**
 * A seat subscription about to change, warned about a month ahead.
 *
 * The only dated thing that can happen to a seat plan is a reduction the
 * administrator scheduled: seats renew monthly and otherwise simply continue,
 * so there is no other expiry to warn about. A drop to zero IS the subscription
 * ending, and it reads differently from a drop to two, so it is worded
 * separately.
 *
 * A month ahead rather than on the day, because the thing to do about it —
 * move somebody, or change your mind — takes longer than an afternoon. Silent
 * until then: a warning that is always on screen is one nobody reads.
 */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

function SeatPlanBanner({ seats, admin, onGo }) {
  const due = seats?.pendingFrom ? new Date(seats.pendingFrom).getTime() : null
  const soon = due !== null && Number.isFinite(due) && due - Date.now() <= MONTH_MS

  /* The key still carries the change, because a DIFFERENT scheduled change is a
     different thing to say — unlike the two balance banners, where the only key
     that could ever be written was the exhausted one. */
  const [show, dismiss] = useStandingNotice(
    `seats-${seats?.pending ?? 'none'}-${seats?.pendingFrom ?? ''}`, soon,
  )

  if (seats?.pending === null || seats?.pending === undefined || !soon || !show) return null

  const ending = seats.pending === 0
  /*
   * How many seats are actually going, which is the fact worth leading with —
   * "2 seats expire on 24 September" is a thing to act on in a way that "your
   * subscription drops to 3" is not. One date for all of them, because the plan
   * is a single subscription with one scheduled change rather than a set of
   * separately dated seats; if that ever stops being true this has to say so
   * per date rather than aggregate them into one misleading sentence.
   */
  const going = Math.max(0, (seats.purchased ?? 0) - seats.pending)

  return (
    <Notice tone="warn" className="page-banner" onDismiss={dismiss}>
      <strong>
        {going > 0
          ? `${going} seat${going === 1 ? '' : 's'} ${going === 1 ? 'expires' : 'expire'} on `
          : 'Your seat subscription changes on '}
        {formatSeatDate(seats.pendingFrom)}.
      </strong>
      <p>
        {ending
          ? 'Every additional seat goes with it, and only the administrator account stays.'
          : `You will be on ${seats.pending} additional seat${seats.pending === 1 ? '' : 's'}.`}
        {seats.atRisk?.length > 0 && ` ${seats.atRisk.length} colleague${seats.atRisk.length === 1 ? '' : 's'} would lose access.`}
        {admin
          ? <> <button type="button" className="link-button" onClick={onGo}>Manage seats</button> to change it before then.</>
          : ' Your account administrator can change it until then.'}
      </p>
    </Notice>
  )
}

// ------------------------------------------------------------- messages ---

const DIALOG_TITLES = {
  profile: 'My profile',
  usage: 'Usage',
  billing: 'Billing',
  team: 'Team',
}

/**
 * An account screen, over the workspace.
 *
 * Team, billing and the profile used to replace the main column, which meant
 * checking a seat count cost you the search you were reading — the results are
 * expensive to produce and there is no going back to them without running the
 * search again. Opening over the top leaves the work where it was.
 *
 * Large and scrolling inside itself, because these are full screens rather than
 * confirmations: the header stays put so the way out is still there at the foot
 * of a long billing history.
 */
/**
 * Where a screen inside the dialog can put a control of its own.
 *
 * The alternative was an `actions` prop, which does not work here: the control
 * belongs to the screen — only My profile knows whether it is editing, whether
 * the contact details are settled, and what pressing it should do — while the
 * place it goes belongs to the dialog. Passing it down would mean lifting that
 * whole state up to the workspace so it could be handed back.
 *
 * So the dialog publishes the node and the screen portals into it. Held as
 * state rather than a ref because a ref does not re-render: the first pass has
 * no node yet, and without a render after it arrives the portal never appears.
 */
const DialogActionSlot = createContext(null)

function WorkspaceDialog({ title, onClose, children }) {
  const dialogRef = useDialogFocus()
  const [actionSlot, setActionSlot] = useState(null)
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)

    /* The workspace behind does not scroll — it is exactly one screen — but the
       page does while a dialog is open, and a flick landing on it would move
       the layer underneath. Restored rather than cleared. */
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop workspace-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal workspace-dialog"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head workspace-dialog-head">
          <div className="modal-title"><h2>{title}</h2></div>
          {/* Immediately after the title, because it acts on what the title
              names. The × stays in the corner: it belongs to the dialog rather
              than to the screen inside it, and the distance says so. */}
          <div className="workspace-dialog-actions" ref={setActionSlot} />
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </header>

        <DialogActionSlot.Provider value={actionSlot}>
          <div className="workspace-dialog-body" tabIndex={0}>{children}</div>
        </DialogActionSlot.Provider>
      </div>
    </div>,
    document.body,
  )
}
/**
 * The account block at the foot of the rail, and the menu behind it.
 *
 * My profile, Team and Usage & billing were three of the five items in the
 * rail's navigation, which gave the screens a recruiter visits once a month the
 * same standing as the one they live in. They are all about the account rather
 * than about the work, so they sit behind the account.
 *
 * Team and billing stay administrator-only. A recruiter who cannot buy a seat
 * or read the ledger is not shown that the screens exist — the menu is simply
 * shorter for them rather than carrying items that would refuse.
 */
function AccountMenu({ me, admin, current, onGo }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)

  /*
   * Shared with every other popup, rather than a copy that drifts.
   *
   * The copy this replaces listened for `click` on the whole document and
   * closed on any of them — including clicks on the menu's own items, which
   * worked only because each item closed the menu anyway, and including the
   * press on the button that had just opened it, which is why that button
   * needed a stopPropagation to stay openable at all.
   */
  useDismissOnOutside({
    ref: wrap,
    onDismiss: useCallback(() => setOpen(false), []),
    active: open,
  })

  /*
   * Usage and Billing are two questions, so they are two doors.
   *
   * "How many reveals are left, and who is spending them" is asked weekly by
   * anyone running a team. "What do packs cost and what have we been charged"
   * is asked when somebody is about to spend money. One screen carrying both
   * meant the common question opened the page where the buttons buy things.
   *
   * Usage exists for every seat; only its contents differ. A recruiter sees
   * their own share — "can I reveal this candidate" is a question they face
   * several times a day, and the only way to answer it used to be pressing
   * Reveal and finding out.
   */
  const items = [
    ['profile', 'My profile'],
    ...(admin ? [['team', `Team (${me.colleagues.length})`]] : []),
    ['usage', 'Usage'],
    ...(admin ? [['billing', 'Billing']] : []),
  ]

  return (
    <div className="ws-account-wrap" ref={wrap}>
      {open && (
        <div className="ws-account-menu" role="menu">
          {items.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className={current === key ? 'ws-account-item ws-account-item-on' : 'ws-account-item'}
              onClick={() => { onGo(key); setOpen(false) }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className={open ? 'ws-account ws-account-open' : 'ws-account'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((was) => !was) }}
      >
        <RecruiterAvatar recruiter={me.recruiter} />
        <span className="ws-account-text">
          <strong>
            {me.recruiter.firstName} {me.recruiter.lastName}
            {admin && <span className="seat-tag identity-tag">Admin</span>}
          </strong>
          <span className="muted">{me.recruiter.company}</span>
        </span>
        <span className="ws-account-caret" aria-hidden="true">
          <DockChevron up={!open} />
        </span>
      </button>
    </div>
  )
}
/**
 * Messaging, docked to the bottom right.
 *
 * It was a full tab — a list of conversations beside a reading pane — which
 * made answering a candidate somewhere you navigated to, losing the search you
 * were reading on the way. Docked, a conversation sits over the workspace and
 * both stay in view. Same shape as the candidate portal's, and the same shape
 * as every chat product since: a collapsed bar, a list, and each conversation
 * as its own small window alongside.
 */
const MAX_OPEN_CHATS = 2

function RecruiterMessagingDock({ me = null, threads, reloadThreads, loadError = '' }) {
  const dialogRef = useDialogFocus()
  const [listOpen, setListOpen] = useState(false)
  const [open, setOpen] = useState([])
  const [profileId, setProfileId] = useState(null)
  const [error, setError] = useState('')
  /* A close waiting to be confirmed: { candidateId, name }. Held here rather
     than in the window, because the menu that asks for it is on the list and
     the window may not be open at all. */
  const [pendingClose, setPendingClose] = useState(null)

  const openThread = useCallback((candidateId) => {
    setOpen((current) => (current.includes(candidateId)
      ? current
      : [...current, candidateId].slice(-MAX_OPEN_CHATS)))
  }, [])

  /**
   * Closing takes the candidate's ability to reply away, so it is confirmed.
   * Reopening gives it back and needs no ceremony.
   */
  const setThreadState = useCallback(async (candidateId, action) => {
    const thread = threads.find((row) => row.candidate_id === candidateId)
    if (action === 'close') {
      setPendingClose({ candidateId, name: thread?.display_name ?? 'this candidate' })
      return
    }
    try {
      await post(`/api/hr/threads/${candidateId}/${action}`, {}, 'recruiter')
      await reloadThreads()
    } catch (err) {
      setError(err.message)
    }
  }, [threads, reloadThreads])

  const confirmClose = useCallback(async () => {
    if (!pendingClose) return
    try {
      await post(`/api/hr/threads/${pendingClose.candidateId}/close`, {}, 'recruiter')
      await reloadThreads()
    } catch (err) {
      setError(err.message)
    } finally {
      setPendingClose(null)
    }
  }, [pendingClose, reloadThreads])

  const unread = threads.reduce((total, thread) => total + (thread.unread ?? 0), 0)

  return (
    <>
      <div className="dock">
        {open.map((candidateId) => {
          const summary = threads.find((thread) => thread.candidate_id === candidateId)
          return (
            <RecruiterChatWindow
              key={candidateId}
              candidateId={candidateId}
              summary={summary}
              reloadThreads={reloadThreads}
              onViewProfile={() => setProfileId(candidateId)}
              onSetState={(action) => setThreadState(candidateId, action)}
              onError={setError}
              onClose={() => setOpen((current) => current.filter((id) => id !== candidateId))}
            />
          )
        })}

        <section className={listOpen ? 'dock-panel dock-panel-open' : 'dock-panel'}>
          <header className="dock-head">
            <button
              type="button"
              className="dock-head-toggle"
              aria-expanded={listOpen}
              onClick={() => setListOpen((was) => !was)}
            >
              <span className="dock-title">Messaging</span>
              {unread > 0 && <span className="badge">{unread}</span>}
            </button>
            <button
              type="button"
              className="dock-icon"
              aria-label={listOpen ? 'Collapse messaging' : 'Expand messaging'}
              onClick={() => setListOpen((was) => !was)}
            >
              <DockChevron up={!listOpen} />
            </button>
          </header>

          {listOpen && (
            <div className="dock-body">
              {loadError ? (
                /* Not the empty state: the list could not be read at all. */
                <p className="alert alert-error dock-empty">
                  Your conversations could not be loaded. {loadError}
                </p>
              ) : threads.length === 0 ? (
                <p className="muted dock-empty">
                  Reveal a candidate and message them, and the conversation appears here.
                </p>
              ) : (
                <ul className="dock-list">
                  {threads.map((thread) => (
                    <li key={thread.candidate_id}>
                      {/* Row and menu are siblings: a button inside a button is
                          invalid, and the inner one is what goes dead. */}
                      <div className={thread.unread > 0 ? 'dock-row-wrap dock-row-unread' : 'dock-row-wrap'}>
                      <button
                        type="button"
                        className="dock-row"
                        onClick={() => openThread(thread.candidate_id)}
                      >
                        <CandidateAvatar candidate={{ ...thread, id: thread.candidate_id }} />
                        <span className="dock-row-text">
                          <span className="dock-row-top">
                            <strong>{thread.display_name}</strong>
                            <span className="dock-when">{shortWhen(thread.last_at)}</span>
                          </span>
                          <span className="muted">
                            {thread.last_sender === 'recruiter' && 'You: '}
                            {thread.last_body}
                          </span>
                        </span>
                        {/* The mark itself, on the row it belongs to. The
                            recruiter list only ever bolded the row, so a
                            conversation marked unread was distinguished from a
                            read one by weight alone — and the count that had
                            been sitting on the dock header all along said how
                            many but never which. The candidate list has carried
                            this badge from the start. */}
                        {thread.unread > 0 && <span className="badge">{thread.unread}</span>}
                      </button>

                      <ConversationMenu
                        candidateId={thread.candidate_id}
                        name={thread.display_name}
                        closed={thread.status === 'closed'}
                        onViewProfile={() => setProfileId(thread.candidate_id)}
                        onSetState={(action) => setThreadState(thread.candidate_id, action)}
                        onChanged={() => reloadThreads()}
                        onError={setError}
                      />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Closing stops the candidate replying, so it is asked rather than done.
          Over the dock rather than inside a window, because the menu that asks
          may be on a list row with no window open. */}
      {pendingClose && (
        <div className="modal-backdrop" onClick={() => setPendingClose(null)} role="presentation">
          <div
            className="modal modal-narrow"
            role="dialog"
            aria-modal="true"
            ref={dialogRef}
            tabIndex={-1}
            aria-label="Close this conversation?"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-head">
              <div className="modal-title"><h2>Close this conversation?</h2></div>
            </header>
            <p className="muted">
              {pendingClose.name} keeps everything you have both written, but will not be able to
              reply. You can reopen it at any time.
            </p>
            <div className="danger-actions">
              <button type="button" className="btn btn-primary" onClick={confirmClose}>
                Close it
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setPendingClose(null)}>
                Keep it open
              </button>
            </div>
          </div>
        </div>
      )}

      {profileId !== null && (
        <CandidateDialog
          candidateId={profileId}
          /* Who is reading, so a reveal this account paid for reads "me"
             rather than the reader's own name back at them — the same
             courtesy the search results have always had. */
          meId={me?.recruiter?.id ?? null}
          onClose={() => setProfileId(null)}
          onError={setError}
        />
      )}
    </>
  )
}

/**
 * Everything you can do to a conversation without reading it.
 *
 * One list of actions behind one button, mounted on each row and in the header
 * of an open window. Ordered by consequence: look, then defer, then end, then
 * clear. The last two are separated in colour, because they are the ones you
 * cannot take back with the same click.
 *
 * PopMenu handles where it appears — the dock sits at the bottom of the window
 * inside clipping containers, so the menu has to escape them and open upward.
 */
function ConversationMenu({ candidateId, name, closed, onViewProfile, onSetState, onChanged, onError }) {
  async function act(run) {
    try {
      const data = await run()
      if (data?.threads) onChanged?.(data.threads)
    } catch (err) {
      onError?.(err.message)
    }
  }

  return (
    <PopMenu
      label={`More for ${name}`}
      items={[
        { key: 'profile', label: 'View profile', onSelect: () => onViewProfile?.() },
        {
          key: 'unread',
          label: 'Mark as unread',
          onSelect: () => act(() => post(`/api/hr/threads/${candidateId}/unread`, {}, 'recruiter')),
        },
        /* Closing is mutual: it stops the candidate replying. Clearing is yours
           alone and leaves their copy untouched. Different acts, so they are not
           next to each other by accident. */
        {
          key: 'state',
          label: closed ? 'Reopen conversation' : 'Close conversation',
          danger: true,
          onSelect: () => onSetState?.(closed ? 'reopen' : 'close'),
        },
        /*
         * "Remove from my inbox", not "Delete conversation".
         *
         * The old label promised something the action does not do and was never
         * meant to do: this writes one row to conversation_hidden and touches
         * no message. The other party keeps their copy, and a later message
         * brings the thread back here — behaviour that is right for the reasons
         * set out beside the table in schema.js, and that a person who read the
         * word "Delete" would have no way to predict.
         *
         * The behaviour is the considered one. The label was the part that was
         * wrong, so the label is the part that changed.
         */
        {
          key: 'delete',
          label: 'Remove from my inbox',
          danger: true,
          onSelect: () => act(() => del(`/api/hr/threads/${candidateId}`, 'recruiter')),
        },
      ]}
    />
  )
}

function DockChevron({ up = false }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <path d={up ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  )
}

/**
 * One conversation, in its own window.
 *
 * Loads and polls its own thread: two can be open at once, and a single thread
 * held in the dock would mean the second to open overwrote the first.
 *
 * Closing and reopening stay here rather than moving to a menu. They are the
 * recruiter's power over the conversation, not over the window, and the two are
 * easy to confuse when both live in the same title bar — which is why the
 * destructive one keeps its confirmation.
 */
function RecruiterChatWindow({
  candidateId, summary, reloadThreads, onViewProfile, onSetState, onError, onClose,
}) {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('open')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [minimised, setMinimised] = useState(false)

  const load = useCallback(async () => {
    const data = await get(`/api/hr/threads/${candidateId}`, 'recruiter')
    setMessages(data.messages)
    setStatus(data.status)
    return data
  }, [candidateId])

  useEffect(() => {
    let live = true
    setLoading(true)
    load()
      // The GET clears the unread flags, so the badges have to be refetched.
      .then(() => live && reloadThreads().catch(() => {}))
      .catch((err) => live && onError?.(err.message))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [load, reloadThreads, onError])

  async function send(body) {
    setSending(true)
    try {
      const result = await post(`/api/hr/threads/${candidateId}`, { body }, 'recruiter')
      setMessages(result.messages)
      setStatus(result.status)
      await reloadThreads()
    } catch (err) {
      onError?.(err.message)
    } finally {
      setSending(false)
    }
  }


  /* The dock owns closing now, so the window follows the list rather than
     its own last response — otherwise a close from the list would leave an
     open window still offering a composer. */
  const closed = (summary?.status ?? status) === 'closed'
  const name = summary?.display_name ?? 'Conversation'

  return (
    <section className={minimised ? 'chat-window chat-window-min' : 'chat-window'}>
      <header className="chat-window-head">
        <CandidateAvatar candidate={{ ...(summary ?? {}), id: candidateId }} />
        {/*
          The name opens the person, not the window.
          
          It used to toggle minimise, which meant the one thing on the bar that
          reads as a link to somebody — their name — did the same job as the
          chevron beside it, and there was no way to reach the profile except
          through the menu. Managing the window is what the chevron is for, and
          it is still there.
        */}
        <button
          type="button"
          className="chat-window-title"
          title={`View ${name}'s profile`}
          onClick={onViewProfile}
        >
          <strong>{name}</strong>
          <span className="muted">
            {closed ? 'Closed' : [summary?.location, summary?.availability].filter(Boolean).join(' · ')}
          </span>
        </button>
        {/* The same four actions the list row offers, so which of them you can
            reach no longer depends on whether the conversation is open. */}
        <ConversationMenu
          candidateId={candidateId}
          name={name}
          closed={closed}
          onViewProfile={onViewProfile}
          onSetState={onSetState}
          onChanged={() => reloadThreads()}
          onError={onError}
        />
        <button
          type="button" className="dock-icon"
          aria-label={minimised ? `Expand conversation with ${name}` : `Minimise conversation with ${name}`}
          onClick={() => setMinimised((was) => !was)}
        >
          <DockChevron up={minimised} />
        </button>
        <button
          type="button" className="dock-icon" aria-label={`Close conversation with ${name}`}
          onClick={onClose}
        >
          &times;
        </button>
      </header>

      {!minimised && (
        <>
          {/* The strip of buttons that used to be here is gone: everything it
              held is in the window's own menu now, beside the same four
              actions the list offers. */}
          {closed && (
            <p className="alert alert-muted chat-window-note">
              Closed. Neither of you can send until you reopen it.
            </p>
          )}

          <ChatPanel
            messages={messages}
            meSender="recruiter"
            onSend={send}
            sending={sending}
            disabled={closed}
            emptyText={loading ? 'Loading the conversation…' : 'No messages yet.'}
            placeholder={`Message ${name}…`}
          />
        </>
      )}
    </section>
  )
}

/** Today shows a time, this year a day and month, anything older adds the year. */
function shortWhen(iso) {
  if (!iso) return ''
  const at = new Date(iso)
  const now = new Date()

  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return at.toLocaleDateString(DATE_LOCALE, at.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Administrator-only: the roster, the seat count, and an editor for each member. */
function TeamTab({ me, onSaved, onManageSeats, admin = true }) {
  /*
   * Held by id, not by row.
   *
   * The dialog stays open after a save and has to show what was just saved, so
   * it cannot be looking at a copy taken when it opened. Reading the person out
   * of the list each render means the reload that follows a save is also what
   * refreshes the dialog.
   */
  const [editingId, setEditingId] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const editingPerson = me.colleagues.find((person) => person.id === editingId) ?? null
  const [adding, setAdding] = useState(false)

  const seats = me.seats ?? {
    occupied: me.colleagues.length, total: me.colleagues.length, available: 0,
    included: me.colleagues.length, purchased: 0, monthly: 0, formattedMonthly: '',
  }
  const full = seats.available === 0

  return (
    <div className="panel panel-narrow">
      <header className="panel-head">
        <h2>{me.recruiter.company}</h2>
        <p className="muted">
          You create every recruiter account here. Nobody can sign themselves up. Folders and
          conversations stay private to each person; you manage their names and photos, not their
          work. Everyone signs in with the company key <strong>{me.recruiter.joinKey}</strong>.
        </p>
      </header>

      {/*
        §11.4 — capacity, as a count over the list it is counting.

        It was a sentence — "2 of 3 seats in use (1 included, 2 purchased). 1
        still free." — which spelled out four numbers to say one thing. Taken
        and total are the only two that answer "can I add somebody", and where
        the seats came from is billing's business, on billing's screen.

        The full case keeps its words, because there the answer is no and the
        way out of it is worth a sentence.
      */}
      <p className="team-seats" title={`${seats.occupied} of ${seats.total} seats in use`}>
        <strong>{seats.occupied}/{seats.total}</strong>
        <span className="muted"> seats</span>
      </p>

      {/*
        A reduction that has been asked for and not yet happened.

        The monthly price and the seat count that used to sit here have gone to
        the billing screen, which is where a bill belongs. This one stays,
        because it is not a price: it is a warning that accounts are scheduled
        for deletion, and somebody reading the seat count above needs to know
        one of them is leaving. The month is not refunded, so the seats stay
        usable until the day named.
      */}
      {seats.pending !== null && seats.pending !== undefined && (
        <p className="seat-plan-pending">
          {seats.pending === 0
            ? 'Cancelled: your seats stay until '
            : `Reducing to ${seats.pending} additional seat${seats.pending === 1 ? '' : 's'} on `}
          <strong>{formatSeatDate(seats.pendingFrom)}</strong>
          {seats.atRisk?.length > 0
            ? `, when ${seats.atRisk.length === 1
              ? `${seats.atRisk[0].name}'s account will be deleted`
              : `these accounts will be deleted: ${seats.atRisk.map((p) => p.name).join(', ')}`}`
              + ' unless you remove someone first.'
            : seats.pending === 0 ? ', then only your own account remains.' : '.'}
        </p>
      )}

      <ul className="team-list">
        {me.colleagues.map((person) => (
          <li key={person.id}>
            <RecruiterAvatar
              recruiter={{
                id: person.id,
                firstName: person.first_name,
                lastName: person.last_name,
                hasPhoto: Boolean(person.has_photo),
                photoVersion: person.photo_version,
              }}
            />
            <strong>{person.first_name} {person.last_name}</strong>
            {Boolean(person.is_org_admin) && <span className="seat-tag">Admin</span>}
            {person.id === me.recruiter.id && <span className="muted">(you)</span>}
            <span className="muted">{person.username}</span>
            <span className="muted">joined {new Date(person.created_at).toLocaleDateString()}</span>
            <span className="team-actions">
              {/*
                Not on your own row. Your account has a screen of its own — My
                profile — which does more than this dialog can: it is where your
                email and phone number are changed, and where you change your
                own password rather than reset somebody else's. Two doors onto
                one account, one of them narrower, is a way of finding the wrong
                one.
              */}
              {person.id !== me.recruiter.id && (
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() => setEditingId(person.id)}
                >
                  Edit profile
                </button>
              )}
              {/* Deleting yourself would leave the company with no
                  administrator, so it is not offered. */}
              {person.id !== me.recruiter.id && (
                <button
                  type="button"
                  className="btn btn-quiet btn-small btn-danger"
                  onClick={() => setDeleting(person)}
                >
                  Delete
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>


      {/* Under the list and ranged right, where a list's actions belong: both
          are things you do after reading who is already here, and a button
          above a list reads as something to press before you have looked.
          Changing the plan sits left of adding somebody, being the rarer of
          the two errands. */}
      <div className="team-footer">
        {admin && (
          <button type="button" className="btn btn-secondary" onClick={onManageSeats}>
            {seats.purchased === 0 ? 'Add seats' : 'Change plan'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={full}
          onClick={() => setAdding(true)}
        >
          Add recruiter
        </button>
      </div>

      {full && (
        <p className="alert alert-warn">
          Every seat is taken: <button type="button" className="link-button" onClick={onManageSeats}>add
          a seat to your subscription</button> before creating another account.
        </p>
      )}

      {editingPerson && (
        <ProfileDialog
          person={editingPerson}
          company={me.recruiter.company}
          onClose={() => setEditingId(null)}
          /* Reloads, and leaves the dialog where it is: the confirmation and
             the updated rows are both inside it. */
          onSaved={onSaved}
        />
      )}

      {deleting && (
        <DeleteRecruiterDialog
          person={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => { setDeleting(null); await onSaved?.() }}
        />
      )}

      {adding && (
        <AddRecruiterDialog
          company={me.recruiter.company}
          joinKey={me.recruiter.joinKey}
          onClose={() => setAdding(false)}
          onCreated={onSaved}
        />
      )}
    </div>
  )
}

/**
 * Creating a colleague's account. The administrator sets the password, because
 * there is no mail provider wired up for an invite link to go through — so the
 * dialog ends by showing exactly what has to be passed on.
 */
function AddRecruiterDialog({ company, joinKey, onClose, onCreated }) {
  const dialogRef = useDialogFocus()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [proofs, setProofs] = useState({ email: '', phone: '' })
  const [photo, setPhoto] = useState(null)
  const [preview, setPreview] = useState(null)
  const photoInput = useRef(null)

  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /* Blank or proved. Both are fine; typed-and-unproved is the one state that
     must not be submitted, and the server refuses it too. */
  const unverified = [
    email.trim() && !proofs.email ? 'email address' : null,
    phone.trim() && !proofs.phone ? 'phone number' : null,
  ].filter(Boolean)
  const contactsSettled = unverified.length === 0

  useEffect(() => {
    if (!photo) { setPreview(null); return undefined }
    const url = URL.createObjectURL(photo)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* A name, and nothing half-verified. */
  const ready = Boolean(firstName.trim() && lastName.trim()) && contactsSettled

  async function submit(event) {
    event.preventDefault()
    if (!ready) return

    setBusy(true)
    setError('')
    try {
      const form = new FormData()
      form.append('firstName', firstName)
      form.append('lastName', lastName)
      if (email.trim()) {
        form.append('email', email)
        form.append('emailProof', proofs.email)
      }
      if (phone.trim()) {
        form.append('phone', phone)
        form.append('phoneProof', proofs.phone)
      }
      if (photo) form.append('photo', photo)

      const result = await sendForm('/api/recruiter', form, { role: 'recruiter' })
      setCreated(result.created)
      await onCreated?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label="Add a recruiter"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-title">
            <h2>{created ? 'Account created' : 'Add a recruiter'}</h2>
            <p className="muted">{company}</p>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">&times;</button>
        </header>

        {created ? (
          <div className="modal-body">
            <p className="alert alert-ok">
              <strong>{created.name}</strong> can sign in now. Send them these three things.
            </p>

            <dl className="facts">
              <Fact label="Company key" value={created.joinKey} />
              <Fact label="Username" value={created.username} />
              <Fact label="Starting password" value={created.password} />
            </dl>

            <p className="field-hint">
              The starting password is always their username followed by 123, so you can always
              work it out. Ask them to change it from My profile once they are in; you can reset
              it back to this from Edit profile if they forget.
            </p>

            <div className="convo-confirm-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <form className="modal-body profile-form" onSubmit={submit}>
            <StatusNotice error={error} onDismiss={() => setError('')} />

            {/* The same photo block as every other profile on the site: a
                centred frame that is itself the control, and the formats
                underneath. Three screens now ask for one picture and there is
                no reason for this one to ask differently. */}
            <div className="profile-photo-block">
              <div className="photo-row">
                <button
                  type="button"
                  className="avatar avatar-editable"
                  onClick={() => photoInput.current?.click()}
                  aria-label={photo ? 'Replace profile picture' : 'Add a profile picture'}
                >
                  {preview
                    ? <img src={preview} alt="" />
                    : <span className="avatar-empty"><AddPhotoIcon size={28} /></span>}
                </button>
                <input
                  ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                      setError('The photo must be a JPG, PNG or WebP image.')
                      return
                    }
                    setError('')
                    setPhoto(file)
                  }}
                />
                <div className="photo-copy">
                  <span className="photo-formats"><Req />JPG, PNG or WebP</span>
                  <div className="photo-actions">
                    {photo && (
                      <button
                        type="button" className="btn btn-quiet btn-small"
                        onClick={() => setPhoto(null)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label className="field-label" htmlFor="new-first">First name<Req /></label>
                <input id="new-first" required autoFocus value={firstName}
                  onChange={(e) => setFirstName(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="new-last">Last name<Req /></label>
                <input id="new-last" required value={lastName}
                  onChange={(e) => setLastName(e.target.value)} />
              </div>
            </div>

            {/*
              Optional, and proved when given.

              Left blank the account still works — the person adds their own
              details from their profile — so an administrator setting somebody
              up in a hurry is not held up by a phone number they have not been
              given. Filled in, it is verified by a code to the address itself,
              because an unproved address on a colleague's account is one nobody
              will discover is wrong until a reset link goes to it.
            */}
            <VerifiedField
              channel="email"
              id="new-email"
              label="Email"
              type="email"
              value={email}
              proof={proofs.email}
              verified={Boolean(proofs.email)}
              onChange={(value) => setEmail(value)}
              onProof={(proof) => setProofs((prev) => ({ ...prev, email: proof }))}
              disabled={busy}
              optional
            />

            <VerifiedField
              channel="phone"
              id="new-phone"
              label="Phone number"
              type="tel"
              value={phone}
              proof={proofs.phone}
              verified={Boolean(proofs.phone)}
              onChange={(value) => setPhone(value)}
              onProof={(proof) => setProofs((prev) => ({ ...prev, phone: proof }))}
              disabled={busy}
              optional
            />

            {!contactsSettled && (
              <p className="field-hint contacts-pending">
                Verify the {unverified.join(' and ')} to create this account, or leave
                {unverified.length === 1 ? ' it' : ' them'} blank.
              </p>
            )}

            <p className="field-hint">
              Their username is generated from their name, and their starting password is that
              username followed by 123. They sign in with the company key{' '}
              <strong>{joinKey}</strong>. You will see both on the next screen.
            </p>

            <div className="convo-confirm-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
                {busy ? 'Creating…' : 'Create account'}
              </button>
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

/**
 * Resetting a colleague's password to the default.
 *
 * The current one is deliberately not shown, and cannot be: passwords are
 * stored as salted scrypt hashes, so nothing on the server can turn one back
 * into text. Resetting is the only action offered — choosing a password for
 * someone means knowing one they are likely to keep, while the default is
 * already derivable from their name and meant to be replaced.
 */
function PasswordReset({ person }) {
  const [issued, setIssued] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function reset() {
    setBusy(true)
    setError('')
    try {
      const result = await patch(`/api/recruiter/${person.id}/password`, {}, 'recruiter')
      setIssued(result.password)
      setConfirming(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="password-block">
      <h4 className="modal-subhead">Password</h4>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      {issued ? (
        <p className="alert alert-ok">
          Reset to <strong>{issued}</strong>. Send it to {person.first_name}, and ask them to
          change it from My profile.
        </p>
      ) : (
        <p className="field-hint">
          Their current password cannot be displayed: it is stored as a one-way hash, so nobody,
          including you, can read it back. Resetting sets it to their username followed
          by 123: <strong>{`${person.username}123`}</strong>. They can change it from My profile
          once they are signed in.
        </p>
      )}

      {confirming ? (
        <div className="alert alert-warn convo-confirm">
          <p>
            Reset {person.first_name} {person.last_name}'s password to{' '}
            <strong>{`${person.username}123`}</strong>? Their current one stops working
            immediately.
          </p>
          <div className="convo-confirm-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={reset}>
              {busy ? 'Resetting…' : 'Reset it'}
            </button>
            <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button" className="btn btn-secondary btn-small btn-self-start"
          onClick={() => { setIssued(null); setConfirming(true) }}
        >
          Reset to the default password
        </button>
      )}
    </div>
  )
}

/**
 * Deleting a colleague. The preview is fetched rather than guessed from the
 * team list, so the numbers are the ones the server is actually about to act
 * on, and the username has to be typed back before the button works.
 */
function DeleteRecruiterDialog({ person, onClose, onDeleted }) {
  const dialogRef = useDialogFocus()
  const [preview, setPreview] = useState(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    get(`/api/recruiter/${person.id}/deletion-preview`, 'recruiter')
      .then(setPreview)
      .catch((err) => setError(err.message))
  }, [person.id])

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function remove() {
    setBusy(true)
    setError('')
    try {
      await del(`/api/recruiter/${person.id}`, 'recruiter', { confirm: typed.trim() })
      await onDeleted?.()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label={`Delete ${person.username}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-title">
            <h2>Delete {person.first_name} {person.last_name}?</h2>
            <p className="muted">{person.username}</p>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">&times;</button>
        </header>

        <div className="modal-body">
          <StatusNotice error={error} onDismiss={() => setError('')} />

          <p className="alert alert-warn">
            This cannot be undone. Their seat is freed, so someone else can register with the
            company key.
          </p>

          {preview && (
            <>
              <h4 className="modal-subhead">Permanently deleted</h4>
              <ul className="delete-list">
                <li>{preview.folders} folder{preview.folders === 1 ? '' : 's'}</li>
                <li>
                  {preview.conversations} conversation{preview.conversations === 1 ? '' : 's'}
                  {' '}with candidates ({preview.messages} message{preview.messages === 1 ? '' : 's'})
                </li>
                <li>{preview.savedSearches} saved search{preview.savedSearches === 1 ? '' : 'es'}</li>
              </ul>

              <h4 className="modal-subhead">Kept</h4>
              <ul className="delete-list">
                <li>
                  {preview.downloads} CV download{preview.downloads === 1 ? '' : 's'} on the
                  company's billing record
                </li>
                <li>The candidate-facing view history, with their name on it</li>
              </ul>
            </>
          )}

          <div className="field">
            <label className="field-label" htmlFor={`confirm-${person.id}`}>
              Type <strong>{person.username}</strong> to confirm
            </label>
            <input
              id={`confirm-${person.id}`}
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>

          <div className="convo-confirm-actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || typed.trim() !== person.username}
              onClick={remove}
            >
              {busy ? 'Deleting…' : 'Delete this account'}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The same editor as My profile, in a modal, pointed at a colleague. */
function ProfileDialog({ person, company, onClose, onSaved }) {
  const dialogRef = useDialogFocus()
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label={`Edit ${person.first_name} ${person.last_name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          {/* The name alone. Username, company and role are all rows in the
              list below, and repeating two of them in the header made the
              first thing on screen a summary of the second. */}
          <div className="modal-title">
            <h2>{person.first_name} {person.last_name}</h2>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">&times;</button>
        </header>

        <div className="modal-body">
          {/*
            Laid out as My profile, because it is the same thing seen from the
            other side: one person's account, read first and edited on purpose.
            An administrator who has just set their own photo should not have to
            learn a second arrangement to set somebody else's.

            The one difference is the password. Nobody can read another person's
            back — it is a one-way hash — so where My profile offers to change
            one, this offers to reset it to a value the administrator can pass
            on. That block is unchanged.
          */}
          <RecruiterProfileForm
            person={{
              id: person.id,
              firstName: person.first_name,
              lastName: person.last_name,
              username: person.username,
              company,
              email: person.email ?? '',
              phone: person.phone ?? '',
              website: person.website ?? '',
              joined: person.created_at,
              hasPhoto: Boolean(person.has_photo),
              photoVersion: person.photo_version,
              isOrgAdmin: Boolean(person.is_org_admin),
            }}
            onSaved={onSaved}
          />

          <PasswordReset person={person} />
        </div>
      </div>
    </div>
  )
}

// ----------------------------------------------------------- my profile ---

/**
 * Every recruiter's own account. Name and username are shown but not editable
 * — the administrator owns those — while the photo and password belong to the
 * account holder.
 */
/** Renders its child into the dialog's header, or in place when there is none. */
function DialogAction({ children }) {
  const slot = useContext(DialogActionSlot)
  if (!slot) return <div className="form-lock-bar">{children}</div>
  return createPortal(children, slot)
}

function MyProfileTab({ me, onSaved }) {
  const person = me.recruiter

  const [photo, setPhoto] = useState(null)
  const [preview, setPreview] = useState(null)
  const photoInput = useRef(null)

  /* The company's mark. Held apart from the portrait because it is saved by a
     different route under a different permission. */
  const [logo, setLogo] = useState(null)
  const [logoPreview, setLogoPreview] = useState(null)
  const [logoCleared, setLogoCleared] = useState(false)
  const logoInput = useRef(null)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwNotice, setPwNotice] = useState('')
  /* Shut on arrival: nobody opens their profile in order to change a password
     without knowing they came to do it. */
  const [pwOpen, setPwOpen] = useState(false)

  const [error, setError] = useState('')

  /*
   * Locked by default: this is a profile, and only sometimes a form.
   *
   * The same arrangement as the candidate portal, and for the same reason —
   * somebody opening their profile is nearly always here to read something, and
   * a page of live inputs invites an accidental edit to answer a question.
   */
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState('')
  const [draft, setDraft] = useState(null)
  const [proofs, setProofs] = useState({ email: '', phone: '' })
  /* Removing a photo waits for the tick, so one press commits everything the
     pencil opened and nothing happens behind it. */
  const [photoCleared, setPhotoCleared] = useState(false)

  const field = (key) => draft?.[key] ?? ''

  const unchanged = {
    email: field('email').trim().toLowerCase() === (person.email ?? '').trim().toLowerCase(),
    phone: field('phone').replace(/\D/g, '') === (person.phone ?? '').replace(/\D/g, ''),
  }
  /*
   * Settled means: untouched since it was put on the account, or proved just
   * now. The tick reads it to decide whether saving is allowed, and the field
   * reads the same value to decide whether to show the green Verified mark —
   * one answer, so the two can never disagree.
   *
   * They did disagree. The field used to be told "verified" through a separate
   * flag that only flipped when the person pressed "use a different address" —
   * and making the field directly typeable removed that button, so the flag was
   * never set and the flow never came back. Somebody typed a new number, passed
   * the code, and the field still offered to verify what it had just verified.
   */
  const emailSettled = unchanged.email || Boolean(proofs.email)
  const phoneSettled = unchanged.phone || Boolean(proofs.phone)
  const unverified = [
    emailSettled ? null : 'email address',
    phoneSettled ? null : 'phone number',
  ].filter(Boolean)
  const contactsSettled = emailSettled && phoneSettled

  useEffect(() => {
    if (!photo) { setPreview(null); return undefined }
    const url = URL.createObjectURL(photo)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  const stored = person.hasPhoto
    ? withToken(`/api/recruiter/${person.id}/photo?v=${person.photoVersion ?? ''}`, 'recruiter')
    : null
  const shown = preview ?? stored

  /* Sends the picture and nothing else. Errors are left to the caller, which is
     saving several things at once and has to stop rather than carry on. */
  /*
   * Only an administrator may set it — and the server says so too.
   *
   * This decides whether the frame is a button; PATCH /api/company/logo is
   * gated on orgAdminOnly regardless, so a colleague who reached the request
   * another way is refused there rather than here. A non-admin still SEES the
   * logo: it is their company.
   */
  const canSetLogo = Boolean(person.isOrgAdmin)
  const storedLogo = me.company?.hasLogo
    ? withToken(`/api/company/logo?v=${me.company.logoVersion ?? ''}`, 'recruiter')
    : null
  const shownLogo = logoPreview ?? (logoCleared ? null : storedLogo)

  /*
   * Whether the company's half of the header is on screen at all.
   *
   * One expression, read twice — by the block that draws it and by the class
   * that lays it out. They were two separate conditions and they disagreed: the
   * block appeared whenever `shownLogo || editing`, the banner class only when
   * `shownLogo`. So pressing the pencil with no logo set drew the block WITHOUT
   * the banner layout, which is the old side-by-side row — an empty rectangle
   * beside the portrait, nothing like the header it had just replaced.
   *
   * Whenever this is true the layout is the banner. There is no other shape.
   */
  const showLogoBlock = Boolean(shownLogo) || editing

  async function sendLogo(remove) {
    const form = new FormData()
    if (remove) form.append('removeLogo', 'true')
    else form.append('logo', logo)
    await sendForm('/api/company/logo', form, { method: 'PATCH', role: 'recruiter' })
  }

  async function sendPhoto(remove) {
    const form = new FormData()
    if (remove) form.append('removePhoto', 'true')
    else form.append('photo', photo)
    await sendForm('/api/recruiter/me/photo', form, { method: 'PATCH', role: 'recruiter' })
  }

  function startEditing() {
    setDraft({
      firstName: person.firstName ?? '',
      lastName: person.lastName ?? '',
      email: person.email ?? '',
      phone: person.phone ?? '',
      website: person.website ?? '',
    })
    setProofs({ email: '', phone: '' })
    setPhoto(null)
    setPhotoCleared(false)
    setError('')
    setSavedNotice('')
    setEditing(true)
  }

  /**
   * One press saves everything the form is holding.
   *
   * The photo has its own route because it travels as multipart, so a save that
   * includes a new picture is two calls. Photo first: if that fails there is
   * nothing to undo, whereas saving the fields and then failing on the picture
   * would leave the page reporting a success it only half had.
   */
  async function saveProfile() {
    setSaving(true)
    setError('')
    try {
      if (photoCleared) await sendPhoto(true)
      else if (photo) await sendPhoto(false)

      /* The logo travels on the same tick, and only when this recruiter is
         allowed to move it — the server refuses either way, but sending a
         request that is going to be refused is not something to do on somebody
         else's press of Save. */
      if (canSetLogo) {
        if (logoCleared) await sendLogo(true)
        else if (logo) await sendLogo(false)
      }

      await patch('/api/recruiter/me', {
        firstName: draft.firstName,
        lastName: draft.lastName,
        email: draft.email,
        phone: draft.phone,
        website: draft.website,
        emailProof: proofs.email,
        phoneProof: proofs.phone,
      }, 'recruiter')

      await onSaved?.()
      setEditing(false)
      setDraft(null)
      setPhoto(null)
      setPhotoCleared(false)
      setProofs({ email: '', phone: '' })
      setSavedNotice('Your profile has been updated.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function savePassword(event) {
    event.preventDefault()
    setPwBusy(true)
    setError('')
    setPwNotice('')
    try {
      await patch('/api/recruiter/me/password', {
        currentPassword: current, newPassword: next, confirmPassword: confirm,
      }, 'recruiter')
      setCurrent(''); setNext(''); setConfirm('')
      setPwNotice('Your password has been changed.')
    } catch (err) {
      setError(err.message)
    } finally {
      setPwBusy(false)
    }
  }

  return (
    <div className="panel panel-narrow">
      {/*
        No heading of its own: the dialog this opens in is already titled "My
        profile", and a page that says its own name twice is telling you
        something you asked for by clicking.
      */}
      {/*
        The pencil, top right, exactly as on the candidate profile.

        Always type="button", and saving is called directly rather than left to
        a form's default action — a button whose type changes on click gets its
        new type's default action run by the same click, which is how the
        candidate portal's pencil once unlocked the form and instantly submitted
        it. See the note on CandidateForm's lock bar.
      */}
      {/*
        The company's mark across the top, and the person on it.

        Full-bleed rather than a frame in a row: the logo is the one thing on
        this dialog that belongs to the organization rather than to the
        recruiter, and running it to both edges says so without a label. It
        also fills the band of white the dialog opened with — that white was
        there because the tallest thing in the first row was a 120px picture,
        in a card 980px wide.

        Negative margins cancel .workspace-dialog-body's padding exactly, and
        the 640px media query that changes that padding changes these with it.

        Only when there IS a logo. With none, this falls back to the row it was
        — a banner needs a picture, and an empty tinted band at the top of a
        dialog is a loading state that never finishes.
      */}
      <div className={showLogoBlock ? 'profile-identity profile-identity-banner' : 'profile-identity'}>
      {showLogoBlock && (
      <div className="profile-logo">
        {editing && canSetLogo ? (
          <button
            type="button"
            className="avatar avatar-rect avatar-editable"
            onClick={() => logoInput.current?.click()}
            aria-label={shownLogo ? 'Replace the company logo' : 'Add a company logo'}
          >
            {shownLogo
              ? <img src={shownLogo} alt="" />
              : <span className="avatar-empty"><AddPhotoIcon size={24} /></span>}
          </button>
        ) : (
          <span className="avatar avatar-rect">
            {shownLogo
              ? <img src={shownLogo} alt="" />
              : <span className="avatar-empty muted">—</span>}
          </span>
        )}

        <input
          ref={logoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
              setError('The logo must be a JPG, PNG or WebP image.')
              return
            }
            setError('')
            setLogoCleared(false)
            setLogo(file)
            setLogoPreview(URL.createObjectURL(file))
          }}
        />

        {editing && canSetLogo && (shownLogo || logo) && (
          <div className="photo-actions">
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={saving}
              onClick={() => { setLogo(null); setLogoPreview(null); setLogoCleared(true) }}
            >
              Remove
            </button>
          </div>
        )}

        {editing && !canSetLogo && (
          <span className="muted photo-formats">Only the administrator can change this.</span>
        )}
      </div>
      )}

      <div className="profile-photo-block">
        <div className="photo-row">
          {/* A picture, not a button, while the profile is locked: there is
              nothing to press, so it should not look pressable. */}
          {editing ? (
            <button
              type="button"
              className="avatar avatar-editable"
              onClick={() => photoInput.current?.click()}
              aria-label={shown ? 'Replace profile picture' : 'Add a profile picture'}
            >
              {shown ? <img src={shown} alt="" /> : <span className="avatar-empty"><AddPhotoIcon size={28} /></span>}
            </button>
          ) : (
            <span className="avatar">
              {/* Not editing: nothing to press, so the silhouette states what
                  is there rather than instructing. */}
              {shown ? <img src={shown} alt="" /> : <span className="avatar-empty"><PersonIcon size={30} /></span>}
            </span>
          )}
          <input
            ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                setError('Your photo must be a JPG, PNG or WebP image.')
                return
              }
              setError('')
              setPhotoCleared(false)
              setPhoto(file)
            }}
          />
          {/*
            Remove first, then the caption.

            The logo column beside this one is [frame][Remove], so putting the
            format note above the button left the two Removes on different lines
            — the eye reads across, finds a caption where the other column has a
            control, and the pair stops looking like a pair. The note is the
            quietest thing here and belongs last.
          */}
          {editing && (
            <div className="photo-copy">
              {/* No "Choose photo" button: the frame itself is the control, and
                  two ways to open the same file picker sitting side by side
                  read as two different things. */}
              <div className="photo-actions">
                {(person.hasPhoto || photo) && !photoCleared && (
                  <button
                    type="button" className="btn btn-quiet btn-small"
                    onClick={() => { setPhoto(null); setPhotoCleared(true) }}
                  >
                    Remove
                  </button>
                )}
                {photoCleared && (
                  <button
                    type="button" className="btn btn-quiet btn-small"
                    onClick={() => setPhotoCleared(false)}
                  >
                    Keep my photo
                  </button>
                )}
              </div>
              <span className="photo-formats"><Req />JPG, PNG or WebP</span>
            </div>
          )}
        </div>
      </div>
      </div>

      <StatusNotice error={error} onDismiss={() => setError('')} />
      {savedNotice && !editing && <p className="alert alert-ok">{savedNotice}</p>}

      {/*
        The pencil, in the dialog's header rather than in the page under it.

        It was a row of its own between the photograph and the first field,
        which cost a line of vertical space to hold one 28px button and put the
        control that unlocks the form a long way from the form. In the header it
        sits beside the ×, where the other thing you can do to this dialog
        already is — and the ✓ that replaces it while editing inherits the
        position, so saving is where editing was.

        Portalled, not moved: the state behind it is this component's. The
        fallback renders it in place, so the screen still works if it is ever
        drawn outside a dialog.
      */}
      <DialogAction>
        <button
          type="button"
          className="icon-button"
          aria-pressed={editing}
          disabled={saving || (editing && !contactsSettled)}
          aria-label={editing ? 'Save my profile' : 'Edit my profile'}
          title={!editing ? 'Edit'
            : contactsSettled ? 'Save'
              : `Verify your new ${unverified.join(' and ')} first`}
          onClick={() => { if (editing) saveProfile(); else startEditing() }}
        >
          {editing ? <TickIcon /> : <PencilIcon />}
        </button>
      </DialogAction>

      {/*
        The order is who you are, then how to reach you, then a door.

        The page used to open on two meters — reveals left, seats in use — which
        are facts about the organization's balance rather than about the person
        whose profile this is. They are what Usage & billing exists to show, and
        putting them first meant the answer to "what is my username" was below
        the fold on a page called My profile.

        The photo needs no label either. A round frame at the top of a profile
        holding a silhouette is not ambiguous, and the line beneath names the
        formats.
      */}
      {/*
        The person, and the company they are from.

        Two pictures, two owners, two permissions: the portrait is this
        recruiter's and they may always change it; the logo is the
        organization's and only an administrator may. Both are drawn for
        everybody — a colleague who cannot change the logo still works here —
        and only the control behind the rectangle is gated.
      */}

      {/*
        One list, read the same way all the way down — and the same list turned
        into fields when the pencil is pressed.

        Username, company, company key and role are absent from the editable
        half on purpose: the first is a credential, and the rest are facts about
        the organization that only an administrator can change.
      */}
      {editing ? (
        <div className="profile-edit">
          <div className="grid-2">
            <div className="field">
              <label className="field-label" htmlFor="me-first">First name<Req /></label>
              <input
                id="me-first" value={field('firstName')} disabled={saving}
                onChange={(e) => setDraft((prev) => ({ ...prev, firstName: e.target.value }))}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="me-last">Last name<Req /></label>
              <input
                id="me-last" value={field('lastName')} disabled={saving}
                onChange={(e) => setDraft((prev) => ({ ...prev, lastName: e.target.value }))}
              />
            </div>
          </div>

          <VerifiedField
            channel="email"
            id="me-email"
            label="Email"
            type="email"
            value={field('email')}
            proof={proofs.email}
            // What is on file was proved when it was put there, so an untouched
            // address counts as verified even with no proof in hand for it.
            verified={emailSettled}
            onChange={(value) => setDraft((prev) => ({ ...prev, email: value }))}
            onProof={(proof) => setProofs((prev) => ({ ...prev, email: proof }))}
            disabled={saving}
            /*
              Typed into directly. VerifiedField locks a verified value behind a
              "use a different address" button by default, which is right at
              sign-up — the value there was proved seconds ago and a stray
              keystroke would silently unprove it. Here the pencil has already
              been pressed, so the intent to edit is not in doubt, and a field
              that looks like a field should behave like one. The tick still
              refuses to save until anything changed has been verified.
            */
            lockWhenVerified={false}
          />

          <VerifiedField
            channel="phone"
            id="me-phone"
            label="Phone number"
            type="tel"
            value={field('phone')}
            proof={proofs.phone}
            verified={phoneSettled}
            onChange={(value) => setDraft((prev) => ({ ...prev, phone: value }))}
            onProof={(proof) => setProofs((prev) => ({ ...prev, phone: proof }))}
            disabled={saving}
            lockWhenVerified={false}
          />

          {/*
            Editable although it was not asked for, because the save would fail
            without it: the server requires all three contact details together,
            so an account created by an administrator — which starts with none —
            could never be saved at all if the website were read-only.
          */}
          <div className="field">
            <label className="field-label" htmlFor="me-website">Website<Req /></label>
            <input
              id="me-website" value={field('website')} disabled={saving}
              onChange={(e) => setDraft((prev) => ({ ...prev, website: e.target.value }))}
            />
          </div>

          {/* Said once, beside the tick it disables, rather than left to a
              tooltip nobody hovers. */}
          {!contactsSettled && (
            <p className="field-hint contacts-pending">
              Verify your new {unverified.join(' and ')} to save these changes.
            </p>
          )}
        </div>
      ) : (
        <dl className="facts facts-ruled">
          <Fact label="First name" value={person.firstName} />
          <Fact label="Last name" value={person.lastName} />
          <Fact label="Username" value={person.username} />
          <Fact label="Company" value={person.company} />
          <Fact label="Company key" value={person.joinKey} />
          <Fact label="Role" value={person.isOrgAdmin ? 'Company administrator' : 'Recruiter'} />
          {/*
            Always shown, even when there is nothing on file.

            Sign-up asks for all three, but accounts made before it did — and
            any the administrator created — can have none of them. Dropping the
            empty rows meant those profiles simply had no contact section at
            all, which reads as "this page does not show that" rather than as
            "we do not have it", and the second is the one that is true.
          */}
          <Fact label="Email" value={person.email} placeholder="Not on file" />
          <Fact label="Phone number" value={person.phone} placeholder="Not on file" />
          <Fact label="Website" value={person.website} placeholder="Not on file" />
        </dl>
      )}

      {/*
        A door rather than a form.

        Changing a password is a rare, deliberate errand, and the fields for it
        are the longest thing on this page — three inputs, a checklist and a
        match line, all of it shown to everyone who came here to read their own
        username. Behind a button it costs one click when it is wanted and
        nothing at all the rest of the time.

        It stays open after a successful change, because the confirmation is
        inside it and collapsing on success would take the answer away with the
        question.
      */}
      <button
        type="button"
        className={`password-toggle${pwOpen ? ' password-toggle-open' : ''}`}
        aria-expanded={pwOpen}
        aria-controls="me-password"
        onClick={() => setPwOpen((was) => !was)}
      >
        Change password
        <Caret />
      </button>

      <form
        id="me-password"
        className="password-block"
        onSubmit={savePassword}
        hidden={!pwOpen}
      >
        <h4 className="modal-subhead">Password</h4>
        <StatusNotice notice={pwNotice} onDismiss={() => setPwNotice('')} />

        {/* Shown as dots rather than a value: the server keeps a one-way hash,
            so there is nothing to display even to the account holder. */}
        <dl className="facts">
          <Fact label="Current password" value="••••••••" />
        </dl>
        <p className="field-hint">
          Stored as a one-way hash, so it cannot be displayed. Enter it below to set a new one.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="pw-current">Current password</label>
          <input id="pw-current" type="password" autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pw-new">New password</label>
          <input id="pw-new" type="password" autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} />
          {/* §17's checklist, on the screen where a password is most often
              actually chosen. The rules are the sign-up form's, because the
              server applies the same ones to both. */}
          <ul className="rule-list">
            {PASSWORD_RULES.map(({ key, label, test }) => (
              <li key={key} className={test(next) ? 'rule-met' : undefined}>{label}</li>
            ))}
          </ul>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pw-confirm">Confirm new password</label>
          <input id="pw-confirm" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {confirm && (
            <p className={`match-line ${next === confirm ? 'match-ok' : 'match-bad'}`}>
              {next === confirm ? 'Passwords match' : 'Passwords do not match yet'}
            </p>
          )}
        </div>

        {/* "Save", not "Change password" — that is now the name of the button
            that opened this, and two controls with one label a few centimetres
            apart is a way of asking somebody to guess which one commits. */}
        <button
          type="submit" className="btn btn-primary btn-self-start"
          disabled={pwBusy || !current || !passwordMeetsRules(next) || next !== confirm}
        >
          {pwBusy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  )
}

// -------------------------------------------------------------- profile ---

/**
 * Name and photo for one recruiter. Shared by My profile and the Team editor, so
 * the two can never drift apart in validation or in what they send.
 *
 * `person` uses the camelCase shape of /api/recruiter/me; the Team list's
 * snake_case rows are mapped before they get here.
 */
/**
 * One colleague's account, in the shape of My profile.
 *
 * Locked on arrival and unlocked by the pencil, with the same centred photo and
 * the same list of facts underneath — see the note in ProfileDialog for why the
 * two screens match.
 *
 * An administrator may change everything here except the username, which is
 * half of the sign-in credential and would lock the account out of its own
 * door. Email and phone need a code sent to the new address, exactly as they do
 * on the account holder's own profile — the administrator has to be able to
 * reach whatever they are typing.
 *
 * That check is not theatre even in an administrator's hands. They can already
 * reset this password to a known value, so the account is already reachable by
 * them; what the code prevents is a mistyped address quietly becoming the one
 * the account answers to, which nobody would notice until a reset link went
 * somewhere nobody reads.
 */
function RecruiterProfileForm({ person, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [firstName, setFirstName] = useState(person.firstName)
  const [lastName, setLastName] = useState(person.lastName)

  // Three photo states to distinguish: keep what is stored, replace with a new
  // file, or remove entirely. A single nullable file cannot express all three.
  const [photo, setPhoto] = useState(null)
  const [removePhoto, setRemovePhoto] = useState(false)
  const [preview, setPreview] = useState(null)
  const photoInput = useRef(null)

  const [email, setEmail] = useState(person.email ?? '')
  const [phone, setPhone] = useState(person.phone ?? '')
  const [proofs, setProofs] = useState({ email: '', phone: '' })

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  /* Settled: untouched since it went on the account, or proved just now. The
     tick and the green Verified mark both read this, so they cannot disagree. */
  const emailSettled = email.trim().toLowerCase() === (person.email ?? '').trim().toLowerCase()
    || Boolean(proofs.email)
  const phoneSettled = phone.replace(/\D/g, '') === (person.phone ?? '').replace(/\D/g, '')
    || Boolean(proofs.phone)
  const unverified = [
    emailSettled ? null : 'email address',
    phoneSettled ? null : 'phone number',
  ].filter(Boolean)
  const contactsSettled = emailSettled && phoneSettled

  /*
   * Nothing on file is not the same as verified.
   *
   * An account an administrator created starts with no email and no phone, and
   * an empty box wearing a green Verified mark is a claim about an address that
   * does not exist. Settled still holds — there is nothing to prove about a
   * field nobody has touched — so the tick stays live; it is only the mark that
   * waits for something to be true about.
   */
  const emailProved = emailSettled && Boolean(email.trim())
  const phoneProved = phoneSettled && Boolean(phone.trim())

  /*
   * Contact details travel only when there are some.
   *
   * The server takes the three as a set: send one and it validates all three,
   * which is right for a profile that has them and wrong for an account that
   * has none — renaming somebody would be refused for a website nobody ever
   * entered. All three blank means this edit is not about contact details.
   */
  const sendsContact = Boolean(email.trim() || phone.trim())

  // Object URLs have to be revoked, or each re-pick leaks the previous image.
  useEffect(() => {
    if (!photo) {
      setPreview(null)
      return undefined
    }
    const url = URL.createObjectURL(photo)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  const storedPhoto = person.hasPhoto && !removePhoto && !photo
    ? withToken(
      `/api/recruiter/${person.id}/photo?v=${person.photoVersion ?? ''}`,
      'recruiter',
    )
    : null
  const shown = preview ?? storedPhoto
  const hasSomething = Boolean(shown)

  function choosePhoto(selected) {
    if (!selected) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) {
      setError('Your photo must be a JPG, PNG or WebP image.')
      return
    }
    setError('')
    setNotice('')
    setRemovePhoto(false)
    setPhoto(selected)
  }

  function startEditing() {
    setFirstName(person.firstName)
    setLastName(person.lastName)
    setEmail(person.email ?? '')
    setPhone(person.phone ?? '')
    setProofs({ email: '', phone: '' })
    setPhoto(null)
    setRemovePhoto(false)
    setError('')
    setNotice('')
    setEditing(true)
  }

  async function save() {
    setBusy(true)
    setError('')
    setNotice('')

    try {
      const form = new FormData()
      form.append('firstName', firstName)
      form.append('lastName', lastName)
      if (sendsContact) {
        form.append('email', email)
        form.append('phone', phone)
        form.append('emailProof', proofs.email)
        form.append('phoneProof', proofs.phone)
      }
      if (photo) form.append('photo', photo)
      if (removePhoto) form.append('removePhoto', 'true')

      await sendForm(`/api/recruiter/${person.id}`, form, { method: 'PATCH', role: 'recruiter' })

      setPhoto(null)
      setRemovePhoto(false)
      setProofs({ email: '', phone: '' })
      setEditing(false)
      setNotice(`${firstName} ${lastName} has been updated.`)
      // Refreshes the header, the team list and every avatar in the panel.
      await onSaved?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile-form">
      <StatusNotice error={error} onDismiss={() => setError('')} />
      {notice && !editing && <p className="alert alert-ok">{notice}</p>}

      {/* Always type="button", and saving is called directly — see the note on
          the candidate form's lock bar for what a changing type does to the
          click that changed it. */}
      <div className="form-lock-bar">
        <button
          type="button"
          className="icon-button"
          aria-pressed={editing}
          disabled={busy || (editing && !contactsSettled)}
          aria-label={editing ? 'Save this profile' : 'Edit this profile'}
          title={!editing ? 'Edit'
            : contactsSettled ? 'Save'
              : `Verify the new ${unverified.join(' and ')} first`}
          onClick={() => { if (editing) save(); else startEditing() }}
        >
          {editing ? <TickIcon /> : <PencilIcon />}
        </button>
      </div>

      <div className="profile-photo-block">
        <div className="photo-row">
          {editing ? (
            <button
              type="button"
              className="avatar avatar-editable"
              onClick={() => photoInput.current?.click()}
              aria-label={hasSomething ? 'Replace profile picture' : 'Add a profile picture'}
            >
              {shown
                ? <img src={shown} alt="" />
                : <span className="avatar-empty"><AddPhotoIcon size={28} /></span>}
            </button>
          ) : (
            <span className="avatar">
              {shown
                ? <img src={shown} alt="" />
                : <span className="avatar-empty"><PersonIcon size={30} /></span>}
            </span>
          )}

          <input
            ref={photoInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => {
              choosePhoto(e.target.files?.[0])
              // Reset, so picking the same file twice still fires onChange.
              e.target.value = ''
            }}
          />

          {editing && (
            <div className="photo-copy">
              <span className="photo-formats"><Req />JPG, PNG or WebP</span>
              <div className="photo-actions">
                {hasSomething && (
                  <button
                    type="button"
                    className="btn btn-quiet btn-small"
                    onClick={() => { setPhoto(null); setRemovePhoto(true); setNotice('') }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {editing ? (
        <div className="profile-edit">
          <div className="grid-2">
            <div className="field">
              <label className="field-label" htmlFor={`first-${person.id}`}>First name<Req /></label>
              <input
                id={`first-${person.id}`}
                value={firstName}
                disabled={busy}
                onChange={(e) => { setFirstName(e.target.value); setNotice('') }}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`last-${person.id}`}>Last name<Req /></label>
              <input
                id={`last-${person.id}`}
                value={lastName}
                disabled={busy}
                onChange={(e) => { setLastName(e.target.value); setNotice('') }}
              />
            </div>
          </div>

          <VerifiedField
            channel="email"
            id={`email-${person.id}`}
            label="Email"
            type="email"
            value={email}
            proof={proofs.email}
            verified={emailProved}
            onChange={(value) => { setEmail(value); setNotice('') }}
            onProof={(proof) => setProofs((prev) => ({ ...prev, email: proof }))}
            disabled={busy}
            lockWhenVerified={false}
          />

          <VerifiedField
            channel="phone"
            id={`phone-${person.id}`}
            label="Phone number"
            type="tel"
            value={phone}
            proof={proofs.phone}
            verified={phoneProved}
            onChange={(value) => { setPhone(value); setNotice('') }}
            onProof={(proof) => setProofs((prev) => ({ ...prev, phone: proof }))}
            disabled={busy}
            lockWhenVerified={false}
          />

          {/*
            No website while editing.

            It belongs to the company rather than to this person, so there is
            nothing to decide about it here — and a row that cannot be changed,
            sitting among four that can, reads as one that is broken. It is in
            the list below when the form is shut, which is where facts about
            the account live.
          */}

          {!contactsSettled && (
            <p className="field-hint contacts-pending">
              Verify the new {unverified.join(' and ')} to save these changes.
            </p>
          )}

          <p className="field-hint">
            The username stays <strong>{person.username}</strong> whatever the name becomes: it is
            half of the sign-in credential, so changing it here would lock this account out.
          </p>
        </div>
      ) : (
        <dl className="facts">
          <Fact label="First name" value={person.firstName} />
          <Fact label="Last name" value={person.lastName} />
          <Fact label="Username" value={person.username} />
          <Fact label="Company" value={person.company} />
          <Fact label="Role" value={person.isOrgAdmin ? 'Company administrator' : 'Recruiter'} />
          <Fact
            label="Joined"
            value={person.joined ? new Date(person.joined).toLocaleDateString(DATE_LOCALE) : null}
          />
          <Fact label="Email" value={person.email} placeholder="Not on file" />
          <Fact label="Phone number" value={person.phone} placeholder="Not on file" />
          <Fact label="Website" value={person.website} placeholder="Not on file" />
        </dl>
      )}
    </div>
  )
}

// -------------------------------------------------------------- billing ---

/**
 * What the organization holds, and how it is shared.
 *
 * The two halves of one question. The meters say how much is left; the table
 * below says whether anyone has a claim on part of it. They used to live on
 * different screens — the meters beside the packs on Usage & billing, the table
 * at the foot of Team — which put the answer to "can my team still reveal
 * people" on a page about buying and the answer to "why not" on a page about
 * accounts.
 *
 * Buying is one door along, on Billing. An administrator checking a balance is
 * usually not about to spend money, and a screen that opens with a price list
 * assumes they are.
 */
function OrganizationUsageTab({ me, wallet, onSaved }) {
  /*
   * Two questions, and they were being answered in one column.
   *
   * How much the organization holds and who may spend it were two screens
   * behind a switch. They are one screen now.
   *
   * The split asked an admin to know which of two words their question lived
   * under before they could ask it, and the answer was usually both: the size
   * of the pool and the shares drawn from it are the same arithmetic, and
   * reading them apart meant holding a number from one tab in your head while
   * looking at the other. The total now sits under the shares it is the sum
   * of, which is the sentence the two screens were circling.
   */

  if (!wallet) {
    return <p className="muted">Usage is not available at the moment.</p>
  }

  return (
    <div className="panel panel-narrow usage-page">
      <SharingSection
        title="Reveals"
        icon={<EyeIcon size={15} />}
        unit="reveal"
        unitPlural="reveals"
        product="reveal"
        note="Shared by everyone in your organization · never expire"
        splitEqually={wallet.splitEqually?.reveal ?? true}
        endpoint="/api/company/reveal-allocations"
        onChanged={onSaved}
      />

      <SharingSection
        title="Triage"
        icon={<StackIcon />}
        unit="CV"
        unitPlural="CVs"
        product="triage"
        note="CV uploads · bought in packs · never expire"
        splitEqually={wallet.splitEqually?.triage ?? true}
        endpoint="/api/company/triage-allocations"
        onChanged={onSaved}
      />

      <div className="usage-group-head">
        <h2>Seats</h2>
        <span className="muted">A monthly subscription · change it whenever your team does</span>
      </div>
      <SeatsTable seats={wallet.seatList ?? []} />
    </div>
  )
}

/**
 * The seats, as a list of subscriptions rather than a meter.
 *
 * A bar answers "how far through are you", and there is no such thing as being
 * a third of the way through a seat. What an admin wants from this section is
 * the bill: who is on it, since when, and what renews next.
 */
function SeatsTable({ seats }) {
  if (seats.length === 0) return <p className="muted">No seats yet.</p>

  const day = (value) => (value
    ? new Date(value).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' })
    : '—')

  return (
    <table className="fee-table seat-table">
      <thead>
        <tr>
          <th>Recruiter</th>
          <th>Status</th>
          <th>Started</th>
          <th>Renews</th>
        </tr>
      </thead>
      <tbody>
        {seats.map((seat) => (
          <tr key={seat.id}>
            <td>
              {seat.name}
              {seat.isAdmin && <span className="seat-tag">Admin</span>}
            </td>
            <td>
              {/* Which seat is the one the plan comes with, said plainly — it is
                  the difference between a line on the invoice and no line. */}
              {seat.included ? 'Included' : 'Subscribed'}
              {seat.status === 'ending' && <span className="muted"> · ending</span>}
            </td>
            <td>{day(seat.since)}</td>
            <td>{day(seat.renewsAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Who may spend what, for each of the two currencies.
 *
 * No seats here. A seat is a thing you pay for, not a thing you spend, and it
 * has no allowance to give.
 */
/** On or off, and nothing in between. Used for the two Split equally switches. */
function SplitSwitch({ on, busy, label, onChange }) {
  return (
    <label className="split-switch">
      <span className="split-switch-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={busy}
        className={`switch${on ? ' switch-on' : ''}`}
        onClick={() => onChange(!on)}
      >
        <span className="switch-knob" aria-hidden="true" />
      </button>
    </label>
  )
}

/**
 * §7.2 — dividing the organization's reveals across its seats.
 *
 * Off by default, and that is the point: one shared pool is the right answer
 * for most teams, and a screen that opens with everybody's allowance already
 * boxed would push admins into managing something they had no problem with.
 * Turning it on is a deliberate act; turning it off returns every seat to the
 * pool without anybody losing what they have already spent.
 *
 * The running total is the whole interface. An admin redistributing has to see
 * what is left to give while they type, not after they submit — the server
 * refuses an over-allocation either way, but discovering it on save means
 * re-deriving which of five numbers to lower.
 */
/**
 * How one currency is shared across the seats — for reveals and for Triage.
 *
 * One component, used twice. They are the same idea about different money: an
 * organization holds a pool, and an administrator decides whether everyone
 * draws from it freely or each person gets a ceiling. Two implementations of
 * that would drift, and the drift would be an admin setting a reveal allowance
 * while believing they had set a Triage one.
 *
 * Read-only until the pencil is pressed. The table used to be a live form the
 * moment the screen opened, with a Save button sitting under it permanently —
 * which made a page somebody came to READ look like a page they had left
 * half-finished, and put a set of editable numbers one stray keystroke away
 * from being wrong.
 */
/** The Triage mark — the same stack of paper the Triage list uses for a row. */
function StackIcon() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M8 3h6l4 4v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v4h4" />
      <path d="M4 8v11a2 2 0 0 0 2 2h9" />
    </svg>
  )
}

function SharingSection({
  title, icon, unit, unitPlural, product, splitEqually, endpoint,
  note, seatsKey = 'seats', onChanged,
}) {
  const [state, setState] = useState(null)
  const [split, setSplit] = useState(splitEqually)
  const [splitting, setSplitting] = useState(false)
  const [draft, setDraft] = useState({})
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => (
    get(endpoint, 'recruiter')
      .then((data) => {
        setState(data)
        setDraft(Object.fromEntries(
          (data[seatsKey] ?? []).map((seat) => [seat.id, seat.allowance ?? '']),
        ))
      })
      .catch((err) => setError(err.message))
  ), [endpoint, seatsKey])

  useEffect(() => { load() }, [load])

  if (error && !state) return <p className="alert alert-error">{error}</p>
  if (!state) return null

  const seats = state[seatsKey] ?? []
  const promised = seats.reduce(
    (sum, seat) => sum + (draft[seat.id] === '' || draft[seat.id] == null ? 0 : Number(draft[seat.id])),
    0,
  )
  const dividing = seats.some((seat) => draft[seat.id] !== '' && draft[seat.id] != null)
  const left = state.balance - promised
  const over = dividing && left < 0

  /*
   * The switch, and what it forecloses.
   *
   * While the system is dividing capacity there is nothing for an admin to
   * type: every allowance is a function of the balance and the number of
   * seats, and an editable field whose value is about to be recomputed is a
   * field that lies. So editing is not merely disabled here — it is not
   * offered, and the pencil goes with it.
   */
  async function toggleSplit(next) {
    setSplitting(true)
    setError('')
    setNotice('')
    try {
      const data = await put('/api/company/split-equally', { product, enabled: next }, 'recruiter')
      setSplit(data.splitEqually?.[product] ?? next)
      /* The answer carries both tables; this section takes its own. Reveals and
         Triage are independent, and a switch on one must not repaint the other
         with numbers it did not ask for. */
      const mine = data[product]
      if (mine) {
        setState(mine)
        setDraft(Object.fromEntries(
          (mine[seatsKey] ?? []).map((seat) => [seat.id, seat.allowance ?? '']),
        ))
      }
      setEditing(false)
      await onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setSplitting(false)
    }
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      const allocations = Object.fromEntries(
        seats.map((seat) => [seat.id, draft[seat.id] === '' ? null : Number(draft[seat.id])]),
      )
      const data = await put(endpoint, { allocations }, 'recruiter')
      setState(data)
      setEditing(false)
      setNotice('Saved.')
      await onChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function cancel() {
    setDraft(Object.fromEntries(seats.map((seat) => [seat.id, seat.allowance ?? ''])))
    setEditing(false)
    setError('')
    setNotice('')
  }

  return (
    <section className="allocation">
      <div className="allocation-head">
        <h4 className="modal-subhead">{icon}{icon ? ' ' : ''}{title}</h4>
        {note && <span className="muted allocation-note">{note}</span>}
        <SplitSwitch
          on={split}
          busy={splitting}
          label="Split equally"
          onChange={toggleSplit}
        />
        {/*
          The pencil's place is kept even when there is no pencil.

          Both it and the switch used to be pushed right by their own auto
          margins, so the free space was shared between them — and turning the
          switch off, which is what makes the pencil appear, slid the switch a
          couple of hundred pixels left. The control moved as a result of being
          used, which is the one thing a control must not do.
        */}
        <span className="allocation-edit-slot">
          {!split && !editing && (
            <button
              type="button"
              className="icon-button"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${title.toLowerCase()}`}
              title="Edit"
            >
              <PencilIcon />
            </button>
          )}
        </span>
      </div>

      <table className="fee-table allocation-table">
        <thead>
          <tr>
            <th>Recruiter</th>
            <th className="fee-amount">Allowance</th>
            <th className="fee-amount">Spent</th>
            <th className="fee-amount">Left</th>
          </tr>
        </thead>
        <tbody>
          {seats.map((seat) => {
            const value = draft[seat.id] ?? ''
            /* What the row will mean once saved, not what it means now: setting
               an allowance resets the draw, so a changed number has nothing
               spent against it yet. */
            const changed = String(seat.allowance ?? '') !== String(value)
            const remaining = value === ''
              ? null
              : changed ? Number(value) : seat.remaining

            return (
              <tr key={seat.id}>
                <td>
                  {seat.name}
                  {seat.isAdmin && <span className="seat-tag">Admin</span>}
                </td>
                <td className="fee-amount">
                  {editing ? (
                    <input
                      className="allocation-input"
                      inputMode="numeric"
                      aria-label={`${title} for ${seat.name}`}
                      placeholder="Shared"
                      value={value}
                      onChange={(e) => {
                        const next = e.target.value.replace(/\D/g, '')
                        setDraft((was) => ({ ...was, [seat.id]: next }))
                        setNotice('')
                      }}
                    />
                  ) : (
                    value === '' ? <span className="muted">Shared</span> : value
                  )}
                </td>
                <td className="fee-amount muted">
                  {seat.allowance === null || changed ? '—' : seat.used}
                </td>
                <td className="fee-amount">
                  {remaining === null ? <span className="muted">shared</span> : remaining}
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          {/*
            The organization's own total, under the shares it is the sum of.

            This is the number the Capacity screen used to hold, and it is the
            one an admin came for. Bottom left, where a total belongs and where
            the eye lands after reading down the names — not in the right-hand
            column, which is a per-person figure and would invite reading the
            total as one more person's.

            An absolute count, never a percentage. "10% used" answers a question
            nobody asked: what an admin needs before spending is how many are
            left, and a proportion of a pool that grows with every purchase says
            less every time it is topped up.
          */}
          <tr>
            <td colSpan={4} className={`allocation-total${over ? ' allocation-over' : ''}`}>
              {/*
                What the ORGANIZATION has left, which is the number the Capacity
                screen used to hold and the one somebody opens this to find.

                Not `left`, which is the unallocated remainder. With shares
                divided evenly that is nearly always nought — so the headline
                read "0 reveals" over a table whose own rows said ten, which is
                the opposite of reassuring. The remainder still matters while an
                admin is dividing by hand, so it follows in a quieter clause
                rather than taking the position.
              */}
              <strong>{state.balance}</strong>{' '}
              {Math.abs(state.balance) === 1 ? unit : unitPlural} left
              {dividing && left !== 0 && (
                <span className="allocation-remainder">
                  {' · '}{left} {over ? 'over-allocated' : 'still to share out'}
                </span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>

      {over && (
        <p className="alert alert-error">
          That is {Math.abs(left)} more than you have. Lower an allowance, or buy more {unitPlural}.
        </p>
      )}
      {error && !over && <p className="alert alert-error">{error}</p>}
      <StatusNotice notice={notice} onDismiss={() => setNotice('')} />

      {/* Save is here only while editing, and it says Save. It used to sit
          under the table permanently, next to two arrangement buttons, which
          made a read-only screen look unsaved. */}
      {editing && (
        <div className="allocation-actions">
          <button type="button" className="btn btn-primary btn-small" disabled={busy || over} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      )}

      {!editing && state.unallocated > 0 && (
        <p className="field-hint">
          {state.unallocated} {state.unallocated === 1 ? unit : unitPlural}{' '}
          {state.unallocated === 1 ? 'is' : 'are'} unallocated. Only people without an allowance
          can spend {state.unallocated === 1 ? 'it' : 'them'}.
        </p>
      )}
    </section>
  )
}


/**
 * One card per pack, in the shape the pricing page uses.
 *
 * Deliberately the same object in both places. An admin who chose a pack on the
 * public page and comes back to buy another should recognise what they are
 * looking at; two different presentations of one price list is two things to
 * learn for no gain.
 */
function BillingPack({ pack, kind, selected, onSelect, name, current = false }) {
  return (
    <label className={`pack-card${selected ? ' pack-card-on' : ''}${current ? ' pack-card-current' : ''}`}>
      {/*
        What you are on today, said across the top of the card.

        Seats are the one product where a pack is a state rather than a
        purchase: the others add to a balance, this one replaces a subscription.
        Without the banner the card you are already on is indistinguishable from
        the three you are not, and "1 seat" reads as something to buy.
      */}
      {current && <span className="pack-current-tag">Current plan</span>}
      <input
        type="radio"
        name={name}
        className="pack-radio"
        checked={selected}
        onChange={() => onSelect(pack)}
      />
      <span className="pack-quantity">
        {/* The same correction as the public pricing page: all three products
            put their number in the same place. */}
        <strong>{pack.quantity}</strong>
        {kind === 'reveal'
          ? ` reveal${pack.quantity === 1 ? '' : 's'}`
          : kind === 'triage'
            ? ` CVs`
            : ` seat${pack.quantity === 1 ? '' : 's'}`}
      </span>
      {/* A seat plan has a monthly rate; a reveal pack and a Triage pack have a
          price. Reading the field that exists rather than a shared one keeps
          the three products from having to pretend to be the same shape. */}
      <span className="pack-total">
        {kind === 'seat' ? `${pack.formattedMonthly}/mo` : pack.formattedTotal}
      </span>
      <span className="pack-unit">
        {kind === 'reveal'
          ? `${pack.formattedUnit} per reveal`
          : kind === 'triage'
            ? `${pack.formattedUnit} per CV`
            : `${pack.formattedUnit} per seat / month`}
      </span>
      {pack.discount > 0 && <span className="pack-badge">Save {Math.round(pack.discount)}%</span>}
      {selected && <span className="pack-tick" aria-hidden="true">✓</span>}
    </label>
  )
}

/**
 * What this recruiter has spent, and what is left for them.
 *
 * The organization's numbers live on Usage & billing, which is
 * administrator-only — and rightly so, since it is also where money is spent.
 * But "can I open this candidate" is a question a recruiter faces several times
 * a day, and until now the only way to answer it was to press Reveal and find
 * out. This is the same fact, asked in advance.
 *
 * Which number matters depends on how the administrator set the organization
 * up. With an allowance, the limit is personal and the team balance is only
 * background. Without one, everybody draws on the same pool and the personal
 * figure is a contribution rather than a limit. Guessing between them would
 * make the page wrong half the time, so it says which arrangement is in force.
 */
function UsageTab({ wallet }) {
  if (!wallet) {
    return <p className="muted">Your usage is not available at the moment.</p>
  }

  const balance = wallet.balance ?? 0
  const used = wallet.used ?? 0
  const everHeld = wallet.everHeld ?? balance
  const mine = wallet.seatUsed ?? 0

  const allocation = wallet.allocation ?? null
  const allocated = allocation !== null
  const left = allocated ? (wallet.allocationLeft ?? 0) : balance

  /*
   * An allowance is a cap on your share, not a guarantee there is anything
   * behind it: the pool it draws from is shared and can empty first. Whichever
   * of the two is smaller is what you can actually spend, and that is the
   * number worth leading with.
   */
  const spendable = allocated ? Math.min(left, balance) : balance
  const heldBackByPool = allocated && balance < left

  /*
   * Read from whatever the meter above is counting, not from a second source.
   *
   * An allowance keeps its own tally and the seat keeps another; they normally
   * agree, and when they do not this page would contradict itself in adjacent
   * lines — "1 of 4 revealed" over "you have not revealed anyone yet". One
   * screen, one number.
   */
  const spent = allocated ? allocation - left : mine

  return (
    <div className="panel panel-narrow usage-page">
      <div className="usage-group">
        <div className="usage-group-head">
          <h2>Reveals</h2>
          <span className="muted">
            {allocated
              ? 'Your own allowance · never expires'
              : 'Shared by everyone in your organization · never expire'}
          </span>
        </div>

        <p className="usage-headline">
          <strong>{spendable}</strong>
          {spendable === 1 ? ' reveal left for you' : ' reveals left for you'}
        </p>

        {allocated ? (
          <UsageMeter
            label="Your allowance"
            note={`${left} left of the ${allocation} your administrator gave you`}
            used={allocation - left}
            total={allocation}
            unit="revealed"
          />
        ) : (
          <UsageMeter
            label="Reveal credits"
            note={balance === 0
              ? 'Nobody on your team can open a candidate until it is topped up.'
              : `${balance} left for the whole team`}
            used={used}
            total={everHeld}
            unit="revealed"
          />
        )}

        {/* Your own spending, whichever arrangement is in force. Under an
            allowance it is the meter above said plainly; on a shared balance it
            is the part of the team's total that is yours. */}
        <p className="field-hint">
          {spent === 0
            ? 'You have not revealed anyone yet.'
            : `You have revealed ${spent} candidate${spent === 1 ? '' : 's'}.`}
          {!allocated && used > 0 && ` The team has revealed ${used}.`}
        </p>

        {heldBackByPool && (
          <p className="alert alert-warn">
            Your allowance has {left} left, but the team balance is down to {balance}, so that is
            all anyone can spend until it is topped up.
          </p>
        )}

        {spendable === 0 && (
          <p className="alert alert-warn">
            {allocated && balance > 0
              ? 'You have used your whole allowance. Your administrator can raise it.'
              : 'There are no reveals left. Only an administrator can buy more.'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * One limit, as a bar.
 *
 * The shape every usage screen worth copying settles on: what the limit is,
 * what it resets to or when, how full it is, and the number. The bar is the
 * thing you read at a glance; the figures beside it are for when the glance
 * raises a question.
 *
 * `used` and `total` rather than a percentage, because the percentage is the
 * least useful of the three on its own — "83% used" of what is the question
 * somebody is about to ask.
 */
function UsageMeter({ label, note, used, total, unit = '' }) {
  /* An unbought allowance has no denominator. Showing 0/0 as a full bar would
     read as exhausted, which is the opposite of the truth. */
  const share = total > 0 ? Math.min(1, used / total) : 0
  const remaining = Math.max(0, total - used)

  const tone = total === 0 || remaining === 0
    ? ' usage-bar-out'
    : (remaining / total <= 0.2 ? ' usage-bar-low' : '')

  return (
    <div className="usage-meter">
      <span className="usage-meter-label">
        <strong>{label}</strong>
        {note && <span className="muted">{note}</span>}
      </span>
      <span className="usage-percent">
        {total > 0 ? `${Math.round(share * 100)}% used` : 'none yet'}
      </span>
      <div
        className={`usage-bar${tone}`}
        role="progressbar"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label}: ${used} of ${total} ${unit}`.trim()}
      >
        <div className="usage-bar-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <span className="usage-count">
        {used} of {total} {unit}
      </span>
    </div>
  )
}

/**
 * Reveals and seats, as meters.
 *
 * Both were tiles carrying a bare number — "12", "2 of 3" — which said what you
 * hold but not how far through it you are. They are the same kind of fact and
 * now read the same way.
 *
 * Seats are administrator-only wherever this is used: a recruiter cannot buy
 * one, and showing somebody a limit they have no power over is an invitation to
 * ask a colleague about it.
 */
function UsageMeters({ balance, used, everHeld, seats, triage = null, admin }) {
  return (
    <div className="usage-group">
      <div className="usage-group-head">
        <h2>Reveals</h2>
        <span className="muted">Shared by everyone in your organization · never expire</span>
      </div>

      <UsageMeter
        label="Reveal credits"
        note={balance === 0
          ? 'Nobody on your team can open a candidate until you top up.'
          : `${balance} left for the whole team`}
        used={used}
        total={everHeld}
        unit="revealed"
      />

      {admin && seats && (
        <>
          <div className="usage-group-head">
            <h2>Seats</h2>
            {/* Seats are a subscription, not a purchase — this said "bought
                once, no monthly charge", which described the model they had
                before and is now simply untrue. */}
            <span className="muted">A monthly subscription · change it whenever your team does</span>
          </div>

          <UsageMeter
            label="Recruiter seats"
            note={`${seats.included} included${seats.purchased > 0 ? `, ${seats.purchased} purchased` : ''}`
              + (seats.available > 0 ? ` · ${seats.available} free` : ' · every seat is taken')}
            used={seats.occupied}
            total={seats.total}
            unit="in use"
          />
        </>
      )}

{/*
        Triage is counted, not metered.

        A meter answers "how far through the allowance am I", which needs a
        denominator — and a capacity balance has none: it is bought in packs and
        never expires, so there is no total to be a fraction of. Inventing one
        (balance over balance-ever-held) would draw a bar that empties as the
        team works and refills on every purchase, which describes nothing.
      */}
      {triage && (
        <>
          <div className="usage-group-head">
            <h2>Triage</h2>
            <span className="muted">CV uploads · bought in packs · never expire</span>
          </div>

          <p className="usage-count-line">
            <span className="usage-count">{triage.balance}</span>
            <span className="muted">
              CV{triage.balance === 1 ? '' : 's'} of capacity left
              {triage.used > 0 && ` · ${triage.used} processed so far`}
            </span>
          </p>
          <p className="muted">
            Capacity is spent on the CVs you submit for processing, never on creating a
            workspace, so you can open as many Triages as you have roles. It is separate from
            reveals:
            buying one never spends the other.
          </p>
        </>
      )}

      {/* No "Buy more" here. This screen answers "what do we hold"; the screen
          for changing that is Billing, which the account menu opens and which
          every warning banner links straight into by product. The button was
          behind an onBuy the sole call site never passed, so it had not been on
          screen for some time. */}
    </div>
  )
}

/**
 * Reveals, seats, Triage and the record of all three. Admin-only — the tab is not rendered
 * for anyone else, and every route behind it refuses them independently.
 *
 * Two products, one at a time, behind the same segmented control the pricing
 * page uses. They were stacked on one screen, which put a reveal pack and a
 * seat quantity in the same field of view and invited the reading that seats
 * come with reveals in them. They do not, and the surest way to stop saying so
 * is to stop showing them together.
 *
 * Reveals lead, because that is what an admin comes here to buy. Seats are for
 * the day somebody joins.
 */
function BillingTab({ product: opened = 'reveals', onSeatsChanged }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  /* Whichever product sent you here, and Reveals when nothing did. Seeded once:
     the screen is unmounted with the dialog, so arriving is the only moment the
     caller's intent is knowable, and a recruiter who then presses Seats means
     it. */
  const [product, setProduct] = useState(opened)
  const [pick, setPick] = useState({ reveals: null, seats: null, triage: null })
  const [confirming, setConfirming] = useState(null)
  /* Shut on arrival: the ledger is consulted after a question, not before one. */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyKind, setHistoryKind] = useState('all')

  // Fetched rather than computed: §14.3's true-up is the server's arithmetic,
  // and a second implementation here could show a number the charge disagrees
  // with. Only seats need one — a reveal pack costs what it says.
  const [quote, setQuote] = useState(null)

  const reload = useCallback(() => (
    get('/api/company/billing', 'recruiter').then(setData).catch((err) => setError(err.message))
  ), [])

  useEffect(() => { reload() }, [reload])

  // The middle reveal pack and the single seat, which are the honest defaults:
  // the cheapest reads as a nudge and the largest as a demand.
  useEffect(() => {
    if (!data || pick.reveals) return
    setPick({
      reveals: data.catalogue.reveals[1] ?? data.catalogue.reveals[0] ?? null,
      seats: data.catalogue.seats[0] ?? null,
      triage: data.catalogue.triage?.[1] ?? data.catalogue.triage?.[0] ?? null,
    })
  }, [data, pick.reveals])

  /* The tier being considered, not a number to add: seats are a subscription,
     so the choice is which plan to be on. */
  const seatQty = pick.seats?.quantity ?? 1

  useEffect(() => {
    if (product !== 'seats') return undefined
    let live = true
    get(`/api/company/seat-plan/quote?seats=${seatQty}`, 'recruiter')
      .then((result) => { if (live) setQuote(result) })
      .catch(() => { if (live) setQuote(null) })
    return () => { live = false }
  }, [product, seatQty])

  async function buyReveals(pack) {
    setBusy(true)
    setError('')
    try {
      const result = await post('/api/company/reveals/purchase', { pack: pack.key }, 'recruiter')
      setData((was) => ({ ...was, ...result }))
      setConfirming(null)
      setNotice(
        `${result.purchased.reveals} reveals added for ${result.purchased.amount}. `
        + `Your balance is ${result.balance}.`,
      )
      // The bar's balance comes from /recruiter/me, so it has to be refetched.
      await onSeatsChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function buyTriages(pack) {
    setBusy(true)
    setError('')
    try {
      const result = await post('/api/company/triage/purchase', { pack: pack.key }, 'recruiter')
      setData((was) => ({ ...was, ...result }))
      setConfirming(null)
      setNotice(
        `${result.purchased.cvs} CVs of Triage capacity added for ${result.purchased.amount}. `
        + `Your balance is ${result.triageBalance} CVs.`,
      )
      /* The rail's Triage count and the workspace both read the wallet from
         /recruiter/me, so the purchase has to be pushed back up — otherwise the
         recruiter buys credits and the screen they came from still says zero. */
      await onSeatsChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function changeSeatPlan() {
    setBusy(true)
    setError('')
    try {
      const result = await put('/api/company/seat-plan', { seats: seatQty }, 'recruiter')
      setData((was) => ({ ...was, ...result }))
      setConfirming(null)
      setNotice(result.plan.scheduled
        ? `Your seats stay as they are until ${formatSeatDate(result.plan.effectiveFrom)}, `
          + `then the subscription becomes ${result.plan.seats} additional `
          + `seat${result.plan.seats === 1 ? '' : 's'} at ${result.plan.monthly} a month.`
        : `Your seat subscription is ${result.plan.seats} additional `
          + `seat${result.plan.seats === 1 ? '' : 's'} at ${result.plan.monthly} a month. `
          + 'Someone new can register with the company key.')
      await onSeatsChanged?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function setReplenish(packKey) {
    setError('')
    try {
      await patch('/api/company/auto-replenish', { pack: packKey }, 'recruiter')
      await reload()
      setNotice(packKey
        ? 'Automatic top-up is on. We will buy that pack when your balance reaches zero.'
        : 'Automatic top-up is off.')
    } catch (err) {
      setError(err.message)
    }
  }

  if (error && !data) return <div className="panel panel-narrow"><p className="alert alert-error">{error}</p></div>
  if (!data) return <div className="panel panel-narrow muted">Loading your balance…</div>

  /* No balance here any more: what the organization holds is on Usage, and
     this screen is about what things cost and what has been charged. */
  const { seats, catalogue, ledger, autoReplenish } = data

  /*
   * The ledger, narrowed to one product.
   *
   * Derived rather than stored: the ledger is the truth and this is a view of
   * it, so a reload cannot leave the two disagreeing. `product` is already on
   * every row, so nothing new is asked of the server.
   */
  const shownLedger = historyKind === 'all'
    ? ledger
    : ledger.filter((entry) => entry.product === historyKind)
  const reveals = product === 'reveals'
  const triage = product === 'triage'
  const chosen = pick[product]

  return (
    <div className="panel panel-narrow billing-tab">
      <header className="panel-head">
        <h2>Reveals, seats &amp; Triage</h2>
        <p className="muted">
          Three separate things. Reveals are bought in packs, shared by everyone in your
          organization, and never expire. Seats are a monthly subscription for the colleagues who
          need their own account. Triage capacity sorts the CVs you already received, and is
          measured in CVs. Buying any one of them never affects the other two.
        </p>
      </header>

      <StatusNotice
        error={error}
        notice={notice}
        onDismiss={() => { setError(''); setNotice('') }}
      />

      {data.simulated && (
        <p className="alert alert-warn">
          No payment provider is connected yet, so purchases are recorded but nothing is charged.
        </p>
      )}

      {/* The same segmented control as Pricing, because it is the same choice
          between the same three products — §15.1 and §15.2 ask for one control
          in both places rather than a second design here. */}
      <div className="role-switch billing-switch" role="group" aria-label="What are you buying?">
        {[['reveals', 'Reveals'], ['seats', 'Seats'], ['triage', 'Triage']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`role-option${product === key ? ' role-option-on' : ''}`}
            aria-pressed={product === key}
            onClick={() => { setProduct(key); setNotice(''); setError('') }}
          >
            {label}
          </button>
        ))}
      </div>

      <section className="billing-section">
        <p className="muted">
          {reveals
            ? 'A reveal opens one candidate to your whole organization and never expires. '
              + 'A colleague opening the same person later costs nothing.'
            : triage
              /* §15.3 — the invented word is explained wherever it is sold, not
                 only on the marketing page. An admin buying from inside the
                 product is exactly as entitled to know what it is. */
              ? 'Cursus Triage helps you sort through the CVs you have already received for a '
                + 'role. Upload your job description and applicant CVs, and Cursus prioritises '
                + 'the full batch before progressively analysing and scoring candidates so you '
                + 'can review the strongest matches first. Create as many Triage workspaces as '
                + 'you need. You only use capacity for the CVs you submit for processing.'
              : 'Your administrator account is included. Additional seats let colleagues hold '
                + 'accounts of their own, and are billed monthly. Pick the number you want to be '
                + 'on, not the number to add.'}
        </p>

        {/*
          What you hold, on the screen for managing what you hold.
          
          Triage said this and Reveals did not, which became a real gap once the
          banners started sending people here by product: somebody who followed
          "Add reveals" from "No reveals remaining" arrived at a page of packs
          that never mentioned the balance they had come about. The rule is that
          balances stay out of ordinary use, not that they stay out of sight.
        */}
        {reveals && (
          <p className="muted billing-balance-line">
            You have <strong>{data.balance ?? 0}</strong>{' '}
            reveal{(data.balance ?? 0) === 1 ? '' : 's'}. They never expire, and they are
            separate from your Triage capacity.
          </p>
        )}

        {triage && (
          <p className="muted billing-balance-line">
            You have <strong>{data.triage?.balance ?? 0}</strong>{' '}
            CV{(data.triage?.balance ?? 0) === 1 ? '' : 's'} of Triage capacity. It never
            expires, and it is separate from your reveal balance.
          </p>
        )}

        <div
          className="pack-grid"
          role="radiogroup"
          aria-label={reveals ? 'Reveal packs' : triage ? 'Triage packs' : 'Seat packs'}
        >
          {(reveals ? catalogue.reveals : triage ? (catalogue.triage ?? []) : catalogue.seats).map((pack) => (
            <BillingPack
              key={pack.key}
              pack={pack}
              kind={reveals ? 'reveal' : triage ? 'triage' : 'seat'}
              name={`billing-${product}`}
              selected={chosen?.key === pack.key}
              /* Seats only: a reveal pack is never "the one you are on". */
              current={!reveals && !triage && quote?.current === pack.quantity}
              onSelect={(next) => {
                setPick((was) => ({ ...was, [product]: next }))
                setNotice('')
              }}
            />
          ))}

          {/* Not a pack: a conversation. Priced like the others it would be a
              guess, and left out entirely a large team is left wondering
              whether they are catered for at all. */}
          <Link
            className="pack-card pack-card-custom"
            to={`/contact?reason=${encodeURIComponent('Hiring on Cursus')}`}
          >
            <span className="pack-total">Enterprise deal</span>
            <span className="pack-unit">
              {reveals
                ? 'High volume hiring'
                : triage
                  ? `More than ${catalogue.triageSelfServeMax} CVs, or custom limits`
                  : `Teams over ${seats.selfServeMax} additional seats`}
            </span>
            <span className="pack-badge pack-badge-quiet">Contact sales</span>
          </Link>
        </div>

        {/*
         * §14.3 — the arithmetic, shown rather than asserted.
         *
         * "Add 2 seats for ₪204" invites the question of why two seats cost
         * more than the two-seat price. Three lines answer it before it is
         * asked: this is the price of owning five, you have already paid for
         * three, here is the difference.
         */}
        {product === 'seats' && quote && quote.formatted && quote.seats !== quote.current && (
          <table className="fee-table quote-table">
            <tbody>
              <tr>
                <td className="muted">
                  {quote.current === 0
                    ? 'No seat subscription'
                    : `${quote.current} additional seat${quote.current === 1 ? '' : 's'} today`}
                </td>
                <td className="fee-amount muted">{quote.formatted.currentMonthly} / month</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>
                  {quote.seats === 0
                    ? 'Cancel (administrator only)'
                    : `${quote.seats} additional seat${quote.seats === 1 ? '' : 's'}`}
                </td>
                <td className="fee-amount">{quote.formatted.monthly} / month</td>
              </tr>
            </tfoot>
          </table>
        )}

        {/*
          Cancelling, out of the row of tiers.

          Nothing is not a tier, and as a sixth card it wrapped the row and put
          Enterprise on a line of its own. It is also a different kind of
          decision from "which plan" — quieter, and below the thing it undoes.
        */}
        {product === 'seats' && seats.purchased > 0 && (
          <p className="seat-cancel-row">
            <button
              type="button"
              className={`link-button${chosen?.quantity === 0 ? ' link-button-on' : ''}`}
              onClick={() => {
                setPick((was) => ({ ...was, seats: { key: 'seats_0', quantity: 0 } }))
                setNotice('')
              }}
            >
              Cancel the seat subscription
            </button>
            <span className="muted"> (keep only your administrator account).</span>
          </p>
        )}

        <div className="billing-cta">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !chosen
              || (product === 'seats' && (!quote || quote.seats === quote.current))}
            onClick={() => { setNotice(''); setConfirming(product) }}
          >
            {busy
              ? 'Working…'
              : reveals || triage
                /* The amount is on the selected pack above and again in the
                   confirmation below. On the button it only made the label
                   jump about as the selection changed. */
                ? <>Next <Arrow /></>
                : quote?.seats === quote?.current
                  /* No arrow: this is a state, not a step. Pointing onward from
                     a button that cannot be pressed would promise a next
                     screen that is not coming. */
                  ? 'Current plan'
                  : quote?.reducing
                    ? (quote.seats === 0
                      ? <>Cancel the subscription <Arrow /></>
                      /* The price came off both seat labels for the reason it
                         came off the pack button: it is stated on the card
                         above and again in the confirmation, and on a button it
                         only jumped about as the number of seats changed. */
                      : <>Modify plan <Arrow /></>)
                    : <>Upgrade subscription <Arrow /></>}
          </button>
        </div>

        {/*
         * §12 — off unless it is turned on, and never preselected. An automatic
         * charge nobody asked for is the fastest way to lose a customer's trust
         * in a balance they cannot see move. Reveals only: adding a person is a
         * deliberate act, and auto-buying capacity would be a surprise charge.
         */}
        {reveals && (
          <div className="replenish-row">
            <label className="field-label" htmlFor="auto-replenish">
              Top up automatically when the balance reaches zero
            </label>
            <select
              id="auto-replenish"
              value={autoReplenish.pack ?? ''}
              onChange={(e) => setReplenish(e.target.value || null)}
            >
              <option value="">Off (ask me each time)</option>
              {catalogue.reveals.map((pack) => (
                <option key={pack.key} value={pack.key}>
                  {pack.quantity} reveals: {pack.formattedTotal}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* One confirmation for all three products: the question is the same
          shape and the amount is the only variable. */}
      {confirming && (
        <div className="alert alert-warn convo-confirm">
          <p>
            {confirming === 'reveals' ? (
              <>
                Buy <strong>{chosen?.quantity} reveals</strong> for{' '}
                <strong>{chosen?.formattedTotal}</strong>? They are added to your organization
                balance immediately and do not expire.
              </>
            ) : confirming === 'triage' ? (
              <>
                Buy <strong>{chosen?.quantity} CVs of Triage capacity</strong> for{' '}
                <strong>{chosen?.formattedTotal}</strong>? Capacity is shared across every Triage
                workspace in your organization. It is added immediately, does not expire, and your
                reveal balance and seats are not affected.
              </>
            ) : (
              quote?.reducing ? (
                /*
                 * Giving a seat up is the case worth spelling out. Nobody is
                 * removed, nothing is refunded, and the capacity does not go
                 * today — three things an administrator would otherwise have to
                 * find out by watching what happens.
                 */
                <>
                  {seatQty === 0
                    ? <>Cancel your seat subscription?</>
                    : <>Reduce to <strong>{seatQty} additional seat{seatQty === 1 ? '' : 's'}</strong>
                      {' '}at <strong>{quote?.formatted?.monthly}</strong> a month?</>}
                  {' '}You have paid to <strong>{formatSeatDate(quote?.effectiveFrom)}</strong>, so
                  your {seats.purchased} current seat{seats.purchased === 1 ? '' : 's'} stay usable
                  until then, and nothing is refunded. From that day the account holds{' '}
                  {(seats.included ?? 1) + seatQty} in total. Your reveal balance is not affected.
                  {quote?.atRisk?.length > 0 && (
                    <>
                      {' '}
                      <strong className="seat-risk">
                        {quote.atRisk.length === 1
                          ? `${quote.atRisk[0].name}'s account will be deleted that day`
                          : `${quote.atRisk.length} accounts will be deleted that day: `
                            + quote.atRisk.map((p) => p.name).join(', ')}
                      </strong>
                      {' '}unless you remove someone yourself before then. The newest accounts go
                      first; yours is never one of them.
                    </>
                  )}
                </>
              ) : (
                <>
                  Subscribe to <strong>{seatQty} additional seat{seatQty === 1 ? '' : 's'}</strong>
                  {' '}at <strong>{quote?.formatted?.monthly}</strong> a month? This replaces your
                  current seat subscription and takes your team to{' '}
                  {(seats.included ?? 1) + seatQty} accounts in total, starting today. Your reveal
                  balance is not affected.
                </>
              )
            )}
          </p>
          <div className="convo-confirm-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                if (confirming === 'reveals') return buyReveals(chosen)
                if (confirming === 'triage') return buyTriages(chosen)
                return changeSeatPlan()
              }}
            >
              {busy
                ? 'Working…'
                : confirming === 'seats' ? 'Confirm subscription' : 'Confirm purchase'}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------- ledger --- */}
      <section className="billing-section">
        {/*
          Folded away, because it is the longest thing on this screen and the
          least often wanted.

          Somebody opens Billing to buy something or to read a balance; the
          ledger is what they consult afterwards, when a charge is queried. Left
          open it pushed the packs — the reason for the visit — up off the
          screen and made them read as a preamble to a table.

          Shut by default, and the count is in the label, so folding it does not
          hide the fact that there is something to look at.
        */}
        <button
          type="button"
          className={`disclosure-toggle${historyOpen ? ' disclosure-toggle-open' : ''}`}
          aria-expanded={historyOpen}
          aria-controls="billing-history"
          onClick={() => setHistoryOpen((was) => !was)}
        >
          <span>
            History
            {ledger.length > 0 && (
              <span className="muted">
                {' · '}{ledger.length} {ledger.length === 1 ? 'entry' : 'entries'}
              </span>
            )}
          </span>
          <Caret />
        </button>

        <div id="billing-history" hidden={!historyOpen}>
        {/*
          Which of the three the entry is about.

          The ledger runs them together because they share a balance sheet, not
          because they are one thing — a seat charge and a reveal spend answer
          different questions, and somebody checking "what happened to our
          reveals" should not have to read past a month of seat renewals. The
          product is on every row already; this only stops showing the others.
        */}
        {ledger.length > 0 && (
          <div className="role-switch history-filter" role="group" aria-label="Show">
            {[['all', 'All'], ['reveal', 'Reveals'], ['seat', 'Seats'], ['triage', 'Triage']]
              .map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`role-option${historyKind === key ? ' role-option-on' : ''}`}
                  aria-pressed={historyKind === key}
                  onClick={() => setHistoryKind(key)}
                >
                  {label}
                </button>
              ))}
          </div>
        )}
        {shownLedger.length === 0 ? (
          <p className="muted">
            {ledger.length === 0 ? 'Nothing yet.' : 'Nothing under this heading yet.'}
          </p>
        ) : (
          <table className="fee-table">
            <thead>
              <tr>
                <th>Date</th><th>What</th><th>Who</th>
                <th className="fee-amount">Change</th><th className="fee-amount">Amount</th>
              </tr>
            </thead>
            <tbody>
              {/*
               * §13 — every movement, including the ones nobody paid for. A
               * ledger that lists only purchases cannot answer "where did the
               * other forty go", which is the question it is opened for.
               */}
              {shownLedger.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.createdAt).toLocaleDateString()}</td>
                  <td>{entry.note}</td>
                  <td>{entry.actor ?? <span className="muted">—</span>}</td>
                  <td className={`fee-amount ${entry.delta < 0 ? 'ledger-out' : 'ledger-in'}`}>
                    {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                  </td>
                  <td className="fee-amount">
                    {entry.formattedAmount ?? <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </div>
      </section>
    </div>
  )
}

// --------------------------------------------------------- search + match ---

/**
 * The Job Match Profile, in the shape the requirement chips already speak.
 *
 * The server now classifies requirements into must-haves and preferences
 * itself, which is what the old parse step was guessing at — so this is a
 * rename, not a reinterpretation.
 */
function criteriaFromJobProfile(profile) {
  return {
    title: profile?.title ?? '',
    requiredSkills: (profile?.mustHaves ?? []).map((item) => item.requirement),
    preferredSkills: (profile?.preferred ?? []).map((item) => item.requirement),
    interpretation: profile?.interpretation ?? null,
    hardConstraints: profile?.hardConstraints ?? [],
  }
}

/** Criterion results, split back into the four lists the cards render. */
function splitCriteria(items = []) {
  const pick = (cls, met) => items
    .filter((item) => item.class === cls && (item.assessment === 'meets') === met)
    .map((item) => item.requirement)

  const missingRequired = pick('must-have', false)

  return {
    matchedRequired: pick('must-have', true),
    missingRequired,
    matchedPreferred: pick('preferred', true),
    missingPreferred: pick('preferred', false),
    meetsAllRequired: missingRequired.length === 0,
  }
}

/**
 * Bridges the staged response onto the shape the result list already uses.
 *
 * Deliberately an adapter rather than a rewrite of every card: the presentation
 * did not change, only where the numbers come from. `total` is the pool on file,
 * which the staged endpoint does not resend on every batch.
 */
function adaptSearch(data, totalOnFile) {
  return {
    total: totalOnFile ?? data.results.length,
    shown: data.results.length,
    results: data.results.map((row) => ({ ...row, ...splitCriteria(row.analysis?.criteria) })),
    scoring: {
      ...data.scoring,
      engine: data.scoring.model === 'deterministic' ? 'deterministic' : 'claude',
      analysed: data.scoring.analysedUniverse,
      aiAvailable: data.scoring.model !== 'deterministic',
    },
    jobProfile: data.jobProfile,
    batchIndex: data.batchIndex,
    exhausted: data.exhausted,
  }
}

function SearchTab({ me, folders, setFolders, onControls }) {
  const [query, setQuery] = useState('')
  const [instruction, setInstruction] = useState('')
  const [criteria, setCriteria] = useState(null)
  const [response, setResponse] = useState(null)
  const [filters, setFilters] = useState(EMPTY_RESULT_FILTERS)
  // Where this search has got to. Held apart from `response` because Show More
  // replaces the results but continues the same session.
  const [session, setSession] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const [chats, setChats] = useState([])
  const [chatId, setChatId] = useState(null)

  /*
   * Which candidate is being filed, if any.
   *
   * Held by the list rather than by the card, so there is one dialog on the
   * page however many rows are on it — twenty cards each holding their own
   * would be twenty portals waiting to be told to open.
   */
  const [filing, setFiling] = useState(null)
  /*
   * Ruled out of THIS search. Server-held, so reopening the search — which
   * re-runs it — does not bring them all back.
   */
  const [dismissed, setDismissed] = useState([])
  /* Revealing from the list spends from the same balance the dialog spends
     from, and the header has to move when it does. */
  const { wallet, spend } = useContext(WalletContext)

  const [totalOnFile, setTotalOnFile] = useState(null)
  /* Whether the description is unlocked for editing. Held apart from `response`
     so amending a brief does not throw away the results being amended. */
  const [editing, setEditing] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    /* A count, not a list: the route hands back a number now. */
    get('/api/hr/candidates', 'recruiter')
      .then((data) => setTotalOnFile(data.total))
      .catch((err) => setError(err.message))

    get('/api/hr/chats', 'recruiter')
      .then((data) => setChats(data.chats))
      .catch(() => {})
  }, [])

  /*
   * The search this company registered from, picked back up.
   *
   * A recruiter who tried the demo on the landing page, pressed Reveal and
   * created an account should not have to find the job description again — the
   * whole promise made at the gate was that the search would be waiting. The
   * text is put back and re-run, which resolves to the same job by hash and
   * resumes its existing session, so the ranking is the one they were shown
   * rather than a fresh one that might differ.
   *
   * Once only, guarded by a ref: this must not fire again when the panel
   * re-renders, or every render would re-run a search the recruiter may have
   * already moved on from.
   */
  const resumed = useRef(false)
  useEffect(() => {
    const pending = me?.resumeSearch
    if (!pending?.jobDescription || resumed.current) return
    resumed.current = true
    setQuery(pending.jobDescription)
    /* The candidate they were trying to reveal, opened with the results so
       they land on the person rather than on the list. */
    if (pending.candidateId) setOpenId(pending.candidateId)
    search(pending.jobDescription)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.resumeSearch?.jobId])

  /**
   * One action: read the description for requirements, then rank against them.
   * The extracted requirements are shown alongside the results so the score
   * stays legible — and so a bad reading is obvious rather than silent.
   *
   * `existingChatId` is passed when reopening a saved search, because the
   * chatId state has not committed yet at that point.
   */
  /**
   * One submission per search. `existingChatId` is only ever passed when
   * reopening a saved search to re-run it — a fresh search always starts its
   * own chat, so a chat and a job description stay one to one.
   */
  async function search(text = query, existingChatId = null, steer = instruction, { refresh = false } = {}) {
    const asked = String(text).trim()
    if (!asked) return

    setBusy(true)
    setError('')
    /* Submitting ends an edit: the box locks again around whatever was run. */
    setEditing(false)

    try {
      // The staged pipeline reads the description itself and keeps the result,
      // so there is no separate parse call and no second reading of the same
      // text. Everything the old two-step produced comes back in one response.
      const data = await post('/api/hr/search', {
        jobDescription: asked,
        instruction: steer,
        chatId: existingChatId,
        refresh,
      }, 'recruiter')

      const parsed = criteriaFromJobProfile(data.jobProfile)

      setCriteria(parsed)
      setResponse(adaptSearch(data, totalOnFile))
      /* Who was ruled out of this search, as the server has it — a re-run must
         not bring back the people already dismissed from it. */
      setDismissed(data.dismissed ?? [])
      setSession({ id: data.sessionId, canShowMore: data.canShowMore })
      setOpenId(null)
      setFilters(EMPTY_RESULT_FILTERS)

      // Re-running a saved search restores it rather than recording it again —
      // it is the same job description, asked once.
      if (existingChatId !== null) {
        setChatId(existingChatId)
        return
      }

      // Saving the search must never cost the recruiter their results.
      try {
        const saved = await post('/api/hr/chats', {
          query: asked,
          instruction: steer,
          criteria: parsed,
          shown: data.results.length,
          total: totalOnFile ?? data.results.length,
        }, 'recruiter')
        setChatId(saved.chatId)
        setChats(saved.chats)
        // The search just created its own folder.
        if (saved.folders) setFolders(saved.folders)
      } catch {
        // History is a convenience; a failure here is not worth surfacing.
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * The next batch of candidates.
   *
   * Only the new people are analysed; everyone already shown keeps their place.
   * Scores can move, because they are relative to everyone analysed for this
   * job so far — the note under the filters says so.
   */
  async function showMore() {
    if (!session?.id || loadingMore) return

    setLoadingMore(true)
    setError('')
    try {
      /* The chat, so the next batch comes back knowing who has already been
         ruled out of this search. */
      const data = await post(`/api/hr/search/${session.id}/more`, { chatId }, 'recruiter')
      setResponse(adaptSearch(data, totalOnFile))
      setDismissed(data.dismissed ?? [])
      setSession({ id: data.sessionId, canShowMore: data.canShowMore })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  function newSearch() {
    setChatId(null)
    setDismissed([])
    setQuery('')
    setInstruction('')
    setCriteria(null)
    setResponse(null)
    setSession(null)
    setOpenId(null)
    setError('')
    setFilters(EMPTY_RESULT_FILTERS)
  }

  /**
   * Reopening re-runs the search rather than restoring a stored result list —
   * candidates are added and deleted, so a frozen list would go stale.
   */
  /**
   * Unlock the description so it can be edited in place.
   *
   * Only the lock is lifted — the results stay on screen underneath, because
   * the recruiter is amending a brief, not abandoning it, and clearing the list
   * the moment they click Modify would punish them for looking. Submitting
   * replaces them; pressing Modify and changing nothing costs nothing.
   */
  function modifySearch() {
    setEditing(true)
  }

  /**
   * Run the same brief against the pool as it stands now.
   *
   * The server is told this is a refresh, which makes it build a new retrieval
   * session instead of resuming the stored one — otherwise "look again" would
   * return the identical ranking, because a resumed session can only show the
   * set that existed when it was made. Candidates already read are reused from
   * cache, so this costs only the people nobody has looked at yet.
   */
  async function refreshSearch() {
    if (!query.trim() || busy) return
    await search(query, chatId, instruction, { refresh: true })
  }

  async function openChat(id) {
    setError('')
    try {
      const { chat } = await get(`/api/hr/chats/${id}`, 'recruiter')
      const asked = chat.turns.find((turn) => turn.role === 'user')
      const steer = asked?.results?.instruction ?? ''

      setChatId(chat.id)
      setQuery(asked?.content ?? '')
      setInstruction(steer)
      if (asked?.content) await search(asked.content, chat.id, steer)
    } catch (err) {
      setError(err.message)
    }
  }

  async function renameChat(id, title) {
    try {
      const data = await patch(`/api/hr/chats/${id}`, { title }, 'recruiter')
      setChats(data.chats)
      // Renaming a search renames its folder too.
      if (data.folders) setFolders(data.folders)
    } catch (err) {
      setError(err.message)
    }
  }

  async function deleteChat(id) {
    try {
      const data = await del(`/api/hr/chats/${id}`, 'recruiter')
      setChats(data.chats)
      if (id === chatId) newSearch()
    } catch (err) {
      setError(err.message)
    }
  }

  /**
   * Saving from the results needs no decision: every search owns a folder named
   * after it, and that is where a saved candidate goes. Moving them elsewhere
   * afterwards is a drag away, or the picker in a folder's own dialog.
   *
   * The server decides where a saved candidate goes and creates the folder if
   * this search has not got one. Previously the button needed a folder id the
   * client had already computed, so it silently did nothing whenever that was
   * missing — or pointed at a folder since deleted.
   *
   * There was a second handler here, addToFolder, passed to the dialog as
   * onAddToFolder to draw a folder picker in it. The dialog renders that picker
   * only when it has no onSave — because a screen with both would be offering
   * the same act twice — and this screen has always passed both, so the picker
   * never appeared and the handler was never called. It is gone; the menu's Add
   * to folder is the route from a search result, and it is the one the product
   * describes.
   */
  /** Which folder this candidate is in, if any. */
  function folderHolding(candidateId) {
    return folders.find(
      (folder) => folder.items?.some((item) => item.candidate_id === candidateId),
    )?.id ?? null
  }

  /*
   * Filing from a search, including into a folder that does not exist yet.
   *
   * Shaped like moveToFolder in the Folders tab — (candidateId, folderId) with
   * 'new' meaning "ask for a name first" — so the profile dialog can be handed
   * either one and does not need to know which list it was opened from.
   */
  async function fileFromSearch(candidateId, folderId) {
    if (folderId === 'new') {
      const name = prompt('Name the new folder', 'Shortlist')
      if (name === null || !name.trim()) return
      /* Made first, then filed into: the create returns the id the save needs,
         and a failure here means nothing was moved. */
      const made = await post('/api/hr/folders', { name: name.trim() }, 'recruiter')
      setFolders(made.folders)
      await saveToSearchFolder(candidateId, made.id)
      return
    }
    await saveToSearchFolder(candidateId, folderId)
  }

  async function saveToSearchFolder(candidateId, folderId = null) {
    if (!session?.id) {
      setError('Run a search before saving candidates.')
      return
    }

    try {
      /*
       * What this row is showing, sent with it.
       *
       * A folder has no job description behind it, so the score cannot be asked
       * for again later — it only exists relative to the search that produced
       * it. Saving the reading alongside the candidate is what lets the folder
       * answer "why did we shortlist this person" months afterwards.
       */
      const row = response?.results?.find((entry) => entry.candidate.id === candidateId)
      const snapshot = row ? {
        score: row.score,
        reasoning: row.analysis?.reasoning ?? null,
        matchedRequired: row.matchedRequired ?? [],
        missingRequired: row.missingRequired ?? [],
        matchedPreferred: row.matchedPreferred ?? [],
        missingPreferred: row.missingPreferred ?? [],
      } : null

      const data = await post(
        `/api/hr/search/${session.id}/save`,
        /* Absent rather than null when no folder was named: the route treats
           the key being present as an instruction, and null is not one. */
        folderId ? { candidateId, snapshot, folderId } : { candidateId, snapshot },
        'recruiter',
      )
      setFolders(data.folders)
      setResponse((prev) => prev && {
        ...prev,
        results: prev.results.map((row) => (
          row.candidate.id === candidateId ? { ...row, folder: data.folder } : row
        )),
      })
      // The sidebar shows a saved count per search.
      get('/api/hr/chats', 'recruiter').then((d) => setChats(d.chats)).catch(() => {})
    } catch (err) {
      // Surfaced rather than swallowed: a Save that fails quietly is worse than
      // one that fails loudly, because the recruiter believes it worked.
      setError(err.message)
    }
  }

  /**
   * Reveal, from the list.
   *
   * The same route the profile dialog uses, so the charge, the free case for a
   * candidate a colleague already revealed, and the balance all behave
   * identically — this only saves a recruiter from opening four dialogs to
   * reveal four people. Asked first, because it spends money.
   */
  async function revealFromList(candidateId, name) {
    if (wallet?.balance === 0) {
      setError('No reveals left. Your organization needs another Reveal Pack.')
      return
    }
    if (!confirm(`Reveal ${name}? This costs 1 reveal; you have ${wallet?.balance ?? 0}.`)) return

    try {
      const result = await post(`/api/hr/candidates/${candidateId}/reveal`, {}, 'recruiter')
      /* Only when something was actually spent: a candidate a colleague already
         revealed is free, and decrementing the header for it would tell the
         recruiter they had paid twice. */
      if (result.charged) spend(result.balance)
      markRevealed(candidateId, result)
    } catch (err) {
      setError(err.message)
    }
  }

  /**
   * The row catches up with a reveal that has already happened.
   *
   * Called by revealFromList above and by the profile dialog, which spends on
   * its own account — without it the list keeps the masked name and the struck
   * -through eye behind an open profile showing the person's full details.
   */
  function markRevealed(candidateId, payload) {
    setResponse((prev) => prev && {
      ...prev,
      results: prev.results.map((row) => (row.candidate.id === candidateId
        ? {
          ...row,
          revealed: true,
          revealedBy: payload?.revealedBy ?? row.revealedBy ?? null,
          candidate: { ...row.candidate, ...(payload?.candidate ?? {}) },
        }
        : row)),
    })
  }

  /**
   * Not relevant — here, and nowhere else.
   *
   * Needs a saved search to belong to: the judgement is about this role, so
   * there is nothing to attach it to until the search has a chat. Every search
   * run from this screen has one, which is why this only guards rather than
   * explains.
   */
  async function dismissFromList(candidateId) {
    if (!chatId) {
      setError('Run a search before hiding candidates from it.')
      return
    }
    try {
      const data = await post(`/api/hr/chats/${chatId}/dismissed`, { candidateId }, 'recruiter')
      setDismissed(data.dismissed)
    } catch (err) {
      setError(err.message)
    }
  }

  /* Every tag worn by anybody in these results, once each — what the tag
     filter offers. Taken from the rows rather than from the whole company, so
     the list cannot offer a tag that would return nothing. */
  const tagOptions = tagsIn(response?.results)

  /** The row's tags changed; the list it belongs to has to know. */
  function tagsChanged(candidateId, next) {
    setResponse((prev) => prev && {
      ...prev,
      results: prev.results.map((row) => (
        row.candidate.id === candidateId ? { ...row, tags: next } : row
      )),
    })
  }

  /* Ruled out of this search, and so not in it. Applied after the filters
     rather than inside them: a dismissal is not a filter a recruiter can turn
     off in the bar, it is a decision they made about this role. */
  const hidden = new Set(dismissed)
  const visible = response
    ? applyResultFilters(response.results, filters).filter((row) => !hidden.has(row.candidate.id))
    : []

  /*
   * What the score means, as one string for the (i) beside the filter.
   *
   * Assembled here rather than in the filter bar because every part of it comes
   * from the search response; the bar only has to render it.
   */
  /*
   * How the scores relate to each other, and nothing else.
   *
   * Two further sentences used to follow: which engine did the reading, and how
   * many profiles came from cache. Both describe how the answer was produced
   * rather than how to read it — an environment variable and a cache-hit count
   * are operator's notes, and this bubble is what a recruiter opens to find out
   * whether an 82 beats a 79.
   */
  const scoringNote = response?.scoring?.explanation ?? ''

  /*
   * Hand the rail what it needs to drive this screen.
   *
   * The data — the chat list and which one is open — is republished whenever it
   * changes, so the rail's highlight follows the search rather than lagging a
   * render behind it.
   *
   * The four functions are sent through a ref that every render refreshes, and
   * the wrappers around it never change identity. Sending the functions
   * themselves on `[chats, chatId]` looked equivalent and was not: they are
   * rebuilt on every render and close over everything else on this screen, so
   * the rail held whichever versions existed the last time the chat list
   * changed. openChat runs a search, and a search reads totalOnFile — which
   * arrives from its own request, on its own schedule — so reopening a saved
   * search from the rail could report the count from before that landed. A ref
   * cannot go stale, because it is read at the moment of the call.
   */
  const latest = useRef({})
  latest.current = { newSearch, openChat, renameChat, deleteChat }

  const railControls = useMemo(() => ({
    newSearch: () => latest.current.newSearch(),
    openChat: (id) => latest.current.openChat(id),
    renameChat: (id, title) => latest.current.renameChat(id, title),
    deleteChat: (id) => latest.current.deleteChat(id),
  }), [])

  useEffect(() => {
    onControls?.({ chats, chatId, ...railControls })
  }, [chats, chatId, onControls, railControls])

  // Before the first search the composer owns the page; afterwards it splits,
  // search on the left and results on the right.
  if (!response) {
    return (
      <div className="search-page">
        <div className="search-stage">
          <SearchHero
            recruiter={me.recruiter}
            value={query}
            onChange={setQuery}
            instruction={instruction}
            onInstructionChange={setInstruction}
            onSubmit={() => search()}
            busy={busy}
          />
          {error && <p className="alert alert-error search-footnote">{error}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="search-page">
      <div className="search-split">
      <div className="search-split-top">
        {/* Locked once submitted: one search is one job description, and a
            different role is a different search. */}
        <SearchHero
          recruiter={me.recruiter}
          value={query}
          onChange={setQuery}
          instruction={instruction}
          onInstructionChange={setInstruction}
          onSubmit={() => search()}
          onNewSearch={newSearch}
          onModify={modifySearch}
          onRefresh={refreshSearch}
          busy={busy}
          compact
          submitted={!editing}
        />

        {criteria && (
          <div className="criteria-readout">
            {criteria.title && <span className="chip chip-neutral">{criteria.title}</span>}
            {criteria.requiredSkills.map((skill) => (
              <span key={skill} className="chip chip-required">{skill}</span>
            ))}
            {criteria.preferredSkills.map((skill) => (
              <span key={skill} className="chip chip-preferred">{skill}</span>
            ))}
            {/* Nothing is said when no skills were recognised. The chips are a
                readout of what was found, and a sentence explaining that the
                readout is empty says less than the empty space does. */}
          </div>
        )}

        <StatusNotice error={error} onDismiss={() => setError('')} />
      </div>

      {/*
        Where to file the candidate whose menu asked.

        Both paths go through saveToSearchFolder, which is the only one that
        carries the reading the recruiter is looking at — the displayed score
        is normalised against the pool that was searched and is stored nowhere,
        so filing through any other route would file them with no score at all.
      */}
      {filing !== null && (
        <FolderDialog
          folders={folders}
          inFolderId={folderHolding(filing)}
          onPick={(folderId) => fileFromSearch(filing, folderId)}
          onNewFolder={() => fileFromSearch(filing, 'new')}
          onClose={() => setFiling(null)}
        />
      )}

      <div className="search-split-bottom">
        <ResultFilters
          filters={filters}
          onChange={setFilters}
          shown={visible.length}
          matched={response.results.length}
          total={response.total}
          note={scoringNote}
          tags={tagOptions}
        />

        {/*
          What the dot beside each photo means, said once above the list.

          A colour with no key is a puzzle, and hovering every row to find out
          is not a legend. One line here answers it for the whole list.
        */}
        {/*
          Each dot wrapped with its own sentence.

          Laid out as four loose children, the row wrapped wherever it ran out
          of width — which put the red dot at the end of the green sentence and
          left its own explanation stranded on the next line, saying the exact
          opposite of what it sat beside.
        */}
        {/*
          One key, not two.

          The pair read as a scale to choose between, when only the green dot
          carries information a recruiter acts on: this person has been here
          recently. The absence of a dot says the rest, and did not need a
          sentence of its own asserting that nothing is known.
        */}
        <p className="muted activity-legend">
          <span className="activity-key">
            <span className="activity-dot activity-dot-on" aria-hidden="true" />
            Active in the last 30 days
          </span>
        </p>

        {/* The same words, now behind the (i) beside the filter — see the
            scoringNote built above. */}

        <div className="results-scroll">
          {visible.length === 0 ? (
            <div className="empty">
              <h2>Nothing matched</h2>
              <p className="muted">
                {response.results.length === 0
                  ? 'No candidate scored against this description.'
                  : 'Every result is hidden by the filters above.'}
              </p>
            </div>
          ) : (
            <ol className="result-list">
              {visible.map((result) => (
                <ResultCard
                  key={result.candidate.id}
                  result={result}
                  canSave
                  onSave={() => saveToSearchFolder(result.candidate.id)}
                  onFile={() => setFiling(result.candidate.id)}
                  meId={me?.recruiter?.id ?? null}
                  onReveal={() => revealFromList(result.candidate.id, result.candidate.display_name)}
                  onDismiss={chatId ? () => dismissFromList(result.candidate.id) : null}
                  onTagsChanged={tagsChanged}
                  onOpen={() => setOpenId(result.candidate.id)}
                />
              ))}
            </ol>
          )}

          {/* Only the next batch is read, not the whole database again. */}
          {session && (
            <div className="show-more">
              {session.canShowMore ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={loadingMore}
                    onClick={showMore}
                  >
                    {loadingMore
                      ? `Reading the next ${response.scoring.batchSize}…`
                      : `Show ${response.scoring.batchSize} more`}
                  </button>
                  <span className="muted">
                    {response.scoring.analysedUniverse} of {response.scoring.poolSize} shortlisted
                    candidates read so far. Scores are re-ranked across everyone read.
                  </span>
                </>
              ) : (
                <span className="muted">
                  Every shortlisted candidate for this job has been read.
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      </div>

      {openId !== null && (
        <CandidateDialog
          candidateId={openId}
          result={response.results.find((row) => row.candidate.id === openId) ?? null}
          folders={folders}
          /* The same three the result card offers, so the profile is not a
             dead end you have to close to act on. */
          /* The same filing the card offers, so the profile is not a dead end
             you have to close to act on. It used to show a dead "Saved in X"
             line here because no handler was passed. */
          onAddToFolder={fileFromSearch}
          onRevealed={(payload) => markRevealed(openId, payload)}
          onDismiss={chatId ? () => dismissFromList(openId) : null}
          onTagsChanged={tagsChanged}
          meId={me?.recruiter?.id ?? null}
          onClose={() => setOpenId(null)}
          onError={setError}
        />
      )}
    </div>
  )
}


/**
 * Every tag worn by anybody on a list, once each, in the order first met.
 *
 * The filter offers these rather than everything the company has ever written:
 * a dropdown that can return an empty list is a dropdown that wastes a press.
 */
function tagsIn(rows) {
  const seen = new Map()
  for (const row of rows ?? []) {
    for (const tag of row.tags ?? []) {
      if (!seen.has(tag.label)) seen.set(tag.label, tag)
    }
  }
  return [...seen.values()]
}

/**
 * A row in the result list. Everything beyond the summary lives in the popup,
 * so the list stays scannable and the detail has room to breathe.
 */
function ResultCard({
  result, onOpen, onSave, onFile, onReveal, onDismiss, onTagsChanged, onRemove,
  removeLabel = 'Remove', meId = null, canSave = false,
  /*
   * What sits in the bottom-right, when it is not a score.
   *
   * The reveal log lists people this company has paid to see, which is not a
   * ranking: the same person can be revealed out of one search and be nothing
   * to do with the next, so a percentage there would be a number measured
   * against a question nobody asked. The date is the fact that list is about,
   * and it goes exactly where the score goes so the card keeps its shape.
   */
  corner = null,
}) {
  const { candidate, documents = [] } = result
  const band = scoreBand(result.score)

  /*
   * What the ⋮ offers, built here so the corner can ask whether there is
   * anything to offer at all.
   *
   * Each entry is gated on the handler that performs it rather than on the
   * screen this card is drawn in: a card with no onReveal cannot reveal, and
   * offering it would be a menu item that does nothing. Reveal was gated on
   * `!result.revealed` alone, which meant an unrevealed candidate in a folder
   * — where nothing is passed — showed a Reveal that silently did nothing.
   */
  const menuItems = [
    canSave && {
      key: 'folder',
      label: 'Save in folder',
      onSelect: () => onFile?.(),
    },
    !result.revealed && onReveal && {
      key: 'reveal', label: 'Reveal', onSelect: () => onReveal(),
    },
    onDismiss && {
      key: 'dismiss', label: 'Not relevant', danger: true, onSelect: () => onDismiss(),
    },
    /*
     * The way out of a folder, last and marked as the destructive one.
     *
     * It was a × in the corner, on the reasoning that it had been a × on the
     * row before the row became this card. In the corner it sat between a
     * comment button and the dots, two pixels from both, with no confirmation
     * behind it — the easiest thing on the card to press by accident and the
     * only one that takes something away.
     */
    onRemove && {
      key: 'remove', label: removeLabel, danger: true, onSelect: () => onRemove(),
    },
  ].filter(Boolean)
  /*
   * What this team calls them. Read straight off the row, never copied into
   * state here: the list above is the one owner, tagsChanged writes to it, and
   * the profile dialog writes through the same function. A local copy seeded
   * once at mount ignored every one of those writes, so tagging somebody in
   * their profile left the row behind it still showing the old strip until the
   * next search.
   *
   * They arrive with the row rather than being fetched: the search response is
   * about the match, most rows are never tagged, and the strip appears only
   * when there is something to show.
   */

  const extras = documents.filter((slot) => slot.startsWith('additional')).length
  const saved = Boolean(result.folder)

  return (
    <li className="result">
      <div
        className="result-main" onClick={onOpen} role="button" tabIndex={0}
        title={`Open ${candidate.display_name ?? 'this candidate'}`}
        /* Only keystrokes that land on the card itself. The corner holds a tag
           editor and a comments panel with text boxes in them; without this,
           every space typed into a comment opened the candidate underneath. */
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
        }}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/candidate-id', String(candidate.id))}
      >
        {/* Photograph and identity are one thing on the left, so the grid is
            [lead] [score] [space] with the two flexible tracks equal — which is
            what puts the score on the card's centre line. With the avatar in a
            track of its own the score was pushed past centre by its width. */}
        <span className="result-lead">
          <span className="result-portrait">
            <CandidateAvatar candidate={candidate} />
          </span>

          <div className="result-identity">
          <h3>
            {/* Truncated rather than wrapped: the score sits on the card's
                centre line, so the name has half the card and a long one would
                otherwise push the dot onto a line of its own. */}
            <span className="result-name">{candidate.display_name}</span>
            {/* Availability, beside the name it describes. It sat on the photo,
                where it read as a property of the picture — and a recruiter
                scanning a column of names had to look somewhere else to find
                out whether the person is around. */}
            <ActivityDot activity={result.activity} />
            {result.unread > 0 && <span className="badge">{result.unread}</span>}
          </h3>
          <p className="muted">
            {[candidate.location, candidate.availability].filter(Boolean).join(' · ')}
          </p>

          </div>
        </span>

        <div className="result-side">
          {/*
            Everything that can be done to this person, in the corner, behind
            the same dots a folder row and a Triage row use.

            It was a Save button, which put one of three actions on the card and
            the other two behind opening the profile — so "reveal these four"
            meant four trips through a dialog. Its own stopPropagation: the card
            underneath opens the candidate.
          */}
          <span
            className="result-menu"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {/*
              Already paid for by this company, in the slot the reveal button
              would otherwise hold — the two are the same question answered
              either way, so they belong in the same place rather than one in
              the corner and the other among the chips two lines below.

              It stays a chip and not a button. There is nothing left to press:
              it reports a thing already done, and it says which colleague did
              it, which is the part a recruiter cannot work out for themselves —
              except when it was the reader, which is "me".
            */}
            {/*
              Where the candidate is filed, beside who opened them.

              Both are facts about what this team has already done with this
              person, and they were two lines apart — one among the chips under
              the summary, one in the corner. Together they read as a pair; the
              folder first, because being filed usually comes before being paid
              for.
            */}
            {/* The name alone. "Folder · Backend hires" spent a third of a
                narrow chip on a word that the chip's own colour, position and
                tooltip already say — and it sits beside a reveal chip that does
                not announce itself as a reveal either. The title still spells it
                out for anyone who needs it. */}
            {result.folder && (
              <span className="chip chip-folder" title={`Saved in your ${result.folder.name} folder`}>
                {result.folder.name}
              </span>
            )}
            {/*
              Where this row came from, when it did not come from a search.

              Only ever set on a folder row: a Triage applicant filed into a
              folder sits beside marketplace candidates and is otherwise
              indistinguishable — same card, same name, same location — while
              being a different kind of object. It has no profile to open, no
              freshness, and no inbox. The chip is the one thing on the row that
              says so, and it names the Triage rather than saying "Triage",
              because which pile a CV came out of is the useful half.
            */}
            {result.fromTriage && (
              <span
                className="chip chip-triage"
                title={result.fromTriage.title
                  ? `Uploaded to the ${result.fromTriage.title} Triage`
                  : 'Uploaded to a Triage'}
              >
                {result.fromTriage.title
                  ? `From ${result.fromTriage.title}`
                  : 'From a Triage'}
              </span>
            )}
            {result.revealed && (
              <span
                className="chip chip-revealed"
                title={result.revealedBy
                  ? `Revealed by ${result.revealedBy.name} on `
                    + `${new Date(result.revealedBy.at).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' })}`
                    + ' (free for everyone on your team).'
                  : 'Already revealed by your team (free to open).'}
              >
                {/* The word "Revealed" was doing the eye's job twice over. */}
                <EyeIcon size={13} />
                <span className="chip-dot" aria-hidden="true">·</span>
                <span className="chip-name">
                  {!result.revealedBy
                    ? 'Revealed'
                    : result.revealedBy.recruiterId === meId ? 'me' : result.revealedBy.name}
                </span>
              </span>
            )}
            {/*
              Reveal, first in the corner and only while there is something to
              reveal.

              It was a struck-through eye among the chips below the summary: it
              reported the state and offered no way out of it, while the action
              it was describing sat two levels down the ⋮ menu — on the one card
              in a list where a recruiter is most likely to want it. Same mark,
              moved to where it can be pressed.

              The title says the price. A reveal is spent, not free, so a button
              that says only "reveal" invites a click the recruiter would not
              have made knowingly.
            */}
            {/*
              AND onReveal, not just the state.

              This is the same mistake the ⋮ menu above had and had fixed: the
              button was gated on `!result.revealed` alone, so every unrevealed
              candidate in a folder — where no onReveal is passed — wore a
              struck-through eye that did nothing when pressed. It became
              visible again with Triage applicants, who are neither revealed nor
              revealable: a CV somebody uploaded has nothing to unlock, and the
              row was offering to unlock it.
            */}
            {!result.revealed && onReveal && (
              <button
                type="button"
                className="icon-button result-reveal"
                onClick={(event) => { event.stopPropagation(); onReveal() }}
                title={`Reveal ${candidate.display_name ?? 'this candidate'} — their contact `
                  + 'details and CV, for one reveal. Saving them to a folder is free.'}
                aria-label={`Reveal ${candidate.display_name ?? 'this candidate'}`}
              >
                <EyeOffIcon />
              </button>
            )}
            {/*
              Tags and comments hang off a candidate id, so they are drawn only
              where there is one.

              A Triage applicant filed into a folder has none — there is no
              marketplace profile behind them — and both of these would have
              posted to /api/hr/candidates/null/…. The row keeps the folder
              chip, the Triage chip and the ⋮; it loses the two controls that
              had nothing to act on.
            */}
            {candidate.id != null && (
              <>
            <TagEditor
              candidateId={candidate.id}
              tags={result.tags ?? []}
              /* Told to the list, which is what draws this row: the tag filter
                 offers what the rows are wearing, so a tag written here has to
                 reach the list or it cannot be filtered on until the next
                 search — and the strip below re-renders from the same write. */
              onChange={(next) => onTagsChanged?.(candidate.id, next)}
              label={`Tags on ${candidate.display_name ?? 'this candidate'}`}
            />
            <CommentsPopover
              candidateId={candidate.id}
              meId={meId}
              label={`Comments on ${candidate.display_name ?? 'this candidate'}`}
            />
              </>
            )}
            {/*
              The dots, and only when they have something behind them.

              This card is drawn in two places with different handlers, and in a
              folder every item filtered out: no canSave, no onReveal, no
              onDismiss, and the candidate already revealed. PopMenu rendered
              anyway, so pressing ⋮ opened an empty grey strip — a control that
              looked broken because it was doing exactly what it was told.
            */}
            {menuItems.length > 0 && (
              <PopMenu
                vertical
                label={`Actions for ${candidate.display_name ?? 'this candidate'}`}
                items={menuItems}
              />
            )}
          </span>

          {/*
            No number, no box.

            The score was drawn unconditionally, so a row with nothing to show
            rendered a lone "%" in the corner — which happened to every folder
            row filed without a search behind it, and to every Triage applicant
            now that folders hold those too. Absent is the honest rendering of
            absent; the alternative is a 0% that says something false.
          */}
          {corner ?? (Number.isFinite(result.score) && (
            <div className={`score score-${band}`}>
              {/* Out of a hundred, said as such. A bare 82 beside a name is a
                  number of something unstated, and the label under it said
                  "match" — which is the axis, not the unit. */}
              <span className="score-value">{result.score}%</span>
            </div>
          ))}
        </div>

        {/*
          What the person says about themselves, and how they scored, across the
          whole card rather than down one third of it.

          These used to sit inside the identity column — the left track of
          [person] [score] [space] — so a two-line summary was two lines of a
          column about 200px wide, which is four or five words a line. The
          preview looked like the whole summary, and the reasoning line below it
          wrapped four times. They are not part of the identity; they are what
          the row is for, and they get the row's width.

          It ends level with the comments button rather than at the card's edge,
          so nothing runs under the corner controls above it.
        */}
        <div className="result-say">
          {/*
            The summary is not here.

            It was two sentences of how the candidate describes themselves,
            under the name — which reads well on one card and badly on twenty:
            every row grew to the height of its longest self-description, and a
            list a recruiter is scanning for a name became a page of prose in
            which the names are the small text. Length varied by candidate, so
            the rows did not even line up.

            It is on the profile, in both states — before the reveal at the top
            of the panel, and after it above the tabs (ProfessionalSummary,
            twice). Nothing is lost; it is one click away rather than repeated
            twenty times down a list.
          */}

          {/*
            Two kinds of chip, and no more.

            The document chips are gone. "Cover letter" and "+2 documents" told
            a recruiter what was attached before they could open any of it, and
            what is attached is not a reason to open somebody — it is a detail
            of the profile, which is where it now lives alone. The folder chip
            has moved to the corner to sit beside the reveal it belongs with.

            What is left is what a recruiter has to read rather than glance at:
            an explicit "not open to opportunities", which a coloured dot cannot
            distinguish from having gone quiet, and the words this team put on
            this person themselves.
          */}
          <div className="result-tags">
            {result.activity?.state === 'deactivated' && (
              <ActivityChip activity={result.activity} />
            )}
            <TagStrip tags={result.tags ?? []} />
          </div>

          {/* Claude's read of the profile replaces the keyword summary when it
              ran — its reasoning is the thing worth reading. */}
          {result.analysis ? (
            <p className="reasoning-line">{result.analysis.reasoning}</p>
          ) : result.missingRequired.length > 0 ? (
            <p className="gap-line">Missing: {result.missingRequired.join(', ')}</p>
          ) : result.matchedRequired.length > 0 ? (
            <p className="hit-line">Meets all {result.matchedRequired.length} stated requirements</p>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/**
 * The rail's "+ New", and the two things it can start.
 *
 * Modelled on the sign-in menu rather than on PopMenu: PopMenu's trigger is a
 * fixed "⋯" glyph with dock styling and cannot render a labelled button, and
 * the behaviour worth copying — close on an outside press, close on Escape,
 * hand focus back when it does — is small enough to hold here.
 *
 * Each item carries a line about what it is for. "Search" and "Triage" are the
 * product's words for two things a newcomer has no way to tell apart, and a
 * menu that offers only the words makes them guess.
 */
function NewMenu({ onSearch, onTriage }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const trigger = useRef(null)

  /* This is where the shared hook came from — it was the only popup in the
     product that got this right, so it became the one everything uses. */
  useDismissOnOutside({
    ref: wrap,
    onDismiss: useCallback(() => setOpen(false), []),
    active: open,
    /* Escape has to hand focus back, or it is left on a menu that is gone. */
    focusOn: trigger,
  })

  function choose(run) {
    setOpen(false)
    run()
  }

  return (
    <div className="ws-new-wrap" ref={wrap}>
      <button
        type="button"
        className="ws-new"
        ref={trigger}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">+</span> New
        <Caret />
      </button>

      {open && (
        <div className="ws-new-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="ws-new-item"
            onClick={() => choose(onSearch)}
          >
            <strong><span aria-hidden="true">+</span> Search</strong>
            <span className="muted">Describe a role and we find the people</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ws-new-item"
            onClick={() => choose(onTriage)}
          >
            <strong><span aria-hidden="true">+</span> Triage</strong>
            <span className="muted">Sort CVs you already received</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** Onward, on the buttons that lead to a confirmation rather than act at once. */
function Arrow() {
  return (
    <svg
      className="btn-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  )
}

/** The eye, struck through: nobody has revealed this person. */
function EyeOffIcon({ size = 16 }) {
  return (
    <svg
      className="eye-icon" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M1.6 12S5.3 5.2 12 5.2 22.4 12 22.4 12 18.7 18.8 12 18.8 1.6 12 1.6 12Z" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M4 20 20 4" />
    </svg>
  )
}

// -------------------------------------------------------------- folders ---

/** A folder, drawn rather than an emoji so it takes the text colour. */
function FolderIcon() {
  return (
    <svg
      className="drive-icon" viewBox="0 0 24 24" width="22" height="22"
      fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7v7.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5Z" />
    </svg>
  )
}

/**
 * Everyone this company has revealed, newest first.
 *
 * A folder is a list somebody chose to build. This is the list the company
 * built by spending — every reveal it has ever paid for, whether or not anyone
 * then filed the person anywhere. It answers "who have we already unlocked?",
 * which before this had no screen: the only way to find out was to run a search
 * and notice the green badge, which does not work for a person no current
 * search returns.
 *
 * Deliberately not a folder. It has no ordering anybody controls, nothing can
 * be added to it by hand, and removing from it would mean unpaying — so it
 * lives beside Folders in the rail rather than inside them.
 */
function RevealsTab({ me, folders, setFolders, statuses = [] }) {
  const [reveals, setReveals] = useState(null)
  const [error, setError] = useState('')
  const [filters, setFilters] = useState(EMPTY_RESULT_FILTERS)
  const [openCandidate, setOpenCandidate] = useState(null)
  const [filing, setFiling] = useState(null)

  const load = useCallback(async () => {
    try {
      const data = await get('/api/hr/reveals', 'recruiter')
      setReveals(data.reveals ?? [])
      setError('')
    } catch (err) {
      setError(err.message)
      setReveals([])
    }
  }, [])

  useEffect(() => { load() }, [load])

  const rows = reveals ?? []
  const visible = applyResultFilters(rows, filters)

  /* The tags actually worn by the people on THIS list, so the filter cannot
     offer a label that would empty the screen. Same rule as the folder view. */
  const tagOptions = useMemo(() => {
    const seen = new Map()
    for (const row of rows) for (const tag of row.tags ?? []) seen.set(tag.id ?? tag.label, tag)
    return [...seen.values()]
  }, [rows])

  async function fileInto(candidateId, folderId) {
    try {
      /* Made first, then filed into, as the search does it: the create route
         only makes a folder, so filing is always the second call. */
      let target = folderId
      if (folderId === 'new') {
        const name = prompt('Name the new folder', 'Shortlist')
        if (name === null || !name.trim()) return
        const made = await post('/api/hr/folders', { name: name.trim() }, 'recruiter')
        setFolders(made.folders)
        target = made.id
      }

      const data = await post(`/api/hr/folders/${target}/items`, { candidateId }, 'recruiter')
      if (data.folders) setFolders(data.folders)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setFiling(null)
    }
  }

  return (
    <div className="drive">
      <div className="drive-head">
        <div>
          {/* "Reveal History", not "Reveals". The rail item beside Folders is
              still the short word — a nav label names a place, a heading says
              what is on the page, and this page is the record rather than the
              reveals themselves. */}
          <h2>Reveal History</h2>
          <p className="muted">
            Everyone your team has spent a reveal on. Shared with your whole company.
          </p>
        </div>
      </div>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      {/*
        The same funnel the searches and the folders use, minus the score.
        There is no percentage on this screen to narrow by — see the note on
        ResultCard's `corner`.
      */}
      {rows.length > 0 && (
        <ResultFilters
          filters={filters}
          onChange={setFilters}
          shown={visible.length}
          matched={rows.length}
          total={rows.length}
          statuses={statuses}
          showScore={false}
          tags={tagOptions}
          nameSearch
        />
      )}

      {reveals === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted triage-lede">
          Nobody has been revealed yet. Reveal a candidate from a search and they appear here,
          with the date and who spent the reveal.
        </p>
      ) : (
        <ol className="results">
          {visible.length === 0 && (
            <li className="drive-empty muted">Nothing here matches the filters.</li>
          )}

          {visible.map((item) => (
            <ResultCard
              key={item.candidate_id}
              result={{
                candidate: {
                  id: item.candidate_id,
                  display_name: item.display_name,
                  location: item.location,
                  availability: item.availability,
                  has_photo: item.has_photo,
                },
                score: null,
                folder: item.folder,
                revealed: true,
                tags: item.tags ?? [],
                activity: item.activity,
                analysis: null,
                matchedRequired: [],
                missingRequired: [],
              }}
              meId={me?.recruiter?.id ?? null}
              onOpen={() => setOpenCandidate(item.candidate_id)}
              canSave
              onFile={() => setFiling(item.candidate_id)}
              /*
               * The date, where the score would be.
               *
               * Who spent it goes underneath, and says "you" rather than
               * reading the reader their own name back — the same courtesy
               * revealIndex carries the recruiter id for.
               */
              corner={(
                <div className="result-revealed">
                  <span className="result-revealed-date">{formatDate(item.revealedAt)}</span>
                  <span className="result-revealed-by">
                    {item.revealedById === (me?.recruiter?.id ?? null)
                      ? 'by you'
                      : `by ${item.revealedBy ?? 'a former colleague'}`}
                  </span>
                </div>
              )}
            />
          ))}
        </ol>
      )}

      {filing !== null && (
        <FolderDialog
          folders={folders}
          onPick={(folderId) => fileInto(filing, folderId)}
          onNewFolder={() => fileInto(filing, 'new')}
          onClose={() => setFiling(null)}
          inFolderId={rows.find((r) => r.candidate_id === filing)?.folder?.id ?? null}
        />
      )}

      {openCandidate !== null && (
        <CandidateDialog
          candidateId={openCandidate}
          me={me}
          folders={folders}
          setFolders={setFolders}
          onClose={() => setOpenCandidate(null)}
        />
      )}
    </div>
  )
}

function FoldersTab({ me = null, folders, setFolders, statuses = [] }) {
  /* Finding one folder among many. A filter over what is already loaded, so it
     answers as you type and needs no request. */
  const [query, setQuery] = useState('')
  /*
   * How the list is ordered. Beside the search because they are the same job —
   * narrowing a list you cannot see all of — and a sort that lives somewhere
   * else is a sort nobody finds.
   *
   * "Size" is the candidate count, which is the only size a folder has.
   */
  const [sort, setSort] = useState('recent')
  const [sortOpen, setSortOpen] = useState(false)
  /* Ticking several and deleting them in one go. Shared with Triage — see
     ListSelect — so the two lists behave identically. */
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkNote, setBulkNote] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(null)
  const [openCandidate, setOpenCandidate] = useState(null)
  /*
   * Which candidate is being filed, if any.
   *
   * Held by the list rather than by the card, so one dialog serves however many
   * rows are on screen — twenty cards each holding their own would be twenty
   * portals waiting to be told to open. The search list does the same.
   */
  const [filing, setFiling] = useState(null)
  /* Which folder is open, by id rather than by object, so the row stays correct
     across a refetch that replaces every folder in the list. */
  const [openFolder, setOpenFolder] = useState(null)
  const [creating, setCreating] = useState(false)
  /*
   * Narrowing what is inside a folder.
   *
   * Kept here rather than inside the folder view so it survives closing and
   * reopening one — and reset when a different folder is opened, because a
   * filter carried silently from one shortlist to another is how a folder
   * looks empty for no visible reason.
   */
  const [filters, setFilters] = useState(EMPTY_RESULT_FILTERS)

  /*
   * The name box goes away the moment attention moves elsewhere.
   *
   * It used to close only on the + that opened it, so opening a folder or
   * pressing anything else left an empty input hanging over a page it no longer
   * had anything to do with. Anywhere outside the form and its own button
   * counts as elsewhere — including the folders themselves, which is the case
   * that made it look stuck.
   *
   * Registered on the document rather than wired into each control, because
   * "any other button" means the ones on this page today and the ones added to
   * it later. Bound while it is open only, so there is no listener sitting
   * there the rest of the time.
   */
  useEffect(() => {
    if (!creating) return undefined
    const dismiss = (event) => {
      /* The controls that OPEN the name field are exempt, or the same click
         that opens it closes it again: this listener is on the document, and
         the click that set `creating` is still on its way up. */
      if (event.target.closest?.('.folder-new, .drive-add, .folder-start')) return
      setCreating(false)
      setName('')
    }
    document.addEventListener('click', dismiss)
    return () => document.removeEventListener('click', dismiss)
  }, [creating])

  const opened = folders.find((folder) => folder.id === openFolder) ?? null

  /* pic 5 — the filter, applied to the list and nothing else. Case-insensitive
     and on the name only: a folder is found by what it is called. */
  const filteredFolders = query.trim()
    ? folders.filter((folder) => folder.name.toLowerCase().includes(query.trim().toLowerCase()))
    : folders

  /*
   * Sorted on a copy — `folders` is the server's list and the source of truth
   * for every other reader of it, so ordering it in place here would quietly
   * reorder the drag-and-drop targets and the move-to-folder menu as well.
   */
  const shownFolders = [...filteredFolders].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name)
    if (sort === 'size') return b.items.length - a.items.length
    if (sort === 'smallest') return a.items.length - b.items.length
    if (sort === 'oldest') return new Date(a.created_at) - new Date(b.created_at)
    return new Date(b.created_at) - new Date(a.created_at)
  })

  /* The same five Triage offers, in the same words and the same order. Size
     runs both ways on both lists: "which of these is nearly empty" is as real a
     question as "which is the big one". */
  const SORTS = [
    ['recent', 'Newest first'],
    ['oldest', 'Oldest first'],
    ['size', 'Most candidates'],
    ['smallest', 'Fewest candidates'],
    ['name', 'Name, A to Z'],
  ]

  /* Over the rows actually on screen: "Select all" means all of what the search
     has left, not all of what the server holds. */
  const selection = useSelection(shownFolders.map((folder) => folder.id))

  /*
   * Which folder the open candidate is filed under.
   *
   * Read from the folder list rather than remembered when the row was clicked:
   * moving them rewrites that list, and a value captured at click time would go
   * on naming the folder they just left.
   */
  const openIn = openCandidate === null
    ? null
    : folders.find((folder) => folder.items.some((item) => item.candidate_id === openCandidate)) ?? null

  /* The saved row itself, for the score it was filed with. */
  const openItem = openCandidate === null
    ? null
    : (openIn ?? opened)?.items?.find((item) => item.candidate_id === openCandidate) ?? null

  /* Placing a candidate is a move — the server takes them out of every other
     folder in the company first — so this needs no removal step of its own. */
  async function moveToFolder(candidateId, folderId) {
    let target = folderId

    try {
      if (target === 'new') {
        const name = prompt('Name the new folder', 'Shortlist')
        if (name === null || !name.trim()) return
        /* Inside the try with the move it precedes: a failed create used to
           reject out of an async function nobody awaited, so the folder was not
           made, the candidate was not moved, and the recruiter was told
           nothing at all. */
        const made = await post('/api/hr/folders', { name: name.trim() }, 'recruiter')
        setFolders(made.folders)
        target = made.id
      }

      const data = await post(`/api/hr/folders/${target}/items`, { candidateId }, 'recruiter')
      setFolders(data.folders)
    } catch (err) {
      setError(err.message)
    }
  }
  const visibleItems = opened ? applyResultFilters(opened.items, filters) : []
  const folderTagOptions = tagsIn(opened?.items)

  /** As on the search: a tag written here has to reach the list to be filtered on. */
  function tagsChanged(candidateId, next) {
    setFolders((prev) => prev.map((folder) => ({
      ...folder,
      items: folder.items.map((item) => (
        item.candidate_id === candidateId ? { ...item, tags: next } : item
      )),
    })))
  }

  useEffect(() => { setFilters(EMPTY_RESULT_FILTERS) }, [openFolder])

  async function create(event) {
    event.preventDefault()
    if (!name.trim()) return
    try {
      const data = await post('/api/hr/folders', { name }, 'recruiter')
      setFolders(data.folders)
      setName('')
      setCreating(false)
    } catch (err) {
      setError(err.message)
    }
  }

  async function rename(folder) {
    const next = prompt('Rename folder', folder.name)
    if (next === null || next.trim() === '' || next === folder.name) return
    try {
      setFolders((await patch(`/api/hr/folders/${folder.id}`, { name: next }, 'recruiter')).folders)
    } catch (err) {
      setError(err.message)
    }
  }

  /**
   * Several at once.
   *
   * One request each, in order, against the same route a single delete uses —
   * so a bulk delete cannot be permitted where a single one would not be, and
   * a failure part way through leaves the rest of the list exactly as the
   * server says it is rather than as this page guessed.
   */
  async function removeSelected() {
    setBulkBusy(true)
    setError('')
    setBulkNote('')

    const ids = [...selection.picked]
    const failed = []
    let latest = null

    for (const id of ids) {
      try {
        latest = await del(`/api/hr/folders/${id}`, 'recruiter')
      } catch (err) {
        failed.push(err.message)
      }
    }

    if (latest?.folders) setFolders(latest.folders)
    setBulkBusy(false)
    selection.close()

    if (failed.length) {
      setError(`${failed.length} of ${ids.length} could not be deleted. ${failed[0]}`)
    } else {
      setBulkNote(`${ids.length} folder${ids.length === 1 ? '' : 's'} deleted.`)
    }
  }

  async function remove(folder) {
    if (!confirm(`Delete "${folder.name}"? The candidates stay on file.`)) return
    try {
      setFolders((await del(`/api/hr/folders/${folder.id}`, 'recruiter')).folders)
    } catch (err) {
      setError(err.message)
    }
  }

  async function drop(event, folder) {
    event.preventDefault()
    setDragOver(null)

    const candidateId = Number(event.dataTransfer.getData('text/candidate-id'))
    if (!candidateId) return

    try {
      const data = await post(`/api/hr/folders/${folder.id}/items`, { candidateId }, 'recruiter')
      setFolders(data.folders)
    } catch (err) {
      setError(err.message)
    }
  }

  /**
   * The folder, downloaded as a spreadsheet.
   *
   * Fetched rather than linked. The route needs the recruiter's session the
   * same way every other one does, and an <a href> would send the browser off
   * without it — which lands on the sign-in page as a file called folder.xlsx.
   */
  async function exportFolder(folder) {
    try {
      const response = await fetch(`/api/hr/folders/${folder.id}/export`, {
        credentials: 'include',
      })
      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).error ?? 'That export failed.')
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${folder.name.replace(/[\/:*?"<>|]/g, ' ').trim() || 'folder'}.xlsx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      /* Released on the next turn of the loop: revoking it in the same tick
         cancels the download in some browsers before it has started. */
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (err) {
      setError(err.message)
    }
  }

  async function removeItem(candidateId) {
    try {
      setFolders((await del(`/api/hr/folders/items/${candidateId}`, 'recruiter')).folders)
    } catch (err) {
      setError(err.message)
    }
  }

  /* Unused since the picker left the row, and kept deliberately: the route and
     the column are still there, so restoring the control is putting a component
     back rather than rebuilding a feature. */
  // eslint-disable-next-line no-unused-vars
  async function setStatus(candidateId, status) {
    try {
      setFolders((await patch(
        `/api/hr/folders/items/${candidateId}/status`, { status }, 'recruiter',
      )).folders)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="folders-page">
      {/*
        Shaped like a file manager, because that is what it is.

        The board showed every folder's contents side by side, which reads well
        with two folders and not at all with ten — each column narrower than the
        card inside it. A list of folders you open is the arrangement every
        person already knows from Drive or Finder: the folders are the page, and
        one of them at a time is the contents.
      */}
      <div className="drive-bar">
        <nav className="drive-crumbs" aria-label="Folders">
          {opened ? (
            <>
              <button type="button" className="drive-crumb" onClick={() => setOpenFolder(null)}>
                Folders
              </button>
              <span className="drive-crumb-sep" aria-hidden="true">›</span>
              <span className="drive-crumb drive-crumb-here">{opened.name}</span>
            </>
          ) : (
            <span className="drive-crumb drive-crumb-here">Folders</span>
          )}
        </nav>

        {/* A plus, not a sentence. The input appears when it is pressed, which
            is also what stops an empty name box sitting above an empty page.

            Only at the root: inside a folder there is nowhere for a new one to
            go — folders do not nest — so the button would create something the
            page you are looking at could not show you. */}
        {!opened && (
          <button
            type="button"
            className="drive-add"
            aria-label="New folder"
            title="New folder"
            aria-expanded={creating}
            onClick={() => setCreating((was) => !was)}
          >
            +
          </button>
        )}

        {/*
          The name box hangs off the button that opens it.
          It used to appear as a full-width row further down the page, under the
          search — so pressing + moved the whole list and put the field nowhere
          near the thing you had just pressed. Anchored here it reads as what it
          is: a small question the button asked.
        */}
        {creating && !opened && (
          <form className="folder-new" onSubmit={create}>
            <input
              autoFocus
              value={name}
              placeholder="Folder name"
              aria-label="Folder name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setCreating(false); setName('') } }}
            />
            <button type="submit" className="btn btn-primary btn-small" disabled={!name.trim()}>
              Create
            </button>
          </form>
        )}
      </div>

      {/*
        Inside a folder, the same funnel the search results use — on its own
        row rather than in the bar above, which is a flex line sized for the
        breadcrumbs and would have the open panel lying across them.
      */}
      {opened && (
        <ResultFilters
          filters={filters}
          onChange={setFilters}
          shown={visibleItems.length}
          matched={opened.items.length}
          total={opened.items.length}
          statuses={statuses}
          showScore={false}
          tags={folderTagOptions}
          nameSearch
        />
      )}

      {!opened && (
        <p className="muted triage-lede">
          Keep the people you shortlist together. Drag candidates in from a search or add them
          from a profile. Every folder is shared with everyone on your team.
        </p>
      )}

      {/*
        Under the title and always there — a list you have to scroll to search
        is a list you stop using once it is long. Hidden only while there is
        nothing to search, where it would be a control with no purpose.
      */}
      {!opened && folders.length > 1 && (
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
              placeholder="Search folders"
              aria-label="Search folders"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {/* The order, next to the search. One control opens, and the current
              choice is named on the button so the list never looks arbitrary. */}
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

          {/* Ticking several, to delete them in one go. */}
          <SelectButton
            selecting={selection.selecting}
            onOpen={() => { selection.open(); setBulkNote('') }}
            onClose={selection.close}
          />
        </div>
      )}

      {!opened && selection.selecting && (
        <SelectionBar
          count={selection.count}
          total={shownFolders.length}
          noun="folder"
          nounPlural="folders"
          onAll={selection.all}
          onNone={selection.none}
          onDelete={removeSelected}
          busy={bulkBusy}
        />
      )}

      {/* One line for both. StatusNotice exists to render at most one of them,
          and two of them side by side is the pair of stacked banners it was
          written to prevent — the Triage list already does it this way. */}
      <StatusNotice
        error={error}
        notice={bulkNote}
        onDismiss={() => { setError(''); setBulkNote('') }}
      />

      {folders.length === 0 ? (
        <div className="empty">
          <h2>No folders yet</h2>
          <p className="muted">
            Create a folder, then drag candidates into it from the search results. Folders are
            shared with everyone on your team.
          </p>
          {/* The way out of an empty page, as Triage has one. The + above does
              the same thing, but an empty screen should not require you to go
              looking for the one control on it. .folder-start keeps the
              click-outside dismisser off it — see the effect above. */}
          <button
            type="button"
            className="btn btn-primary folder-start"
            onClick={() => setCreating(true)}
          >
            New folder
          </button>
        </div>
      ) : opened ? (
        /* Inside a folder: its candidates, one per row. */
        <ul className="drive-items result-list">
          {opened.items.length === 0 && (
            <li className="drive-empty muted">
              Nothing in here yet. Drag a candidate in from a search.
            </li>
          )}

          {/* Told apart from an empty folder on purpose: one is a folder with
              nobody in it, the other is a filter hiding everybody. */}
          {opened.items.length > 0 && visibleItems.length === 0 && (
            <li className="drive-empty muted">
              Nothing here matches the filters.
            </li>
          )}

          {/*
            One card, drawn twice.

            A candidate in a folder and a candidate in a search are the same
            person seen from two places, and they were two different rows: a
            five-column grid line here, a two-row card with a floating corner
            there. Two treatments for one object is what makes a product feel
            assembled out of parts.

            The row's data is flat where the card's is nested, so it is adapted
            rather than passed through — and it genuinely lacks some of what the
            card can show (nobody has an unread count or a revealedBy here), in
            which case the card simply draws less. What it does NOT lack is the
            drag: this row was already `draggable` with the same
            `text/candidate-id` payload the card sets, for dragging into another
            folder, so that survives untouched.
          */}
          {visibleItems.map((item) => (
            <ResultCard
              /* Two kinds of row live in one folder now, and their ids come
                 from two different tables — so the key has to say which. */
              key={item.fromTriage
                ? `t${item.triage_applicant_id}`
                : `c${item.candidate_id}`}
              result={{
                candidate: {
                  id: item.candidate_id,
                  display_name: item.display_name ?? item.name,
                  location: item.location,
                  availability: item.availability,
                  has_photo: item.has_photo,
                },
                /*
                 * Where this one came from, when it is not the marketplace.
                 *
                 * A folder can hold a candidate somebody found in a search and
                 * a CV somebody uploaded to a Triage, and they are not the same
                 * kind of thing: one has a profile, a freshness clock and an
                 * inbox, the other is a document. Nothing else on the row would
                 * tell them apart, so the row says it.
                 */
                fromTriage: item.fromTriage ?? null,
                score: item.score,
                /* Where they are, which on this screen is the folder being
                   read — the card's chip then names it, as it does in a
                   search. */
                folder: { id: opened.id, name: opened.name },
                revealed: item.revealed,
                tags: item.tags ?? [],
                activity: item.activity,
                /* The reading saved when they were filed, said as the card
                   says a live one. scoredFor is what it was measured against,
                   and the profile still explains that it is a snapshot. */
                analysis: item.analysis ?? null,
                matchedRequired: [],
                missingRequired: [],
              }}
              meId={me?.recruiter?.id ?? null}
              onOpen={() => setOpenCandidate(item.candidate_id)}
              onTagsChanged={tagsChanged}
              /*
               * Filing, from a card that is already filed.
               *
               * "Save in folder" reads oddly on a row inside a folder until you
               * remember what the dialog behind it does: it says where they are
               * and offers everywhere else. Moving somebody from one folder to
               * another was otherwise two gestures through two screens — take
               * them out here, find them again in a search, put them back.
               */
              canSave
              onFile={() => setFiling(item.candidate_id)}
              onRemove={() => removeItem(item.candidate_id)}
              /* Short, because it is a line in a menu now rather than the
                 accessible name of an unlabelled ×. */
              removeLabel={`Remove from ${opened.name}`}
            />
          ))}
        </ul>
      ) : (
        /* The folders themselves. Still drop targets: dragging a candidate onto
           a closed folder is how a file manager files things. */
        <ul className="drive-items">
          {/* Nothing matched, and a way back — the same sentence and the same
              escape the Triage list offers. */}
          {shownFolders.length === 0 && (
            <li className="muted folder-search-empty">
              No folder matches “{query}”.{' '}
              <button type="button" className="link-button" onClick={() => setQuery('')}>
                Clear
              </button>
            </li>
          )}
          {shownFolders.map((folder) => {
            /* While selecting, the row ticks instead of opening. One row, one
               gesture: a list where clicking sometimes navigates and sometimes
               ticks is a list you have to look at the toolbar to use. */
            const ticked = selection.isPicked(folder.id)
            const act = () => (selection.selecting ? selection.toggle(folder.id) : setOpenFolder(folder.id))

            return (
            <li
              key={folder.id}
              className={[
                'drive-item',
                dragOver === folder.id ? 'drive-item-over' : '',
                selection.selecting ? 'drive-item-selecting' : '',
                ticked ? 'drive-item-ticked' : '',
              ].filter(Boolean).join(' ')}
              onDragOver={(e) => { e.preventDefault(); setDragOver(folder.id) }}
              onDragLeave={() => setDragOver((current) => (current === folder.id ? null : current))}
              onDrop={(e) => drop(e, folder)}
              role={selection.selecting ? 'checkbox' : 'button'}
              aria-checked={selection.selecting ? ticked : undefined}
              tabIndex={0}
              onClick={act}
              onKeyDown={(e) => {
                /* Only what lands on the row itself. The corner carries its
                   own controls, and a keystroke meant for one of those must not
                   also open what is behind it. */
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act() }
              }}
            >
              {selection.selecting ? <RowTick checked={ticked} /> : <FolderIcon />}

              <span className="drive-item-name">
                <strong>{folder.name}</strong>
                <span className="muted">
                  {folder.items.length} candidate{folder.items.length === 1 ? '' : 's'}
                </span>
              </span>

              <span className="drive-item-owner muted">
                {folder.mine ? 'You' : folder.created_by ?? 'A colleague'}
              </span>

              {/* Rename and Delete behind the dots, as a file manager puts them
                  — two words per row across ten folders is twenty words of
                  chrome competing with the names. */}
              <span
                className="drive-item-menu"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <PopMenu
                  label={`Actions for ${folder.name}`}
                  items={[
                    { key: 'rename', label: 'Rename', onSelect: () => rename(folder) },
                    {
                      key: 'export',
                      label: 'Export to Excel',
                      onSelect: () => exportFolder(folder),
                    },
                    { key: 'delete', label: 'Delete', danger: true, onSelect: () => remove(folder) },
                  ]}
                />
              </span>
            </li>
            )
          })}
        </ul>
      )}

      {/*
        The same dialog the search list opens, given this screen's handlers.
        moveToFolder already understands 'new', so the two callers hand it the
        same shape and neither needs to know which list it was opened from.
      */}
      {filing !== null && (
        <FolderDialog
          folders={folders}
          /* They are in the folder being read — that is what this screen is —
             so the dialog opens with it named and Remove beside it. */
          inFolderId={opened?.id ?? null}
          onPick={(folderId) => moveToFolder(filing, folderId)}
          onNewFolder={() => moveToFolder(filing, 'new')}
          onRemove={() => removeItem(filing)}
          onClose={() => setFiling(null)}
        />
      )}

      {openCandidate !== null && (
        <CandidateDialog
          candidateId={openCandidate}
          meId={me?.recruiter?.id ?? null}
          /*
           * Where they are filed, so the dialog can say so and offer to move
           * them. The same control the search results already carry — a
           * candidate opened from a folder is the one case where "which folder
           * is this?" is most obviously worth answering, and it was the one
           * place that did not.
           */
          /*
           * Where they are filed, and what they scored when they were filed
           * there. The score is a fact about a search, and a folder is not one
           * — so it is the copy taken on the day rather than a live figure, and
           * the dialog says which search it came from.
           */
          result={{
            folder: openIn ? { id: openIn.id, name: openIn.name } : null,
            ...(openItem?.score === null || openItem?.score === undefined ? {} : {
              score: openItem.score,
              scoredFor: openItem.scoredFor ?? null,
              scoredAt: openItem.scoredAt ?? null,
              /* The reading, in the shape the score view already renders — the
                 requirement chips and Claude's sentence, as they stood. */
              analysis: openItem.analysis?.reasoning
                ? { reasoning: openItem.analysis.reasoning }
                : null,
              matchedRequired: openItem.analysis?.matchedRequired ?? [],
              missingRequired: openItem.analysis?.missingRequired ?? [],
              matchedPreferred: openItem.analysis?.matchedPreferred ?? [],
              missingPreferred: openItem.analysis?.missingPreferred ?? [],
            }),
          }}
          folders={folders}
          onAddToFolder={moveToFolder}
          onRemoveFromFolder={removeItem}
          onTagsChanged={tagsChanged}
          onClose={() => setOpenCandidate(null)}
          onError={setError}
        />
      )}
    </div>
  )
}

/**
 * Where a saved candidate stands with this recruiter.
 *
 * A select rather than a row of chips: there are six stages and only one can be
 * true at a time, and a folder column is narrow. It shows the current stage
 * whether that stage was worked out from the facts or pinned by hand — the
 * distinction matters when you are choosing, not when you are reading, so it
 * lives in the option list and the title rather than on the card.
 *
 * Automatic is offered first and explicitly, because it is the one worth going
 * back to: it tracks reveals and replies on its own, and a pinned status stops
 * doing that.
 */
function StatusPicker({ item, statuses, onChange }) {
  const status = item.status ?? {}
  const derived = statuses.filter((entry) => entry.derived)
  const decisions = statuses.filter((entry) => !entry.derived)

  const current = statuses.find((entry) => entry.key === status.key)
  const title = status.pinned
    ? `Set by you. Choose Automatic to track reveals and replies again.`
    : `Worked out from what has happened${current?.hint ? `: ${current.hint.toLowerCase()}` : ''}.`

  return (
    <select
      className={status.pinned ? 'status-picker status-picker-pinned' : 'status-picker'}
      value={status.pinned ? status.key : ''}
      title={title}
      aria-label={`Status: currently ${status.label ?? 'unknown'}`}
      // The card underneath opens the candidate; without this, changing a
      // status would also open them.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => { e.stopPropagation(); onChange(e.target.value) }}
    >
      {/* The empty value is Automatic, and it names the stage it currently
          works out, so choosing it is not a leap in the dark. */}
      <option value="">
        Automatic{status.pinned ? '' : ` (${status.label ?? ''})`}
      </option>
      {decisions.length > 0 && (
        <optgroup label="Your call">
          {decisions.map((entry) => (
            <option key={entry.key} value={entry.key}>{entry.label}</option>
          ))}
        </optgroup>
      )}
      {/* Pinnable too: a recruiter who emailed someone outside Cursus needs to
          be able to say Contacted, which nothing in our data can know. */}
      <optgroup label="Pin a stage">
        {derived.map((entry) => (
          <option key={entry.key} value={entry.key}>{entry.label}</option>
        ))}
      </optgroup>
    </select>
  )
}

/**
 * Full record for one candidate, opened from a folder card. Fetching it is what
 * records the profile view, which is the right moment — the recruiter is
 * actually looking at the person.
 */
function CandidateDialog({
  candidateId, result = null, folders = [], onAddToFolder, onRemoveFromFolder,
  onRevealed, onDismiss, onTagsChanged, onClose, onError, meId = null,
}) {
  const dialogRef = useDialogFocus()
  const [data, setData] = useState(null)
  /* Whether the folder dialog is over this one. */
  const [filing, setFiling] = useState(false)
  /* The same tags the row carries, kept here so the strip in this header and
     the editor behind the + are one thing. Seeded from the row and replaced by
     the profile's own copy, which is the fresher of the two. */
  const [tags, setTags] = useState(result?.tags ?? [])
  /*
   * Opened at the top, every time.
   *
   * The body scrolls under a fixed header, and a profile is long enough to need
   * it. Whatever it was showing when it was last closed is nothing to do with
   * the person just opened.
   */
  const body = useRef(null)
  useEffect(() => { body.current?.scrollTo?.({ top: 0 }) }, [candidateId])
  const [sending, setSending] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState('')
  const [closing, setClosing] = useState(false)
  /* The document being read, if any — see DocumentReader. */
  const [reading, setReading] = useState(null)
  /*
   * Which half of the person is on screen.
   *
   * Only once they are revealed: before that there is one thing to read — why
   * they scored what they scored — and a tab bar over a single tab is furniture.
   * Profile first, because the reveal is what was just paid for.
   */
  const [view, setView] = useState('profile')
  const { wallet, spend } = useContext(WalletContext)

  /**
   * Unlocks the identifying half of the profile. The response carries
   * everything that was hidden, so the dialog unfolds without a second fetch —
   * and, since the pricing model, the balance left after the charge.
   */
  async function reveal() {
    setRevealing(true)
    setRevealError('')
    try {
      const revealed = await post(`/api/hr/candidates/${candidateId}/reveal`, {}, 'recruiter')
      setData((prev) => ({ ...prev, ...revealed }))
      // Only when something was actually spent. A candidate a colleague already
      // revealed is free (§17.1), and decrementing the header for it would tell
      // the recruiter they had paid twice.
      if (revealed.charged) spend(revealed.balance)
      /* The list behind this dialog is showing the same person: without this it
         keeps their masked name and the struck-through eye until the next
         search. Told rather than asked to re-fetch — the charge has already
         happened here, and a second reveal call would be a second decision. */
      onRevealed?.(revealed)
    } catch (err) {
      setRevealError(err.message)
    } finally {
      setRevealing(false)
    }
  }

  useEffect(() => {
    get(`/api/hr/candidates/${candidateId}`, 'recruiter')
      .then((payload) => { setData(payload); setTags(payload.tags ?? []) })
      .catch((err) => onError(err.message))
  }, [candidateId, onError])

  useEffect(() => {
    /* Escape closes the document being read first, then the profile — the
       innermost thing, which is what a person expects it to shut. */
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      if (reading) setReading(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, reading])

  async function send(text) {
    setSending(true)
    try {
      const sent = await post(`/api/hr/threads/${candidateId}`, { body: text }, 'recruiter')
      setData((prev) => ({ ...prev, thread: sent.messages, threadStatus: sent.status }))
    } catch (err) {
      onError(err.message)
    } finally {
      setSending(false)
    }
  }

  /** Stops the candidate replying, and can be undone — so it is not a confirm. */
  async function setThread(open) {
    setClosing(true)
    try {
      const next = await post(
        `/api/hr/threads/${candidateId}/${open ? 'reopen' : 'close'}`, {}, 'recruiter',
      )
      setData((prev) => ({ ...prev, threadStatus: next.status }))
    } catch (err) {
      onError(err.message)
    } finally {
      setClosing(false)
    }
  }

  const candidate = data?.candidate
  const revealed = Boolean(candidate?.revealed)

  /*
   * Score is a tab only when there IS a score.
   *
   * That was the intent and the test was wrong: it asked whether `result`
   * existed, and a candidate opened from a folder is given a `result` — a
   * `{ folder }` with no score in it, so the panel can say where they are
   * filed. Truthy, so the tab appeared, and it appeared empty; the number
   * beside the name came out blank for the same reason. A folder has no job
   * description behind it, so there is nothing to score against and nothing to
   * show.
   */
  const scored = Number.isFinite(result?.score)
  const TABS = [
    ['profile', 'Profile'],
    ...(scored ? [['score', 'Score']] : []),
    ['messages', 'Messages'],
  ]
  const showing = TABS.some(([key]) => key === view) ? view : 'profile'

  /*
   * Everything that can be done to this person, in the corner.
   *
   * The same three the result card carries, for the same reason: a recruiter
   * who has just read the profile is exactly the person who wants to file them,
   * reveal them, or rule them out — and had to close the dialog to do any of
   * it. It stands where the close button used to: the backdrop and Escape both
   * close this, and a × spent the one corner an action could live in.
   */
  /*
   * Filing, in the corner with everything else that can be done to this person.
   *
   * It was a select at the foot of the dialog body, which meant a candidate
   * opened from a folder had their one available action below a CV — and, when
   * they had been revealed, no ⋮ at all, because the menu had nothing else to
   * put in it. Every folder is named rather than hidden behind "move to…": the
   * list is a recruiter's own and short, and naming them turns two gestures
   * into one.
   */
  const inFolder = result?.folder
    ?? folders.find((folder) => folder.items?.some((item) => item.candidate_id === candidateId))
    ?? null

  const actions = [
    /*
     * One line, and it opens the same dialog the result card opens.
     *
     * This menu used to name every folder in the company — "Move to Backend
     * hires", "Move to Graduates", "Move to Analytics" — one item each, plus a
     * new-folder item and a remove. That is a list pretending to be a menu, and
     * it grew a row longer every time anyone made a folder. The dialog it now
     * opens has a search box, which is the thing a list of forty needs.
     */
    onAddToFolder && {
      key: 'folder',
      label: 'Save in folder',
      onSelect: () => setFiling(true),
    },
    /* The dialog's own reveal, not the list's: one code path for one purchase,
       and the person being paid for is on screen while it happens. */
    !revealed && { key: 'reveal', label: 'Reveal', onSelect: reveal },
    onDismiss && {
      key: 'dismiss',
      label: 'Not relevant',
      danger: true,
      onSelect: () => { onDismiss(); onClose() },
    },
  ].filter(Boolean)

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      {/*
        Over this dialog, not beside it.

        Its own portal puts it on document.body, so it paints above the profile
        rather than inside the scrolling panel — the same reason AllSearches is
        portalled. Removing closes both: the row this was opened from is about
        to lose the folder it was listed under.
      */}
      {filing && (
        <FolderDialog
          folders={folders}
          inFolderId={inFolder?.id ?? null}
          onPick={(folderId) => onAddToFolder(candidateId, folderId)}
          onNewFolder={() => onAddToFolder(candidateId, 'new')}
          onRemove={onRemoveFromFolder
            ? () => { onRemoveFromFolder(candidateId); onClose() }
            : null}
          onClose={() => setFiling(false)}
        />
      )}

      <div
        className="modal candidate-dialog"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label={candidate ? candidate.display_name : 'Candidate'}
        onClick={(e) => e.stopPropagation()}
      >
        {/*
          Fixed, and opaque.

          It carries the identity, the number and the way between the three
          views — none of which is worth scrolling back up for. Opaque because a
          header the page slides under has to hide what it slides over; sticky
          alone left the CV showing through the person's name.
        */}
        <header className="modal-head candidate-head">
          <div className="candidate-head-row">
            <div className="candidate-head-lead">
              {candidate && <CandidateAvatar candidate={candidate} enlargeable />}
              <div className="modal-title">
              <h2>
                {/* display_name is the whole rule: the server masks it to a
                    first name until the reveal and swaps in the full one after.
                    Reading `name` first was a second path to the same answer —
                    and one that would print a surname the moment anything else
                    put that field in the payload. */}
                <span className="result-name">
                  {candidate ? candidate.display_name : 'Loading…'}
                </span>
                {/* Availability, beside the name, exactly as the result card
                    says it. It was a worded chip below — two ways of saying one
                    thing across two screens. */}
                {data?.activity && <ActivityDot activity={data.activity} />}
              </h2>
              <p className="muted candidate-head-meta">
                {[candidate?.location, candidate?.availability].filter(Boolean).join(' · ')}
                {/* Who paid, beside the person they paid for. It was a green
                    banner across the body, which is a lot of screen for a fact
                    that belongs to the name. */}
                {data?.revealedBy && (
                  <span className="candidate-revealed-by">
                    Revealed by{' '}
                    <strong>
                      {data.revealedBy.recruiterId === meId ? 'me' : data.revealedBy.name}
                    </strong>
                    {' on '}
                    {new Date(data.revealedBy.at).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' })}
                  </span>
                )}
              </p>
              <div className="result-tags">
                {/* The one thing a dot cannot say: somebody who has asked not to
                    be approached needs words, not a colour. */}
                {data?.activity?.state === 'deactivated' && <ActivityChip activity={data.activity} />}
              </div>
              </div>
            </div>

            {/*
              The number, in the middle of the dialog and sized to be read across
              a room — it is the reason this profile was opened. Its own column
              between two equal flexible ones, which is what centres it: absolute
              positioning put it over the name, and a flex row let a long name
              shove it off centre. The cell is here even when there is no score,
              so the menu stays in the corner on a profile opened from a folder.
            */}
            {/* The cell stays either way — it is the middle track of three and
                what centres the number — but it is empty rather than empty and
                coloured when there is no score. */}
            <p className={scored ? `candidate-head-score score-${scoreBand(result.score)}` : 'candidate-head-score'}>
              {scored && <span className="score-value">{result.score}%</span>}
            </p>

            <span className="modal-menu">
              {/* Between the number and the buttons, as on the row — with room
                  for one more, since a dialog header is wider than a card. */}
              <TagStrip tags={tags} limit={2} />
              {/* The same eye, in the same place it took on the row: a struck
                  eye under the name announced the state and left the way out of
                  it inside the ⋮ menu. Reveal is already in that menu and stays
                  there — this is the shortcut, not the only route. */}
              {candidate && !revealed && (
                <button
                  type="button"
                  className="icon-button result-reveal"
                  onClick={reveal}
                  title={`Reveal ${candidate.display_name ?? 'this candidate'} — their contact `
                    + 'details and CV, for one reveal. Saving them to a folder is free.'}
                  aria-label={`Reveal ${candidate.display_name ?? 'this candidate'}`}
                >
                  <EyeOffIcon />
                </button>
              )}
              <TagEditor
                candidateId={candidateId}
                tags={tags}
                onChange={(next) => { setTags(next); onTagsChanged?.(candidateId, next) }}
                label={`Tags on ${candidate?.display_name ?? 'this candidate'}`}
              />
              {/* What your team has said, beside what you can do — the two
                  corner controls, in the same order as on the row. */}
              <CommentsPopover
                candidateId={candidateId}
                meId={meId}
                label={`Comments on ${candidate?.display_name ?? 'this candidate'}`}
              />
              {actions.length > 0 && (
                <PopMenu
                  label={`Actions for ${candidate?.display_name ?? 'this candidate'}`}
                  items={actions}
                  vertical
                />
              )}
            </span>
          </div>

          {revealed && (
            <div
              className="role-switch dialog-tabs"
              role="tablist"
              aria-label="What to read"
              /*
               * Arrows move between tabs, which is how a tablist is driven —
               * Tab itself moves out of the set to the panel, and without this
               * there was no way in to the other two but the mouse.
               */
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
                  /* The three halves of the contract a tablist makes: which
                     panel this tab controls, an id for that panel to point back
                     at, and only the selected tab in the tab order — the rest
                     are reached with the arrows above. */
                  id={`candidate-tab-${key}`}
                  aria-controls="candidate-tabpanel"
                  tabIndex={showing === key ? 0 : -1}
                  className={`role-option${showing === key ? ' role-option-on' : ''}`}
                  onClick={() => setView(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </header>

        {!candidate ? (
          <p className="muted">Loading their details…</p>
        ) : (
          <div
            className="modal-body candidate-body"
            ref={body}
            /* The panel the tabs above control. Only a panel while there are
               tabs: before the reveal there is one thing to read and no set to
               belong to. */
            id={revealed ? 'candidate-tabpanel' : undefined}
            role={revealed ? 'tabpanel' : undefined}
            aria-labelledby={revealed ? `candidate-tab-${showing}` : undefined}
            tabIndex={revealed ? 0 : undefined}
          >
            {/*
              Before the reveal there is one thing to read: who they are, how
              they scored, and the step that opens the rest. No tabs yet, so the
              summary belongs here as much as it does on the Profile tab.
            */}
            {!revealed ? (
              <>
                <ProfessionalSummary summary={candidate.summary} />
                <ScoreReading result={result} candidate={candidate} />

                <div className="reveal-gate">
                  <h4 className="modal-subhead">Contact and documents</h4>
                  <p className="muted">
                    Their full name, email, phone number, CV and the conversation are hidden until
                    you reveal them. Everything above is free — including saving them to a folder —
                    and this is the step that costs. Once anyone on your team reveals someone, the
                    whole team can see them at no further cost.
                  </p>
                  <StatusNotice error={revealError} onDismiss={() => setRevealError('')} />

                  <button
                    type="button"
                    className="btn btn-primary btn-reveal"
                    disabled={revealing || wallet?.balance === 0}
                    onClick={reveal}
                  >
                    <EyeIcon size={16} />
                    {revealing ? 'Revealing…' : 'Reveal'}
                  </button>

                  {/* Only the case the button cannot explain by itself. The
                      running cost used to be printed here on every profile; the
                      paragraph above already says this is the step that costs,
                      and a disabled button with no reason is the one thing a
                      recruiter cannot work out. */}
                  {wallet?.balance === 0 && (
                    <p className="muted reveal-cost">
                      No reveals left. Your organization needs another Reveal Pack.
                    </p>
                  )}
                </div>
              </>
            ) : showing === 'score' ? (
              <ScoreReading result={result} candidate={candidate} />
            ) : showing === 'messages' ? (
              <div className="chat-section chat-section-framed">
                <div className="dialog-section-head">
                  <h4>Conversation with {candidate.display_name}</h4>
                  {/* A lock, because that is what it does: closing stops them
                      replying and can be undone. A worded button spent a line of
                      a header on a state the icon says at a glance. */}
                  <button
                    type="button"
                    className="icon-button"
                    disabled={closing}
                    /*
                     * No aria-pressed. The label already names the action and
                     * changes with the state, so the pair announced "Reopen
                     * this conversation, pressed" on a closed thread — which
                     * reads as reopening having already happened. A button
                     * whose label is the action is not a toggle.
                     */
                    aria-label={data.threadStatus === 'closed' ? 'Reopen this conversation' : 'Close this conversation'}
                    title={data.threadStatus === 'closed'
                      ? 'Closed: they cannot reply. Press to reopen.'
                      : 'Open: press to close it and stop them replying.'}
                    onClick={() => setThread(data.threadStatus === 'closed')}
                  >
                    <LockIcon locked={data.threadStatus === 'closed'} />
                  </button>
                </div>

                {data.threadStatus === 'closed' && (
                  <p className="alert alert-muted">
                    This conversation is closed. {candidate.display_name} keeps everything you
                    have both written but cannot reply until you reopen it.
                  </p>
                )}

                <ChatPanel
                  messages={data.thread ?? []}
                  meSender="recruiter"
                  onSend={send}
                  sending={sending}
                  disabled={data.threadStatus === 'closed'}
                  emptyText="No messages yet. Send the first one to open a conversation."
                  placeholder={`Message ${candidate.display_name}…`}
                />
              </div>
            ) : (
              <>
                {/*
                  The summary is part of the profile, and only of the profile.
                  It sat above the tabs, so it was reprinted over the scoring
                  and over the conversation — two screens that are about the
                  search and about the thread, not about the person. Somebody
                  reading a message thread has already read who this is.
                */}
                <ProfessionalSummary summary={candidate.summary} />
                <CandidateProfileView
                  candidate={candidate}
                  data={data}
                  onError={onError}
                  onRead={setReading}
                />
              </>
            )}

          </div>
        )}
      </div>

      {reading && (
        <DocumentReader
          file={reading}
          candidateId={candidateId}
          onClose={() => setReading(null)}
        />
      )}
    </div>
  )
}

/**
 * A document, read where it was opened.
 *
 * Sending a recruiter to a browser tab to read a CV is sending them out of the
 * product in the middle of the one job it exists for — and back, if they can
 * find the tab again. The file is the same bytes either way; only the frame
 * around it is ours.
 */
function DocumentReader({ file, candidateId, onClose }) {
  const dialogRef = useDialogFocus()
  const src = withToken(
    `/api/hr/candidates/${candidateId}/file?slot=${file.slot}&inline=1`, 'recruiter',
  )

  return (
    <div className="modal-backdrop reader-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal reader"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label={file.file_name ?? file.label}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div className="modal-title">
            <h2>{file.label}</h2>
            <p className="muted">{file.file_name ?? 'Document'}</p>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">&times;</button>
        </header>

        <object className="pdf-frame reader-frame" data={src} type="application/pdf">
          {/* Shown only if the browser has no built-in PDF viewer. */}
          <p className="muted">
            Your browser cannot display PDFs inline.{' '}
            <a href={src} target="_blank" rel="noreferrer noopener">Open {file.file_name}</a>
          </p>
        </object>
      </div>
    </div>
  )
}

/** Closed or open, said with the thing itself rather than with a word. */
function LockIcon({ locked }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      {/* The shackle stands up straight when it is open and closes to the left
          when it is not — the same movement a padlock makes. */}
      {locked
        ? <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        : <path d="M16 10.5V7a4 4 0 0 0-7.5-2" />}
    </svg>
  )
}

/**
 * Why they scored what they scored.
 *
 * One component so the pre-reveal screen and the Score tab cannot drift into
 * two accounts of the same number.
 */
function ScoreReading({ result, candidate }) {
  if (!result) {
    return (
      <p className="muted">
        This profile was not opened from a search, so there is no score to explain.
      </p>
    )
  }

  const met = result.matchedRequired ?? []
  const missing = result.missingRequired ?? []
  const prefMet = result.matchedPreferred ?? []
  const prefMissing = result.missingPreferred ?? []
  const analysis = result.analysis

  return (
    <>
      {/* Named when the reading was saved rather than just run: opened from a
          folder there is no "this job description" on screen to point at, and
          the search it came from is the only thing that makes the number mean
          anything. */}
      <h4 className="modal-subhead">
        {result.scoredFor ? `Against “${result.scoredFor}”` : 'Against this job description'}
      </h4>

      {/*
        And when. A saved score is a record of a judgement made on a day, not a
        live figure — the displayed score is worked out against the pool that
        was searched, and the pool moves — so a folder that quietly showed a
        stale number as though it were current would be the more misleading of
        the two options.
      */}
      {result.scoredAt && (
        <p className="muted candidate-scored-when">
          As it stood on {new Date(result.scoredAt).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' })},
          when they were saved. Running the search again may place them differently.
        </p>
      )}

      <ScoreInsights result={result} candidate={candidate} />

      {/*
        Every requirement the description states, met or not — the list is the
        job, and colour is the answer. Naming only the misses made a candidate
        look like a set of holes and left the recruiter counting to work out
        what was actually there.
      */}
      <CriteriaRow label="Requirements" met={met} missing={missing} />
      <CriteriaRow label="Preferred" met={prefMet} missing={prefMissing} />

      {analysis && (
        <>
          {/* Each claim next to the words it came from, so the assessment can be
              checked rather than taken on trust. */}
          {analysis.evidence?.length > 0 && (
            <div>
              <h4 className="modal-subhead">Evidence from the CV</h4>
              <ul className="evidence-list">
                {analysis.evidence.map((item, index) => (
                  <li key={index}>
                    <strong>{item.claim}</strong>
                    <blockquote>“{item.quote}”</blockquote>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {analysis.probes?.length > 0 && (
            <div>
              <h4 className="modal-subhead">Worth asking</h4>
              <ul className="delete-list">
                {analysis.probes.map((probe, index) => <li key={index}>{probe}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  )
}

/**
 * What the number means, in a few lines.
 *
 * These are meant to be READINGS, not a summary of the rows underneath: a
 * recruiter can already see which tags are red. Each line should say something
 * the tags do not — that the gap is in one area rather than spread, that the
 * evidence is thin, that a near-miss on a stated requirement is covered by
 * something adjacent.
 *
 * The good ones come from the model: analysis.reasoning is Claude's own reading
 * of this CV against this description, and analysis.strengths / .gaps /
 * .transferable are its specific claims. THE PRODUCT WANTS A DEDICATED FIELD
 * HERE — a short list of insight sentences the model is asked for by name, in
 * ai.js, alongside reasoning — and when that exists it should be rendered here
 * in place of what follows. Until then this derives what it honestly can and
 * says nothing it cannot support.
 *
 * Deliberately absent: any count of what is missing. "Meets 0 of 15" is a
 * restatement of the red tags below with arithmetic added, and it reads as a
 * verdict on a person rather than as a description of a fit.
 */
function ScoreInsights({ result, candidate }) {
  const analysis = result.analysis
  const met = result.matchedRequired ?? []
  const missing = result.missingRequired ?? []
  const prefMet = result.matchedPreferred ?? []

  const lines = []

  /* Claude's reading first, when there is one: it is the only line here written
     about this person rather than computed from a list. */
  if (analysis?.reasoning) lines.push(analysis.reasoning)

  /* Capability the CV evidences under another name — the whole point of the AI
     pass, and the one thing the tags below cannot show, since a transferable
     skill is by definition not the word the description used. */
  if (analysis?.transferable?.length > 0) {
    lines.push(`Counts towards the role without being named in the CV: ${analysis.transferable.join(', ')}.`)
  }

  /* Where the shortfall sits, not how big it is. A candidate missing the whole
     of a stack is a different proposition from one missing a tool. */
  if (missing.length > 0 && met.length > 0) {
    lines.push(`Has ${met.join(', ')}; the description also asks for ${missing.join(', ')}.`)
  } else if (missing.length > 0 && met.length === 0 && (candidate.skills?.length ?? 0) > 0) {
    lines.push('Nothing in this CV matches the stated requirements: the experience is in a '
      + 'different area rather than at a different level.')
  }

  if (prefMet.length > 0) {
    lines.push(`Brings ${prefMet.join(', ')} from the preferred list.`)
  }

  if (analysis?.confidence && analysis.confidence !== 'high') {
    lines.push('The CV says less than usual about the work itself, so this reading is '
      + 'less certain than most, worth a conversation before ruling either way.')
  }

  if (lines.length === 0) {
    return (
      <p className="muted score-insights-empty">
        No written analysis for this candidate; the tags below are the whole reading.
      </p>
    )
  }

  return (
    <ul className="score-points">
      {lines.map((line, index) => <li key={index}>{line}</li>)}
    </ul>
  )
}

/** Every criterion of one class, answered: green where the CV meets it, red where it does not. */
function CriteriaRow({ label, met = [], missing = [] }) {
  if (met.length === 0 && missing.length === 0) return null
  return (
    <div className="skill-row">
      <span className="skill-row-label">{label}</span>
      <span className="skill-row-chips">
        {met.map((item) => <span key={`m${item}`} className="chip chip-hit">{item}</span>)}
        {missing.map((item) => <span key={`x${item}`} className="chip chip-miss">{item}</span>)}
      </span>
    </div>
  )
}

/**
 * The whole person, once they have been paid for.
 *
 * The candidate's own portal shows them their summary, what they are looking
 * for, their skills and their documents; this is that, read from the other
 * side. Nothing here is scoring — a profile is not an argument about a job.
 *
 * The summary comes first: it is the only part written in sentences, and a
 * recruiter who has just paid to open somebody wants to read about them before
 * reading their phone number.
 */
function CandidateProfileView({ candidate, data, onError, onRead }) {
  const links = Array.isArray(candidate.links) ? candidate.links : []
  const regions = Array.isArray(candidate.preferred_regions)
    ? candidate.preferred_regions
    : String(candidate.preferred_regions ?? '').split(',').map((r) => r.trim()).filter(Boolean)

  return (
    <>
      {/*
        No summary here.

        It was the first thing in this view — and this view is the profile tab,
        which only exists after a reveal, so the one paragraph written to help a
        recruiter decide whether to pay was behind the payment. It is at the top
        of the dialog body now, above the score and outside the tabs, where it
        is read once whoever is looking and whatever they have paid for.
      */}

      <dl className="facts facts-ruled">
        {/* No Name row: it is the heading of this dialog, six lines above. */}
        <Fact label="Email" value={candidate.email} />
        <Fact label="Phone" value={candidate.phone} />
        <Fact label="Looking for" value={candidate.desired_role} />
        <Fact label="Available" value={candidate.availability} />
        <Fact label="Capacity" value={candidate.capacity} />
        <Fact label="Notice" value={candidate.notice_period} />
        <Fact
          label="Relocation"
          value={candidate.open_to_relocation === null ? null
            : candidate.open_to_relocation ? 'Open to relocating' : 'Not relocating'}
        />
        <Fact label="Would move to" value={regions.length > 0 ? regions.join(', ') : null} />
      </dl>

      {/* Where the work was done, above what it was made of. Fixed labels from
          the taxonomy, so this says "Finance" and not whatever phrase the CV
          used for it. */}
      <SkillRow label="Industries" skills={data.industries} tone="neutral" />
      <SkillRow label="Skills" skills={candidate.skills} tone="neutral" />

      {links.length > 0 && (
        <div>
          <h4 className="modal-subhead">Links</h4>
          <ul className="delete-list">
            {links.map((link) => (
              <li key={link}>
                <a href={link} target="_blank" rel="noreferrer noopener">{link}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h4 className="modal-subhead">Documents</h4>
      <CvActions
        candidate={candidate}
        documents={data.documents ?? []}
        onError={onError}
        onRead={onRead}
      />
    </>
  )
}


// --------------------------------------------------------------- shared ---

/**
 * View, open or download a candidate's CV. The preview and the new-tab link
 * carry the token in the query string, because neither an <iframe> nor a plain
 * link can set an Authorization header.
 */
function CvActions({ candidate, documents = [], onError, onRevealed, onRead, children }) {
  const files = documents
  const revealed = Boolean(candidate.revealed)

  const urlFor = (slot, inline) => withToken(
    `/api/hr/candidates/${candidate.id}/file?slot=${slot}${inline ? '&inline=1' : ''}`,
    'recruiter',
  )

  if (files.length === 0) {
    return <div className="result-actions"><p className="muted">No documents on file.</p>{children}</div>
  }

  return (
    <>
      {/*
        No "opening a document reveals them" line any more, because it is no
        longer true and never should have been: the file route now serves only
        what the organization has already paid for, and the reveal is the
        deliberate purchase it is priced as. This component is reached from the
        Profile tab, which exists only after that purchase.
      */}
      {!revealed && (
        <p className="field-hint">
          Reveal this candidate to open their documents.
        </p>
      )}

      <ul className="doc-list">
        {files.map((file) => {
          /* The row itself opens the document, in a frame of our own — reading
             a CV should not mean leaving for a browser tab and finding the way
             back. The two buttons at the end stop the click getting here. */
          const readable = Boolean(onRead) && file.previewable
          return (
            <li
              key={file.slot}
              className={readable ? 'doc-row doc-row-readable' : 'doc-row'}
              role={readable ? 'button' : undefined}
              tabIndex={readable ? 0 : undefined}
              title={readable ? `Read ${file.file_name ?? file.label}` : undefined}
              onClick={readable ? () => onRead(file) : undefined}
              onKeyDown={readable
                ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRead(file) }
                }
                : undefined}
            >
              <div className="doc-meta">
                <strong>{file.label}</strong>
                <span className="muted">
                  {/* Withheld before the reveal: a filename names people. */}
                  {file.file_name ?? (file.previewable ? 'PDF' : 'Document')}
                  {file.file_size ? ` · ${formatBytes(file.file_size)}` : ''}
                </span>
              </div>

              {/* Marks, not words: three words per row across four documents is
                  a paragraph of chrome beside four filenames. Both still carry
                  their name to anything that reads the page aloud. */}
              <div className="doc-actions" onClick={(event) => event.stopPropagation()}>
                {/* A browser cannot render a DOCX, so it is download-only rather
                    than a link that opens a blank frame. */}
                {file.previewable && (
                  <a
                    className="icon-button"
                    href={urlFor(file.slot, true)}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Open ${file.label} in a new tab`}
                    title="Open in a new tab"
                  >
                    <NewTabIcon />
                  </a>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Download ${file.label}`}
                  title="Download"
                  onClick={() => downloadFile(
                    urlFor(file.slot, false),
                    // Before the reveal the real filename is unknown here, so
                    // the slot names the saved file instead.
                    file.file_name ?? `${file.slot}${file.previewable ? '.pdf' : ''}`,
                    'recruiter',
                  ).then(() => onRevealed?.()).catch((err) => onError(err.message))}
                >
                  <DownloadIcon />
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="result-actions">{children}</div>
    </>
  )
}

/** A square with an arrow leaving it: the same mark every browser uses. */
function NewTabIcon() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
    </svg>
  )
}

/** An arrow into a tray. */
function DownloadIcon() {
  return (
    <svg
      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M12 3.5v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </svg>
  )
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A recruiter's own photo, or their initials. Colleagues only. */
function RecruiterAvatar({ recruiter, size = 'normal' }) {
  // The URL is keyed on the recruiter id, so a replaced photo would render from
  // cache forever. photoVersion changes with the stored file and breaks that.
  const version = recruiter.photoVersion ? `?v=${recruiter.photoVersion}` : ''

  return (
    <Avatar
      src={recruiter.hasPhoto
        ? withToken(`/api/recruiter/${recruiter.id}/photo${version}`, 'recruiter')
        : null}
      firstName={recruiter.firstName}
      lastName={recruiter.lastName}
      size={size}
    />
  )
}

/**
 * How recently the candidate confirmed they are still looking. A profile that
 * has gone months without confirmation is worth knowing about before you spend
 * a reveal on it.
 */
/**
 * Whether this candidate has been around in the last 30 days.
 *
 * Green if they answered the monthly "still looking?" email or signed in;
 * red if neither. Either signal counts, because plenty of people never answer
 * the email and are obviously still active — they read their messages and edit
 * their profile instead.
 *
 * A dot rather than a chip, and to the left of the photo: it is a property of
 * the person, glanced at while scanning a list, not a label to be read. The
 * chips beside the name are for things that need words.
 *
 * The colour is never the only cue. `title` carries the dates behind it, and
 * the text beside the dot is read by screen readers, so this does not depend on
 * telling red from green.
 */
function ActivityDot({ activity }) {
  if (!activity) return null

  const fresh = activity.recentlyActive
  const on = (iso) => (iso ? new Date(iso).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' }) : null)

  const confirmed = on(activity.lastConfirmedAt)
  const seen = on(activity.lastSeenAt)

  const detail = [
    confirmed ? `last confirmed ${confirmed}` : 'never confirmed the monthly email',
    seen ? `last signed in ${seen}` : 'never signed in',
  ].join(', ')

  const summary = fresh
    ? 'Active in the last 30 days'
    : 'No sign of activity in the last 30 days'

  /*
   * Green or nothing — and nothing means nothing drawn.
   *
   * The red dot said "no sign of them in 30 days", which is the ordinary state
   * for most of a candidate pool and was being drawn in the colour this product
   * uses for errors — a whole result list of alarm marks, none of which meant
   * anything was wrong. So it became an empty placeholder instead, which was
   * still visible: .activity-dot carries an inset ring, and clearing the
   * background and the border left the ring behind. Every ordinary candidate
   * wore a small pale circle that meant nothing and looked like a control.
   *
   * The space it reserved bought nothing either. The dot follows the name
   * rather than preceding it, so removing it moves no name — only the badge
   * after it, which most rows do not have.
   */
  if (!fresh) return null

  return (
    <span
      className="activity-dot activity-dot-on"
      title={`${summary}: ${detail}.`}
    >
      <span className="visually-hidden">{summary}.</span>
    </span>
  )
}

function ActivityChip({ activity }) {
  const tone = activity.state === 'active' ? 'chip-hit' : 'chip-warn'
  const title = activity.lastConfirmedAt
    ? `Last confirmed ${new Date(activity.lastConfirmedAt).toLocaleDateString()}`
    : 'Never confirmed'

  return <span className={`chip ${tone}`} title={title}>{activity.label}</span>
}

function CandidateAvatar({ candidate, enlargeable = false }) {
  const [failed, setFailed] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  /*
   * Built from the display name, which is a first name alone before a reveal
   * and the full name after one — so this reads "D" until they are revealed and
   * "DR" once they are, without the surname ever reaching the browser early.
   *
   * It used to render "DR" throughout, because the masked name still carried
   * the surname's initial. The circle was quietly publishing the letter the
   * name beside it was withholding.
   */
  const initials = String(candidate.display_name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?'

  const src = withToken(`/api/hr/candidates/${candidate.id}/photo`, 'recruiter')
  /*
   * `has_photo` is only ever true once the organization has revealed them; the
   * route behind `src` re-checks that on its own account. Before then there is
   * nothing to ask for, so nothing is asked for — a 403 that fell back to
   * initials would look identical but would still have made the request.
   */
  const showPhoto = candidate.has_photo && !failed

  // Initials are not worth enlarging, so only a real photo becomes clickable.
  const canZoom = enlargeable && showPhoto

  function open(event) {
    event.stopPropagation()
    setZoomed(true)
  }

  return (
    <>
      <span
        className={canZoom ? 'result-avatar result-avatar-zoomable' : 'result-avatar'}
        role={canZoom ? 'button' : undefined}
        tabIndex={canZoom ? 0 : undefined}
        title={canZoom ? 'Show larger' : undefined}
        aria-label={canZoom ? `Show a larger photo of ${candidate.display_name}` : undefined}
        onClick={canZoom ? open : undefined}
        onKeyDown={canZoom ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e) }
        } : undefined}
      >
        {showPhoto
          ? <img src={src} alt="" onError={() => setFailed(true)} />
          : <span className="result-initials">{initials}</span>}
      </span>

      {zoomed && <PhotoLightbox src={src} name={candidate.display_name} onClose={() => setZoomed(false)} />}
    </>
  )
}

function PhotoLightbox({ src, name, onClose }) {
  useEffect(() => {
    // Captured at the window so Escape closes the photo without also reaching
    // the dialog's own Escape handler and closing that too.
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="lightbox" onClick={onClose} role="presentation">
      <figure className="lightbox-figure" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={name} />
        <figcaption>
          {name}
          <button type="button" className="btn btn-quiet" onClick={onClose}>Close</button>
        </figcaption>
      </figure>
    </div>
  )
}

function SkillRow({ label, skills, tone }) {
  if (!skills || skills.length === 0) return null
  return (
    <div className="skill-row">
      <span className="skill-row-label">{label}</span>
      <span className="skill-row-chips">
        {skills.map((skill) => <span key={skill} className={`chip chip-${tone}`}>{skill}</span>)}
      </span>
    </div>
  )
}

/** Points down when shut, up when open — the same one the filter panel uses. */
function Caret() {
  return (
    <svg
      className="password-toggle-caret" viewBox="0 0 24 24" width="14" height="14"
      fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/**
 * One label and its value.
 *
 * An empty value normally drops the whole row — a label over nothing is a gap
 * rather than a fact. `placeholder` is for the rows where the emptiness is
 * itself worth reporting: an account with no phone number on file is not the
 * same as an account whose phone number is none of this page's business, and
 * hiding the row makes the two look identical.
 */
function Fact({ label, value, placeholder = null }) {
  const empty = value === null || value === undefined || value === ''
  if (empty && !placeholder) return null
  return (
    <>
      <dt>{label}</dt>
      <dd className={empty ? 'fact-empty' : undefined}>{empty ? placeholder : value}</dd>
    </>
  )
}

