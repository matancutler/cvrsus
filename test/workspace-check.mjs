/**
 * The recruiter workspace shell.
 *
 * Search-first, left-aligned, and exactly one screen tall. Most of what is
 * asserted here is the *absence* of something: a header that carried a running
 * total, a banner repeating it, a page that scrolled past the fold. Each of
 * those would come back unnoticed, so each is named.
 *
 * Layout that needs measuring — that the bar reaches both window edges, that
 * nothing scrolls — is checked in a browser rather than here. What this file
 * protects is the reasoning, which is where the mistakes were: two of these
 * rules exist only because a clipping ancestor and a reserved scrollbar gutter
 * each silently ate the bar's full-bleed margins.
 */
import fs from 'node:fs'

import { BASE, createReporter, json } from './helpers.mjs'

const { check, section, finish } = createReporter()

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const dist = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
const css = read(`../client/dist/assets/${dist.find((f) => f.startsWith('index-') && f.endsWith('.css'))}`)
const panel = read('../client/src/pages/HrPanel.jsx')

/* The components this file makes claims about, sliced out of the page once.
   Several sections read them, so they are declared here rather than beside the
   first section that happened to need one. */
const card = (panel.split('function ResultCard')[1] ?? '').split('\nfunction ')[0]
const dialog = (panel.split('function CandidateDialog')[1] ?? '').split('\nfunction ScoreReading')[0]
const reading = (panel.split('function ScoreReading')[1] ?? '').split('\nfunction CandidateProfileView')[0]
const profileTab = (panel.split('function CandidateProfileView')[1] ?? '').split('\nfunction ')[0]

section('The header carries a wordmark and the way out')
/*
 * The company name and the reveal balance both left it. The company is named in
 * the account block at the foot of the rail; the balance is a meter on Usage &
 * billing and My profile, which says how much of the allowance is gone rather
 * than repeating a bare number on every screen.
 */
check('no company label in the bar', !/<PortalBar[^>]*label=/.test(panel))
check('and no balance chip in it',
  !/<PortalBar[^>]*>[\s\S]{0,200}<RevealBalance/.test(panel))
/*
 * The banner speaks only when something has actually stopped.
 *
 * It used to warn from the loosest threshold downwards, which put it on screen
 * for the whole tail of a balance's life to repeat a number the Usage meter
 * already gave — so it was removed. It is back, on a stricter rule: nothing at
 * all above zero, and at zero a persistent, dismissible notice saying what has
 * stopped working. No low-balance warning of any kind.
 */
check('the balance banner is above the work again', panel.includes('<BalanceBanner'))
check('and it says nothing at all until the balance is zero',
  /if \(wallet\.balance === 0\)/.test(panel)
  && /Silent at every level above zero/.test(panel),
  'a warning that is nearly always there is one nobody reads by the time it matters')
check('it is persistent rather than timed, and carries a way to dismiss it',
  /<Notice tone="warn" className="page-banner" onDismiss=\{dismiss\}>/.test(panel),
  'warn rather than error: the same tone as the other two standing facts')
/* The fact, not the value. Putting the balance in the key looked like it made
   "ran out again" a new fact and could not: the banner only renders at zero, so
   the only key it could ever write was the exhausted one. */
check('and a dismissal is remembered against the fact, not for ever',
  panel.includes("useStandingNotice('reveals-exhausted', wallet?.balance === 0)"),
  'running out, buying a pack and running out again is a new fact and has to say so')
/* Running out is still said where it is actionable — the reveal button names
   the price before it is pressed and refuses at zero with the reason. */
check('but running out is still said at the point of spending',
  panel.includes('No reveals left'))

section('The workspace fills the window from a small margin')
check('it is no longer a centred column',
  /\.workspace-shell\{[^}]*max-width:none/.test(css))
check('and starts at the left',
  /\.workspace-shell\{[^}]*margin:0/.test(css))
check('the bar follows the same edge as the work beneath',
  /\.workspace-shell \.portal-bar-inner\{[^}]*margin:0/.test(css))

/*
 * The bar reaches the window edges by cancelling the page padding rather than
 * by `width: 100vw`. The shared rule offsets with `calc(50% - 50vw)`, which is
 * only correct for a centred element — left-aligned it pushed the bar sideways
 * and clipped the wordmark off one edge and Sign out off the other.
 */
check('the bar cancels the page padding rather than using 100vw',
  /\.workspace-shell \.portal-bar\{[^}]*width:auto/.test(css))

section('One screen, no scrolling')
check('the shell is exactly a window tall',
  /\.workspace-shell\{[^}]*height:100vh/.test(css))
/*
 * Deliberately no `overflow: hidden` on the shell: a clipping ancestor cuts off
 * exactly the negative margins the bar uses to reach the window edges. The row
 * below clips instead.
 */
check('the shell itself does not clip',
  !/\.workspace-shell\{[^}]*overflow:hidden/.test(css),
  'clipping here takes the bar\'s full-bleed margins with it')
check('the columns clip instead',
  /\.workspace-shell \.ws-body\{[^}]*overflow:hidden/.test(css))
check('and the results column takes its own scrollbar',
  /\.workspace-shell \.ws-main\{[^}]*overflow-y:auto/.test(css))
check('with room left for the messaging dock',
  /\.workspace-shell \.ws-main\{[^}]*padding-bottom/.test(css),
  'it is fixed over the bottom right and would cover the last result')

/* The page reserved room under the workspace for a footer it does not have,
   which made a screen-tall shell into a screen-plus-2rem page. */
check('no room is reserved for a footer that is not there',
  css.includes('.main-portal:has(.workspace-shell){padding-bottom:0}'))
/*
 * And no scrollbar gutter. `html { scrollbar-gutter: stable }` exists so a page
 * growing past the viewport does not shift sideways when the scrollbar arrives;
 * this one cannot grow, so the gutter was 15px of reserved nothing — and it was
 * what kept the full-bleed bar short of the right edge.
 */
check('and no gutter reserved for a scrollbar that cannot appear',
  css.includes('html:has(.workspace-shell){scrollbar-gutter:auto}'))
check('the gutter still stands everywhere else',
  css.includes('html{scrollbar-gutter:stable}'),
  'pages that do scroll still must not jump sideways when the bar arrives')

/* Below the rail breakpoint there is not enough height, so the page scrolls
   normally again rather than trapping content in a fixed frame. */
check('a short window falls back to a scrolling page',
  /@media[^{]*max-width:1000px[^{]*\{[^}]*\.workspace-shell\{height:auto/.test(css.replace(/\s/g, ''))
  || css.includes('.workspace-shell{height:auto;overflow:visible}'))

section('Sign out sits at the window edge')
check('it is pulled past the bar padding',
  /\.portal-bar-actions\{margin-right:-1\.15rem\}/.test(css))
check('and the pull shrinks with the padding on a phone',
  /\.portal-bar-actions\{margin-right:-\.65rem\}/.test(css)
  || /\.portal-bar-actions\{margin-right:-0\.65rem\}/.test(css),
  'the bar drops to 1rem there, so a 1.15rem pull would hang the button off the edge')

section('The composer attaches with a paperclip')
const hero = read('../client/src/components/SearchHero.jsx')
check('the words are gone', !hero.includes(">'Attach a file'") && !hero.includes('Attach a file<'))
check('an icon takes their place', hero.includes('function PaperClip'))
/* An icon cannot say which file it took, so the name appears beside it after
   the fact — that is the state you have to be able to check. */
check('the filename still shows once there is one',
  hero.includes('composer-attach-text'))
check('and the button keeps a name for a screen reader',
  /aria-label=\{heldLabel \?/.test(hero),
  'the label is built from heldLabel now, which is the filename and — in the '
  + 'public demo, where the same clip also takes applicant CVs — how many of those')

// ------------------------------------------------------------- notices ---

section('One notice at a time, and a way out of it')
/*
 * Two kinds of message, told apart.
 *
 * A confirmation is news for a moment: it clears itself after thirty seconds,
 * and a second one REPLACES the first rather than stacking under it — a
 * candidate who saved twice used to read two green banners, neither of them
 * current. A standing fact does not time out, but it can be dismissed, and once
 * the fact changes it is allowed to speak again.
 */
const noticeSource = read('../client/src/components/Notice.jsx')

check('thirty seconds is stated once, not typed at each call site',
  /export const NOTICE_MS = 30_000/.test(noticeSource))
check('every notice can carry a dismiss control',
  /className="notice-close"/.test(noticeSource)
  && /aria-label="Dismiss this message"/.test(noticeSource))
check('a status line shows at most one message, and the failure wins',
  /const shown = error \|\| notice/.test(noticeSource)
  && /tone=\{error \? 'error' : 'ok'\}/.test(noticeSource),
  'a red line and a green line stacked means one of them is no longer true')
check('and the countdown is keyed on the message, not on the callback',
  /\}, \[shown, ms\]\)/.test(noticeSource),
  'callers write onDismiss inline, so depending on it restarts the timer every '
  + 'render and it never fires')
check('a standing notice remembers being dismissed against the fact itself',
  /sessionStorage/.test(noticeSource) && /cursus\.notice\./.test(noticeSource))

/* The pairs that used to stack are gone from the screens that had them. */
for (const [name, source] of [
  ['the workspace', panel],
  ['the portal', read('../client/src/pages/CandidatePortal.jsx')],
  ['Triage', read('../client/src/components/TriageTab.jsx')],
  ['pricing', read('../client/src/pages/PricingPage.jsx')],
]) {
  check(`${name} renders its status through the one component`,
    source.includes('<StatusNotice'))
  check(`and no longer paints a bare alert paragraph in ${name}`,
    !/\{\w+ && <p className="alert alert-(error|ok)">/.test(source),
    'each of those was a message with no way to remove it and no end to it')
}

check('a seat subscription about to change is warned about a month ahead',
  /const MONTH_MS = 30 \* 24 \* 60 \* 60 \* 1000/.test(panel)
  && /<SeatPlanBanner/.test(panel),
  'the thing to do about it takes longer than an afternoon')

section('Account screens open over the work')
/*
 * Team, billing and the profile used to replace the main column, so checking a
 * seat count cost the search you were reading — results are expensive to
 * produce and there is no going back to them without running the search again.
 */
check('they are a dialog, not a section', panel.includes('function WorkspaceDialog'))
check('and the main column no longer renders them',
  !/\{tab === 'billing'/.test(panel) && !/\{tab === 'profile'/.test(panel))
check('the section state and the dialog state are separate',
  /const \[dialog, setDialog\]/.test(panel),
  'one is where you are working, the other is an errand over the top of it')
check('the rail\'s account menu opens the dialog',
  /onGo=\{\(key\) => \(key === 'billing' \? openBilling\(\) : setDialog\(key\)\)\}/.test(panel),
  'through openBilling for Billing, so it names a product like every other route in')
check('a deep link from elsewhere still lands on the right screen',
  /\['team', 'billing', 'profile'\]\.includes\(wanted\)/.test(panel))
check('a non-admin cannot be left holding an admin screen',
  /if \(!admin && \['team', 'billing'\]\.includes\(dialog\)\) setDialog\(null\)/.test(panel))
check('it is large and scrolls inside itself',
  /\.workspace-dialog\{[^}]*max-height/.test(css)
  && /\.workspace-dialog-body\{[^}]*overflow-y:auto/.test(css))
check('with the header pinned, so the way out survives a long page',
  /\.workspace-dialog-head\{[^}]*flex:none/.test(css))

section('One menu per conversation')
/*
 * View profile and Close conversation sat in a strip inside an open window, and
 * there was no way at all to mark a conversation unread or clear it — so which
 * actions you could reach depended on whether the conversation happened to be
 * open. One component, mounted on the list row and in the window header.
 */
check('the action strip is gone', !panel.includes('chat-window-actions'))
check('one menu component serves both places',
  (panel.match(/<ConversationMenu/g) ?? []).length === 2
  && (panel.match(/function ConversationMenu/g) ?? []).length === 1)
for (const item of ['View profile', 'Mark as unread', 'Close conversation', 'Delete conversation']) {
  check(`it offers ${item}`, panel.includes(`>${item}<`) || panel.includes(item))
}
/* Closing stops the candidate replying, so it is asked rather than done — and
   asked by the dock, because the menu may be on a row with no window open. */
check('closing is confirmed', panel.includes('Close this conversation?'))
check('and the dock owns that, not the window',
  panel.includes('const [pendingClose, setPendingClose]')
  && !panel.includes('const [confirmClose, setConfirmClose]'))
/* Clearing is one-sided and leaves the other party's copy alone; closing is
   mutual. Different acts, so they are not the same button. */
check('clearing and closing are separate items',
  panel.includes("del(`/api/hr/threads/${candidateId}`") && panel.includes("'close'"))
check('each row says when it last moved', panel.includes('dock-when'))

section('The results screen says less')
const filters = read('../client/src/components/ResultFilters.jsx')
/* A funnel rather than the word: the row is a strip of controls and this was
   the only one that had to be read. */
check('Filters is an icon', filters.includes('function Funnel'))
check('and keeps a name for a screen reader',
  filters.includes('<span className="sr-only">Filters</span>')
  && /aria-label=\{activeCount > 0/.test(filters))
/*
 * Four sentences of standing explanation above every result list — true, worth
 * being readable, and re-read on every search whether or not anyone wanted it.
 */
check('the scoring explanation folds into an (i)', filters.includes('<InfoHint text={note}'))
/*
 * And the bubble opens out of the results column rather than inside it. It sits
 * above the button by preference, and the toolbar that carries it is the first
 * row of .ws-main — which scrolls, so it clips. The bubble was rendered, sized
 * and completely invisible: hovering the (i) appeared to do nothing at all.
 *
 * Measuring the bubble's box does not catch this. A clipped element still
 * reports its full width, which is how it was signed off as working once
 * already. What it needs is to leave the clipper and to flip below when there is
 * no room above.
 */
const hint = read('../client/src/components/InfoHint.jsx')
check('the bubble escapes the scrolling results column',
  hint.includes('createPortal') && hint.includes('document.body'))
check('and drops below the (i) when there is no room above',
  hint.includes('const above = trigger.top > height + GAP'))
check('its anchored offsets are released once it is fixed',
  /\.info-hint-bubble-floating\{[^}]*transform:none/.test(css)
  && /\.info-hint-bubble-floating\{[^}]*bottom:auto/.test(css),
  'bottom and the centring transform would fight the measured coordinates')
check('and is no longer a paragraph on the page',
  !panel.includes('className="muted scoring-note"'))
check('it is built from the response, not retyped', panel.includes('const scoringNote ='))
/*
 * And it says how to read the scores, nothing else. Two sentences used to follow
 * — which engine did the reading, and how many profiles came from cache. An
 * environment variable and a cache-hit count are operator's notes; this bubble
 * is what a recruiter opens to find out whether an 82 beats a 79.
 */
check('the note carries no operator detail',
  !panel.includes('Set ANTHROPIC_API_KEY to have Claude read each profile in full.')
  && !panel.includes('reused from earlier.'),
  'the engine and the cache count are not how a score is read')

section('The document actions are one set')
/*
 * View, New tab and Download act on the same file and carry the same weight.
 * View was a filled secondary button, which made one of three equals look like
 * the answer; and New tab is an anchor — a real link, so it can be
 * middle-clicked — which meant the browser's underline stayed on it and the row
 * read as two buttons and a link.
 */
check('all three are the same quiet button',
  (panel.match(/className="btn btn-quiet btn-small"/g) ?? []).length >= 3
  && !/className="btn btn-secondary btn-small"[\s\S]{0,120}'Hide' : 'View'/.test(panel))
check('and the link among them is not underlined',
  /\.doc-actions \.btn\{[^}]*text-decoration:none/.test(css))
check('with all three centred on the same line',
  /\.doc-actions \.btn\{[^}]*align-items:center/.test(css),
  'as flex items they stretch, and a stretched anchor holds its text at the top')

section('The rail heading sits with its list')
/*
 * "Searches" labels the history under it, and is read against the day headings
 * and search titles immediately below — all at 0.55rem. It was set to the
 * 0.7rem the nav buttons above use, so it stood proud of its own contents.
 */
check('the heading is indented like the list it names',
  /\.ws-rail-heading\{[^}]*padding:0 \.55rem/.test(css)
  || /\.ws-rail-heading\{[^}]*padding:0 0\.55rem/.test(css))
/*
 * Plus 2px of optical correction, which looks like a redundant declaration and
 * is not. With the boxes at an identical 32.8px the heading still read as
 * indented: a glyph starts at its own left side bearing, and in this face the S
 * of SEARCHES begins 1px inside its box while the Y of YESTERDAY begins 1px
 * outside. Measured from the rendered pixels, the ink was at 35 against 33.
 */
check('and nudged left so the ink lines up, not just the boxes',
  /\.ws-rail-heading\{[^}]*padding-left:calc\(\.?0?\.?55rem - 2px\)/.test(css),
  'geometric alignment left a visible 2px step between SEARCHES and YESTERDAY')
check('which is where the day headings are',
  /\.chat-group\{[^}]*margin:0 0 \.25rem \.55rem/.test(css)
  || /\.chat-group\{[^}]*margin:0 0 0\.25rem 0\.55rem/.test(css),
  'the two numbers have to move together or the heading drifts again')

section('The greeting does not track the clock')
/*
 * It said Good morning / afternoon / evening from the reader's own clock, with a
 * timer to keep it true across noon. A fixed welcome needs neither, so the timer
 * goes with it rather than being left running against nothing.
 */
const hero2 = read('../client/src/components/SearchHero.jsx')
/* Quoted literals, not bare words: a prose mention of the old greeting in a
   comment explaining why it went is not a regression, and matching one is how a
   check ends up asserting nothing but its own commentary. */
check('it welcomes rather than telling the time',
  hero2.includes('Welcome back')
  && !/'Good (morning|afternoon|evening)'/.test(hero2))
check('and the minute timer that kept it true is gone',
  !hero2.includes('useGreeting') && !/setInterval\([^)]*greeting/.test(hero2))
check('the name still follows it', /\{name && <>, \{name\}<\/>\}/.test(hero2))

section('A finished search can be amended or run again')
/*
 * A completed search offered one route out: start a new one. Two things a
 * recruiter actually wants were unreachable — fixing one line of a brief, and
 * looking again at a pool that has moved since.
 */
/* The wiring rather than the label text: a button whose handler is missing
   reads correctly and does nothing, which is the failure worth catching. */
check('the composer offers both',
  /onClick=\{onModify\}/.test(hero2) && /onClick=\{onRefresh\}/.test(hero2))
check('modifying keeps the results on screen',
  /function modifySearch\(\) \{\s*setEditing\(true\)/.test(panel.replace(/\r/g, '')),
  'clearing the list the moment you click Modify punishes you for looking')
/*
 * Refresh has to bypass the resume, or it is a no-op: an unchanged JD finds the
 * same job and resumes its stored session, which can only ever show the set of
 * candidates that existed when it was made. The saving is that per-candidate
 * analyses stay cached against the job, so a refresh pays only for newcomers.
 */
const pipeline = read('../server/src/matching/pipeline.js')
check('refreshing builds a new session rather than resuming',
  /const resumed = created \|\| refresh \? null : latestSession/.test(pipeline))
check('and the route passes the recruiter\'s intent through',
  /refresh: req\.body\?\.refresh === true/.test(read('../server/src/index.js')))


/* The chips are a readout of what was found; a sentence saying the readout is
   empty says less than the empty space. */
check('the "no skills recognised" line is gone',
  !panel.includes('No specific skills were recognised'))

/*
 * Red was being used for the ordinary state of most of a candidate pool, in the
 * colour this product uses for errors. Green marks recent activity; absence
 * needs no key, and the legend no longer claims to explain one.
 */
check('the activity legend has one key, not two',
  !panel.includes('No sign of them in that time'))
check('and an inactive candidate gets no mark',
  panel.includes('activity-dot-none') && !panel.includes("' activity-dot-off'"))
check('but keeps the space, so the column stays aligned',
  css.includes('.activity-dot-none{background:none;border:0}'))

section('The composer asks for one thing')
check('the optional steer is gone', !hero.includes('composer-instruction"'))
check('a rule divides what you are asking from the controls that send it',
  /\.composer-row\{[^}]*border-top:1px solid/.test(css))
/* While typing the box is capped so the composer does not push the page about;
   afterwards the cap only hid what was searched for behind an inner scrollbar. */
check('a submitted search shows its whole job description',
  /el\.style\.height = submitted/.test(hero))
/* New search is the first thing in the rail on every screen. A second copy
   here, in the primary colour, made the loudest control the one that throws
   your results away. */
check('there is no second New search button on a finished search',
  !/<button type="button" className="btn btn-primary" onClick=\{\(\) => onNewSearch/.test(hero))

section('An unreadable inbox says so')
/*
 * A failed load used to be swallowed by a bare `.catch(() => {})`, leaving the
 * dock showing its empty state — "reveal a candidate and message them" — over
 * an inbox that was never fetched. The two look identical and mean opposite
 * things.
 */
check('the threads load records its failure', panel.includes('setThreadsError'))
check('and the dock distinguishes broken from empty',
  panel.includes('Your conversations could not be loaded'))
check('the thread payload carries no photo filename',
  !read('../server/src/workspace.js').includes('c.location, c.photo_name, c.availability')
  || read('../server/src/workspace.js').includes('const { name, first_name, last_name, photo_name, ...rest } = thread'),
  'the filename identifies someone on its own; a boolean is all the avatar needs')

section('Several rows at once, the same way on both lists')
/*
 * Folders and Triage are the same list of the same shape, so selection is one
 * module used twice rather than two that happen to agree today. What is checked
 * here is the part a second implementation would get subtly different: that the
 * tick REPLACES the row icon instead of adding a column — otherwise opening
 * select mode shoves every name sideways — and that a ticked row does not also
 * open.
 */
const triageTab = read('../client/src/components/TriageTab.jsx')
const listSelect = read('../client/src/components/ListSelect.jsx')

check('one selection module, imported by both lists',
  /from '\.\.\/components\/ListSelect\.jsx'/.test(panel)
  && /from '\.\/ListSelect\.jsx'/.test(triageTab))
check('the tick takes the icon’s place rather than a column of its own',
  /selection\.selecting \? <RowTick[\s\S]{0,40}: <FolderIcon/.test(panel)
  && /selecting \? <RowTick[\s\S]{0,40}: <TriageIcon/.test(triageTab))
check('so no row is given an extra grid track while selecting',
  !/\.drive-item-selecting\{[^}]*grid-template-columns/.test(css))
check('a ticked row ticks instead of opening',
  /selection\.selecting \? selection\.toggle\(folder\.id\) : setOpenFolder/.test(panel)
  && /const act = selecting \? onTick : onOpen/.test(triageTab))
check('and says so to a screen reader',
  (panel.match(/aria-checked=/g) ?? []).length >= 1
  && (triageTab.match(/aria-checked=/g) ?? []).length >= 1)
check('deleting several asks first, by number and by name',
  /Delete \{things\}\?/.test(listSelect),
  'the one thing this control makes easy is destroying several things at once')
check('and each row is deleted by the route a single delete uses',
  /del\(`\/api\/hr\/folders\/\$\{id\}`/.test(panel)
  && /del\(`\/api\/hr\/triage\/\$\{id\}`/.test(triageTab),
  'a bulk path with its own route is a bulk path with its own permission bugs')
check('a selection cannot outlive the rows it points at',
  /const present = new Set\(ids\)/.test(listSelect),
  'a tick against a row that has gone would be counted, then deleted invisibly')

/*
 * The builder is three numbered steps, and it says so. "1 · The role" beside a
 * "2" and a "3" further down reads as a list of sections; a recruiter opening
 * this for the first time is being walked through something.
 */
check('the builder counts its steps out loud',
  ['Step 1 · The role', 'Step 2 · The CVs', 'Step 3 · Start']
    .every((heading) => triageTab.includes(`<h3>${heading}</h3>`)))

/*
 * And a folder is a way of handing over CVs.
 *
 * Applications arrive in a directory, not as a selection — and there were two
 * ways for that to go nowhere: the file picker cannot be told to take one, and
 * `dataTransfer.files` is empty when a folder is dropped, so the most natural
 * gesture on a dropzone did nothing at all. Both are answered: a second input
 * that asks for a directory, and a walk of the entries when something is
 * dropped.
 */
check('a folder can be picked',
  /webkitdirectory=""/.test(triageTab)
  && /Choose a folder instead/.test(triageTab))
check('and the picker it opens is not the other one',
  /event\.stopPropagation\(\); folderInput\.current\?\.click\(\)/.test(triageTab),
  'the dropzone underneath is itself a button, and would open the file picker too')
check('a dropped folder is walked rather than ignored',
  /webkitGetAsEntry\(\)/.test(triageTab)
  && /filesFromDrop\(event\.dataTransfer\)/.test(triageTab),
  'dataTransfer.files is empty for a directory')
check('and the walk reads past the first hundred entries',
  /readEntries/.test(triageTab) && /if \(batch\.length === 0\) break/.test(triageTab),
  'one readEntries call takes a folder of five hundred as a hundred, silently')
check('what a folder brings that is not a CV is dropped and counted',
  /\/\\.\(pdf\|docx\)\$\/i\.test\(file\.name\)/.test(triageTab)
  && /not a PDF or Word file/.test(triageTab),
  'posting a folder of screenshots to be refused one by one buries the real number')

/*
 * A folder remembers what the candidate scored, and against what.
 *
 * A score only exists relative to one job description, and a folder is not one
 * — so opening a saved candidate used to show nothing at all where the number
 * had been. It is copied at the moment of saving instead, with the search it
 * came from and the reading that produced it, and presented as a record of a
 * judgement made on a day rather than as a live figure.
 */
check('the row the recruiter was looking at is sent with the save',
  /const snapshot = row \? \{/.test(panel)
  && /folderId \? \{ candidateId, snapshot, folderId \} : \{ candidateId, snapshot \}/.test(panel),
  'the folder is optional; the reading never is')
const server = read('../server/src/index.js')
check('and the server bounds it rather than trusting it',
  /Math\.max\(0, Math\.min\(100, Math\.round\(Number\(shown\.score\)\)\)\)/.test(server)
  && /session\.retrievedIds\.includes\(candidateId\)/.test(server),
  'the displayed score is not stored anywhere, so it has to come from the client — inside limits')
const workspace = read('../server/src/workspace.js')
check('the folder carries it back out, named and dated',
  /score: saved_score,/.test(workspace) && /scoredFor: scored_for \?\? null/.test(workspace))
/*
 * And a folder filled before any of this existed is not left blank. The chain
 * folder → the search that made it → that search's job → the analysis already
 * stored for this candidate is all present; nothing is recomputed.
 */
/*
 * And the row shows it, nought included. `item.score && …` would hide exactly
 * the candidate a recruiter most wants to spot in a shortlist — the one who
 * matched nothing — so the test is for a finite number rather than a truthy
 * one, and the cell is rendered either way so the grid does not shift.
 */
check('the folder row carries the score, and nought is a score',
  /Number\.isFinite\(item\.score\) && \(/.test(panel)
  && /className="drive-item-score"/.test(panel))
check('with the cell present even when there is nothing to put in it',
  /<span className="drive-item-score">\s*\{Number\.isFinite/.test(panel),
  'a disappearing cell drags the next column left on that row alone')

check('a row saved before the snapshot recovers its reading',
  /function recoveredReading\(candidateId, folderId\)/.test(workspace)
  && /recoveredReading\(item\.candidate_id, item\.folder_id\)/.test(workspace),
  'otherwise every folder that predates the feature opens with no number and no reason')
check('and the dialog says it is a snapshot, not a live ranking',
  /As it stood on/.test(panel) && /may place them differently/.test(panel),
  'a stale number shown as though it were current is the more misleading of the two')

check('pressing + on Triage writes nothing',
  /function create\(\) \{[\s\S]{0,200}onOpen\(null\)/.test(triageTab)
  && !/function create\(\) \{[\s\S]{0,200}post\('\/api\/hr\/triage'/.test(triageTab),
  'it used to POST a draft, so opening the screen and leaving added a row to everyone’s list')
check('the row is created by the first thing written into the builder',
  /async function ensureId\(\)/.test(triageTab)
  && /if \(idRef\.current\) return idRef\.current/.test(triageTab))
check('and blurring an untouched field is not "something written"',
  /if \(!idRef\.current && !String\(next\)\.trim\(\) && !String\(nextTitle\)\.trim\(\)\) return/.test(triageTab))

section('Folders and Triage are one screen with two lists')
/* Both now open the same way and explain themselves the same way. The empty
   state's button is exempt from the click-outside dismisser, or the click that
   opens the name field is the click that closes it — the listener is on the
   document, and the click that set `creating` is still on its way up to it. */
check('Folders says what it is for, where Triage does',
  /className="muted triage-lede"[\s\S]{0,120}Keep the people you shortlist together/.test(panel))
check('and its empty state offers the way in, as Triage does',
  /className="btn btn-primary folder-start"/.test(panel))
check('with that button exempt from the dismisser that would close it again',
  /closest\?\.\('\.folder-new, \.drive-add, \.folder-start'\)/.test(panel))

section('The rail is a way back, not an archive')
/*
 * A recruiter who runs twelve searches in a morning should still be able to
 * reach yesterday's without scrolling past all of them. The caps are the point;
 * the floors are what stops a busy morning pushing the rest of the week off the
 * rail entirely. Everything is still reachable behind the ⋯.
 */
const sidebar = read('../client/src/components/ChatSidebar.jsx')

/* Exercised rather than grepped: this is arithmetic about dates, and arithmetic
   is worth running. It lives in a plain module for exactly that reason — a rule
   inside a .jsx component cannot be imported here at all. */
const { railSlice } = await import('../client/src/rail.js')
const day = 86400000
/*
 * Anchored to noon today, not to "hours ago".
 *
 * The buckets are calendar days, so a fixture built as now-minus-two-hours is
 * yesterday's search when the suite runs just after midnight — which is exactly
 * how this failed at 00:09.
 */
const noon = new Date()
noon.setHours(12, 0, 0, 0)
const at = (daysAgo, i) => new Date(noon.getTime() - daysAgo * day - i * 60000).toISOString()
const many = (count, daysAgo, tag) => Array.from({ length: count }, (_, i) => (
  { id: `${tag}${i}`, title: `${tag} ${i}`, updated_at: at(daysAgo, i) }
))

const busy = railSlice([
  ...many(14, 0, 'today'),
  ...many(9, 1, 'yesterday'),
  ...many(6, 4, 'week'),
  ...many(7, 12, 'month'),
  ...many(5, 60, 'older'),
])
const kept = (tag) => busy.filter((chat) => String(chat.id).startsWith(tag)).length

check('today shows ten at most', kept('today') === 10)
check('the rest of the week shows five at most, across both its headings',
  kept('yesterday') + kept('week') === 5,
  '"Yesterday" and "Previous 7 days" are one stretch of time with two headings')
check('the month shows three at most', kept('month') === 3)
check('and a full day still leaves at least three from the week and one from the month',
  kept('yesterday') + kept('week') >= 3 && kept('month') >= 1)
check('a quiet week is not padded — nothing is invented to reach a cap',
  railSlice(many(2, 0, 'today')).length === 2)
check('everything else is reachable, not lost',
  /className="chat-more"/.test(sidebar) && /AllSearches/.test(sidebar))
check('the full list can be searched by name and flipped oldest-first',
  /placeholder="Search your saved searches"/.test(sidebar)
  && /\['oldest', 'Oldest first'\]/.test(sidebar),
  'the box says which names it searches: a bare "by name" beside a list of '
  + 'candidates reads as a candidate search')
/* And the dialog covers the page rather than the rail it was opened from. */
check('the dialog is mounted on the page, not inside the scrolling rail',
  /return createPortal\(/.test(sidebar) && /document\.body,/.test(sidebar),
  'painted inside the history it was opened from, the results column came out on top of it')

section('The result card says one thing per line')
/*
 * What went, and why each one:
 *
 *   the rank      — a list is already in order, and "1." reads as a placing;
 *   MATCH         — the axis, not the unit; the number is now a percentage;
 *   Save          — one of three actions on the card with the other two behind
 *                   a dialog, so revealing four people meant four dialogs;
 *   Will relocate — a chip nobody filters on, in a row of chips people read;
 *   the word "Revealed" — the eye already says it, and the name does not.
 */
/* The card only. "Will relocate" is still a chip on a candidate row inside a
   folder, which is a different screen and was not asked about. */

check('no rank number beside the name', !/className="result-rank"/.test(panel))
check('the score is a percentage', /\{result\.score\}%/.test(panel))
check('with no label under it', !/className="score-label"/.test(panel))
const cardHeading = card.slice(card.indexOf('<h3>'), card.indexOf('</h3>'))
check('availability sits with the name, not on the photograph',
  cardHeading.includes('<ActivityDot')
  && !/result-portrait[\s\S]{0,160}<ActivityDot/.test(card))
check('no Save button on the card',
  !/\{saving \? 'Saving…' : 'Save'\}/.test(panel))
/* Bounded by the corner itself: it holds a tag editor and a comment button as
   well now, so a character window is a guess about how many. */
const cardCorner = card.slice(
  card.indexOf('className="result-menu"'),
  card.indexOf('</span>', card.indexOf('<PopMenu')),
)
check('the actions are behind the dots every other row uses',
  cardCorner.includes('<PopMenu'))
check('and they are: save in folder, reveal, not relevant',
  /key: 'folder',\s*\n\s*label: 'Save in folder'/.test(panel)
  && /key: 'reveal'/.test(panel)
  && /key: 'dismiss', label: 'Not relevant'/.test(panel))
check('the folder line is a control, not a statement',
  !/label: saved \? `Saved in/.test(panel) && /onSelect: \(\) => onFile\?\.\(\)/.test(panel),
  'it used to read "Saved in Backend hires" and do nothing when pressed — at '
  + 'the one moment a recruiter is most likely to want a different folder')
check('and pressing it opens the folder dialog',
  /\{filing !== null && \(\s*\n\s*<FolderDialog/.test(panel)
  && /onPick=\{\(folderId\) => saveToSearchFolder\(filing, folderId\)\}/.test(panel))
/*
 * The corner is now one stack: buttons, then the score under them.
 *
 * It was two — the dots pinned absolutely to the corner and the score on the
 * card's centre line — because a score that flowed with the card height stopped
 * lining up row to row. Pinning the whole stack instead keeps that property and
 * gets the number out of the middle of the row.
 */
check('the corner is one pinned stack, not two positioned pieces',
  /\.result-side\{position:absolute/.test(css)
  && !/\.result-menu\{position:absolute/.test(css),
  'two absolutes meant the score had to be offset to match the buttons by hand')
check('and the score sits under the buttons, centred on them',
  /\.result-side\{[^}]*flex-direction:column/.test(css)
  && /\.result-side\{[^}]*align-items:center/.test(css))
check('no relocation chip on the card', !/Will relocate/.test(card))
/*
 * And no document chips either.
 *
 * "Cover letter" and "+2 documents" reported what was attached before a
 * recruiter could open any of it — a fact about the profile rather than a
 * reason to look at the person, and it crowded the two chips that are.
 */
check('no document chips on the card',
  !/chip chip-neutral">Cover letter/.test(card)
  && !/\+\{extras\} document/.test(card))
/* The folder chip sits with the reveal it belongs beside, not under the
   summary two lines away. */
check('the folder chip is in the corner, before the reveal chip',
  card.indexOf('chip chip-folder') > card.indexOf('className="result-menu"')
  && card.indexOf('chip chip-folder') < card.indexOf('chip chip-revealed'))
/* The folder chip now precedes it in the corner, so the slice runs the other
   way: from the reveal chip to the end of the corner rather than to the folder
   chip that used to sit two lines below the summary. */
const revealedChip = card.slice(
  card.indexOf('chip chip-revealed'),
  card.indexOf('<PopMenu', card.indexOf('chip chip-revealed')),
)
check('the revealed chip is the eye and the colleague who spent it',
  revealedChip.includes('<EyeIcon size={13} />')
  && revealedChip.includes('result.revealedBy.name'))
/*
 * Its opposite is not a chip any more. A struck-through eye under the summary
 * announced a state and gave no way out of it, while Reveal sat inside the ⋮
 * menu — on the row where a recruiter most wants it. Same mark, moved to the
 * corner, ahead of the + so it reads before the things that only file.
 */
check('and the unrevealed one is that eye as the button that undoes it',
  /className="icon-button result-reveal"/.test(panel)
  && /<EyeOffIcon \/>/.test(panel)
  && /function EyeOffIcon/.test(panel))
check('placed before the tag and comment controls, not after them',
  cardCorner.indexOf('result-reveal') < cardCorner.indexOf('<TagEditor'),
  'the corner reads reveal, file, discuss, everything else')

/*
 * One slot, holding whichever way the reveal question is answered. The green
 * chip used to sit among the chips two lines below while its opposite number
 * was up in the corner, so the same fact was reported in two different places
 * depending on the answer.
 */
check('and the revealed chip takes that same slot rather than a line of its own',
  cardCorner.includes('chip chip-revealed'),
  'revealed and not-revealed are one question and belong in one place')
check('with nothing left of it in the band under the row',
  !card.slice(card.indexOf('result-say')).includes('chip chip-revealed'))
check('a first name is all an unrevealed candidate shows — still the server\u2019s call',
  read('../server/src/schema.js').includes('view.display_name = maskedDisplayName(candidate.first_name)'),
  'hiding the surname in the client while the payload carries it would be theatre')

section('The card reads left to right, and the number sits in the middle')
/*
 * Three things about a row that only show up once you measure them: the score
 * is on the card's centre line rather than against its right edge, the reveal
 * tag says who spent it — "me" when that was the reader — and the name it sits
 * under is the first name alone until somebody pays for the rest.
 */
/*
 * The row is one track now, and the score has left it.
 *
 * Three tracks existed to hold the number on the card's centre line, with an
 * empty balancing column on the right to do it. The number lives in the corner
 * under the buttons instead, so the person gets the full width and there is
 * nothing left to balance.
 */
check('the row is a single track',
  /\.result-main\{[^}]*grid-template-columns:minmax\(0,1fr\)[;}]/.test(css))
check('and the balancing column is gone with the reason for it',
  !card.includes('className="result-spacer"'),
  'an empty track that balanced nothing would still take a third of the row')
check('and the name truncates rather than pushing the dot onto its own line',
  /className="result-name"/.test(card)
  && /\.result-name\{[^}]*text-overflow:ellipsis/.test(css))

check('the reveal tag separates the eye from the name with a middle dot',
  /<span className="chip-dot" aria-hidden="true">·<\/span>/.test(card))
check('and it is set on the line rather than on the baseline',
  /\.chip-dot\{[^}]*translateY/.test(css),
  'a full stop between an icon and a name reads as the end of a sentence that never started')
check('the reader is "me", not their own name read back at them',
  /result\.revealedBy\.recruiterId === meId \? 'me' : result\.revealedBy\.name/.test(card))
check('and the id it compares against is the one /api/recruiter/me actually returns',
  /meId=\{me\?\.recruiter\?\.id \?\? null\}/.test(panel),
  'me.id is undefined — the payload wraps the recruiter in a key')
check('the list carries who revealed each person, by id',
  /recruiterId: row\.recruiter_id/.test(read('../server/src/profiles.js')))

check('a finished search offers Refresh, not a sentence',
  /\{busy \? 'Refreshing…' : 'Refresh'\}/.test(read('../client/src/components/SearchHero.jsx')))
check('and the scoring note says where that button is',
  /press Refresh on the search itself/.test(read('../server/src/index.js')),
  'the note explains why a score moved without saying how to bring new people in')

section('A profile is three things, not one scroll')
/*
 * The person, the argument for them against one job, and the conversation.
 * They were one column: reading somebody's CV meant scrolling past their score,
 * and answering a message meant scrolling past both. The tabs only exist once
 * the reveal is paid for — before that there is one thing to read and a tab bar
 * over a single tab is furniture.
 */

check('the tabs appear only once they are revealed',
  /\{revealed && \([\s\S]{0,200}dialog-tabs/.test(dialog))
/*
 * This asked for the wrong test and passed on it for months.
 *
 * The rule is "a Score tab only when there is a score"; the code asked whether
 * `result` existed, and a candidate opened from a folder is handed a `result` —
 * a { folder } with no score in it — so the tab appeared and appeared empty.
 * The condition is the score itself now.
 */
check('and Score is not offered when there is no score to show',
  /const scored = Number\.isFinite\(result\?\.score\)/.test(dialog)
  && /\.\.\.\(scored \? \[\['score', 'Score'\]\] : \[\]\)/.test(dialog),
  'a folder has no job description behind it, and `result` being present is not the same as a score')
check('the three are Profile, Score and Messages',
  /\['profile', 'Profile'\]/.test(dialog) && /\['messages', 'Messages'\]/.test(dialog))
const profileHeading = dialog.slice(dialog.indexOf('<h2>'), dialog.indexOf('</h2>'))
check('availability is the dot beside the name, as on the card',
  profileHeading.includes('<ActivityDot activity={data.activity}'))
check('with the worded chip kept only for somebody who asked not to be approached',
  /activity\?\.state === 'deactivated' && <ActivityChip/.test(dialog),
  'a red dot cannot tell "gone quiet" from "asked not to be approached"')
/* Still the struck-through eye, and now the button that undoes it — the same
   control the row grew, in the same corner, so the two screens say it once. It
   sat under the name as a chip that reported the state and left Reveal two
   levels down the menu. */
check('unrevealed is the struck-through eye, and it is pressable',
  /!revealed && \([\s\S]{0,400}className="icon-button result-reveal"[\s\S]{0,400}<EyeOffIcon \/>/
    .test(dialog),
  'a chip that names a state you can change is a button that forgot to be one')
check('and it is no longer also a chip under the name',
  !/chip chip-unrevealed/.test(dialog),
  'two ways of saying one thing on one screen')
/* Bounded by the element rather than by a character count: the corner holds a
   comment button as well now, and a window is a guess about how much. */
const dialogCorner = dialog.slice(
  dialog.indexOf('className="modal-menu"'),
  dialog.indexOf('</span>', dialog.indexOf('className="modal-menu"')),
)
check('the actions sit beside the close, on a vertical ellipsis',
  dialogCorner.includes('vertical')
  && /dock-dots-vertical/.test(read('../client/src/components/PopMenu.jsx')))
check('and revealing from that menu is the dialog\u2019s own reveal',
  /\{ key: 'reveal', label: 'Reveal', onSelect: reveal \}/.test(dialog),
  'two routes to one purchase is two places for it to go wrong')
check('the list behind catches up when the dialog spends',
  /onRevealed\?\.\(revealed\)/.test(dialog) && /function markRevealed/.test(panel),
  'otherwise the row keeps the masked name behind an open profile showing the real one')

check('the score is a percentage, and it is in the header',
  /<span className="score-value">\{result\.score\}%<\/span>/.test(dialog))
/* Still the job rather than the number — and named, when the reading was one
   saved into a folder and there is no job description on screen to point at. */
check('so the section under it is the job, not the number',
  /'Against this job description'/.test(reading)
  && /Against “\$\{result\.scoredFor\}”/.test(reading)
  && !/modal-subhead">Score</.test(reading))
check('and that section opens with a reading rather than a list of headings',
  /<ScoreInsights result=\{result\}/.test(reading)
  && /className="score-points"/.test(panel))
check('built from what the search already returned, not asked of the model again',
  !/fetch\(|post\(/.test(reading),
  'a second call to explain a number the first call already explained')
check('the two classes of criteria are named plainly',
  /label="Requirements"/.test(reading) && /label="Preferred"/.test(reading)
  && !/Preferred — missing/.test(reading) && !/label="Requirements missing"/.test(reading))
check('the city and the application date are gone from the facts',
  !/label="City"/.test(dialog + reading + profileTab)
  && !/label="Applied"/.test(dialog + reading + profileTab),
  'the city is already under the name, and the date is not a fact about the person')

/* The summary left this tab and went to the top of the dialog body, above the
   score and outside the tabs — this tab only exists after a reveal, so the one
   paragraph written to help a recruiter decide whether to pay was behind the
   payment. Everything else the tab holds is still its own. */
check('the profile tab is the whole person: contact, skills, documents',
  ['label="Email"', 'label="Phone"', '<CvActions'].every((part) => profileTab.includes(part)))
check('and the summary is above the tabs, where both halves of the dialog see it',
  /<ProfessionalSummary summary=\{candidate\.summary\} \/>/.test(dialog)
  && dialog.indexOf('<ProfessionalSummary') < dialog.indexOf('<ScoreReading'),
  'first below the header, revealed or not')
check('but not their name twice — it is the heading of the dialog',
  !profileTab.includes('label="Name"'))
check('the messages tab can close a conversation and reopen it',
  /setThread\(data\.threadStatus === 'closed'\)/.test(dialog)
  && /Reopen this conversation/.test(dialog) && /Close this conversation/.test(dialog),
  'said on the lock rather than in a button, so it still has to say both')

/*
 * The select is gone from both screens, not just from one.
 *
 * It was the only filing control a candidate opened from a folder had, and it
 * sat at the foot of the body under a CV — while the corner menu, where every
 * other per-row action lives, had nothing in it at all once they were revealed.
 * Every folder is named in the menu instead, with a way out of the current one.
 */
check('filing is in the corner menu rather than a select under the CV',
  !/className="folder-picker"/.test(dialog)
  && /const filing = onAddToFolder \?/.test(dialog)
  && /\.\.\.filing,/.test(dialog))
check('and a candidate in a folder can be taken out of it',
  /key: 'folder-remove'/.test(dialog) && /onRemoveFromFolder\(candidateId\)/.test(dialog)
  && /onRemoveFromFolder=\{removeItem\}/.test(panel),
  'the dialog could put them in a folder and never take them out of one')
check('and the running reveal balance is no longer printed on every profile',
  !/Costs 1 reveal/.test(dialog))
check('but a zero balance still says why the button is dead',
  /wallet\?\.balance === 0 && \([\s\S]{0,160}No reveals left/.test(dialog))

section('The profile header holds everything you came for')
/*
 * The identity, the number and the way between the three views are all fixed at
 * the top: none of them is worth scrolling back up for. The × went with them —
 * the backdrop and Escape both close this, and a close button spent the one
 * corner an action could live in.
 */
const profileHeader = dialog.slice(
  dialog.indexOf('<header className="modal-head candidate-head">'), dialog.indexOf('</header>'),
)
check('no close button in the profile header',
  profileHeader.length > 0 && !/aria-label="Close"/.test(profileHeader),
  'the backdrop and Escape close it; the corner is worth more as an action')
check('the actions stand where it was',
  dialogCorner.includes('<PopMenu') && dialogCorner.includes('vertical'))
check('the header is a fixed row and the body is what scrolls',
  /\.candidate-dialog\{[^}]*grid-template-rows:auto minmax\(0,1fr\)/.test(css)
  && /\.candidate-body\{[^}]*overflow-y:auto/.test(css),
  'sticky alone let the CV show through the person\u2019s name')
check('and the header paints, so nothing slides under it',
  /\.candidate-head\{[^}]*background:var\(--surface\)/.test(css))

check('who paid sits beside the person they paid for',
  /className="candidate-revealed-by"/.test(dialog)
  && !/className="alert alert-ok"[\s\S]{0,80}Revealed by/.test(dialog),
  'it was a banner across the body — a lot of screen for a fact about the name')
check('the score is in the header, centred, and big',
  /className=\{scored \? `candidate-head-score/.test(dialog)
  && /\.candidate-head-row\{[^}]*grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/.test(css)
  && /\.candidate-head-score \.score-value\{font-size:2\.15rem/.test(css))
check('the tabs are centred on the dialog too',
  /\.dialog-tabs\{[^}]*justify-self:center/.test(css))
check('and the score cell is rendered even without a score, so the menu stays put',
  /'candidate-head-score'\}>[\s\S]{0,200}\{scored && <span className="score-value"/.test(dialog))

section('A menu opened from a dialog is above the dialog')
/*
 * This one is invisible to a source read: the menu rendered, in the right
 * place, with the right items — and every click on it landed on the dialog
 * underneath, so Reveal did nothing at all. It sat at z-index 45 under a
 * backdrop at 50.
 *
 * Checked as numbers rather than as text, because the failure is an ordering
 * and not a spelling.
 */
const layer = (selector) => {
  /* Plain string work: building a regex out of a selector means escaping a
     leading dot, and getting that wrong reads as "no z-index" rather than
     as a broken check. */
  const at = css.indexOf(`${selector}{`)
  if (at < 0) return null
  const found = css.slice(at, css.indexOf('}', at)).match(/z-index:(\d+)/)
  return found ? Number(found[1]) : null
}
const menuLayer = layer('.dock-menu-floating')
const dialogLayer = layer('.modal-backdrop')
const readerLayer = layer('.reader-backdrop')

check('the floating menu sits above the modal backdrop',
  menuLayer !== null && dialogLayer !== null && menuLayer > dialogLayer,
  `menu ${menuLayer}, dialog ${dialogLayer}`)
check('and above the document reader, which opens over the dialog',
  readerLayer !== null && menuLayer > readerLayer,
  `menu ${menuLayer}, reader ${readerLayer}`)
check('a menu item cannot run off the menu, however long the folder name',
  /\.dock-menu-item\{[^}]*text-overflow:ellipsis/.test(css),
  'a search names its folder after the whole job description')

check('the profile offers Reveal only while there is something to reveal',
  /!revealed && \{ key: 'reveal', label: 'Reveal', onSelect: reveal \}/.test(dialog))
check('and Add to folder becomes where they went, once they are filed',
  /label: result\?\.folder \? `Saved in \$\{result\.folder\.name\}` : 'Add to folder'/.test(dialog))

section('Five bands, because a 51 and a 74 are not the same answer')
/* One module now, because Triage and the public demo draw scores too and each
   carried its own three-band version emitting classes the stylesheet has never
   defined. */
const bands = read('../client/src/scoreBand.js')
check('the bands are one function, used everywhere a score is drawn',
  /export default function scoreBand\(score\)/.test(bands)
  && /const band = scoreBand\(result\.score\)/.test(panel)
  && /score-\$\{scoreBand\(result\.score\)\}/.test(panel)
  && /import scoreBand from '\.\.\/scoreBand\.js'/.test(read('../client/src/components/TriageTab.jsx'))
  && /import scoreBand from '\.\.\/scoreBand\.js'/.test(read('../client/src/components/LiveDemo.jsx')),
  'a number has to mean the same thing on every screen that shows it')
check('and nobody still emits the three bands that were never styled',
  !/score-\$\{[^}]*'high'/.test(read('../client/src/components/TriageTab.jsx'))
  && !/'high' :/.test(read('../client/src/components/LiveDemo.jsx')))
check('80 and up is a green you can see',
  /score >= 80\) return 'excellent'/.test(bands) && /\.score-excellent\{[^}]*color:#1c6b45/.test(css))
check('70s a lighter green, 60s amber, 50s orange',
  /\.score-strong\{[^}]*color:#4a8f5f/.test(css)
  && /\.score-fair\{[^}]*color:#a2790f/.test(css)
  && /\.score-weak\{[^}]*color:#b56a24/.test(css))
check('and under 50 a muted red — a wrong fit is not an incident',
  /\.score-poor\{[^}]*color:#b0655f/.test(css))

section('The score reads as an argument, not as a tally')
check('the insights sit tight under the heading they open',
  /\.score-points\{margin:-\.?0?\.?25rem/.test(css))
check('and they never count what is missing',
  !/Meets \$\{met\.length\} of/.test(reading)
  && !/of \$\{met\.length \+ missing\.length\}/.test(reading),
  '"Meets 0 of 15" is the red tags below with arithmetic added, read as a verdict on a person')
check('they say what the tags cannot — transferable skills, thin evidence, where the gap sits',
  /analysis\?\.transferable/.test(reading)
  && /less certain than most/.test(reading)
  && /analysis\?\.reasoning/.test(reading))
check('and the code says where the real thing goes',
  /THE PRODUCT WANTS A DEDICATED FIELD/.test(panel),
  'the honest version is a field the model is asked for by name, in ai.js')

check('every requirement is listed, answered by colour',
  /<CriteriaRow label="Requirements" met=\{met\} missing=\{missing\}/.test(reading)
  && /<CriteriaRow label="Preferred"/.test(reading))
check('met is green and missing is red, in the same row',
  /met\.map\([\s\S]{0,90}chip chip-hit[\s\S]{0,140}missing\.map\([\s\S]{0,90}chip chip-miss/.test(panel),
  'naming only the misses made a candidate look like a set of holes')

section('The profile is the person, and the documents open here')
check('the summary comes before the contact details',
  profileTab.indexOf('Professional summary') < profileTab.indexOf('label="Email"'),
  'the only part written in sentences, above the phone number')
check('no current role — it is the CV\u2019s field, and it holds a date range as often as a title',
  !/label="Current role"/.test(profileTab))
check('industries sit above the skills they were practised in',
  profileTab.indexOf('label="Industries"') < profileTab.indexOf('label="Skills"'))
check('and they are fixed labels, not what the CV happened to call them',
  /getConcept\(row\.concept_id\)\?\.label/.test(read('../server/src/profiles.js')),
  'raw_label is free text the extractor wrote and has carried whole job titles')
check('the same industry is not listed twice for a re-read CV',
  /GROUP BY concept_id/.test(read('../server/src/profiles.js')))

check('the document actions are marks, not words',
  /<NewTabIcon \/>/.test(panel) && /<DownloadIcon \/>/.test(panel)
  && !/>\s*New tab\s*</.test(panel))
check('View is gone; the row itself opens the document',
  !/\{open \? 'Hide' : 'View'\}/.test(panel)
  && /className={readable \? 'doc-row doc-row-readable'/.test(panel))
check('and it opens in the product rather than in a browser tab',
  /function DocumentReader/.test(panel) && /className="pdf-frame reader-frame"/.test(panel))
check('the buttons inside the row do not open it as well',
  /className="doc-actions" onClick=\{\(event\) => event\.stopPropagation\(\)\}/.test(panel))

section('The conversation scrolls; the box you type in does not')
check('the composer stays while the thread moves',
  /\.chat-section-framed \.chat-log\{[^}]*overflow-y:auto/.test(css)
  && /\.chat-section-framed \.chat\{[^}]*grid-template-rows:minmax\(0,1fr\) auto/.test(css))
check('closing is a lock, not a sentence',
  /<LockIcon locked=\{data\.threadStatus === 'closed'\} \/>/.test(dialog)
  && !/>Close conversation</.test(dialog))
check('and the lock says which way it is, to a screen reader too',
  /aria-label=\{data\.threadStatus === 'closed' \? 'Reopen this conversation' : 'Close this conversation'\}/.test(dialog)
  /* Not also aria-pressed: paired with a label that names the action, it
     announced "Reopen this conversation, pressed" on a closed thread — which
     reads as the reopening having already happened. */
  && !/aria-pressed=\{data\.threadStatus/.test(dialog))

section('Marks where a word was doing an icon\u2019s job')
const chat = read('../client/src/components/ChatPanel.jsx')
const comments = read('../client/src/components/CommentsPopover.jsx')
const filterSource = read('../client/src/components/resultFilters.js')

check('the composer sends with a paper plane',
  /<SendIcon size=\{17\} \/>/.test(chat) && !/\{sending \? 'Sending…' : 'Send'\}/.test(chat))
check('and still says "Send" to a screen reader',
  /aria-label=\{sending \? 'Sending' : 'Send'\}/.test(chat))
check('the row\u2019s dots stand up, like the profile\u2019s',
  /<PopMenu\n\s+vertical/.test(card) || /<PopMenu vertical/.test(card))

check('the activity filter talks about being active, not about confirming',
  /label: 'Active this month'/.test(filterSource)
  && !/Not confirmed/.test(filterSource),
  'answering the monthly email is one of two things that counts — signing in is the other')

check('who revealed them fits one line',
  /\.candidate-revealed-by\{[^}]*white-space:nowrap/.test(css))
check('and reads "me" when it was the reader',
  /data\.revealedBy\.recruiterId === meId \? 'me' : data\.revealedBy\.name/.test(dialog))

check('the score page no longer repeats the CV\u2019s skill list',
  !/Skills found in CV/.test(reading) && !/function SkillBlock/.test(panel),
  'it is the CV\u2019s own words, and the profile tab already carries them')

section('A note your team leaves on a candidate')
check('the comment button sits beside the actions, on the row and in the profile',
  /<CommentsPopover/.test(card) && /<CommentsPopover/.test(dialog))
check('the panel is portalled, so neither the list nor a dialog can clip it',
  /createPortal\(/.test(comments) && /\.comments-panel\{[^}]*z-index:90/.test(css))
check('a + opens the writing box, and a paper plane posts it',
  /aria-label=\{writing \? 'Cancel this comment' : 'Write a comment'\}/.test(comments)
  && /className="icon-button comments-send"/.test(comments))
check('each note carries who wrote it, and when to the minute',
  /dateStyle: 'medium', timeStyle: 'short'/.test(comments)
  && /comment\.recruiterId === meId \? 'me' : comment\.author/.test(comments))
check('the panel does not close when you click into your own draft',
  /NOT by any click elsewhere/.test(comments),
  'a panel that vanishes on a click inside it is a panel you cannot type in')
check('and its scroll listener is removable',
  /window\.addEventListener\('scroll', close, true\)/.test(comments)
  && /window\.removeEventListener\('scroll', close, true\)/.test(comments)
  && !/addEventListener\('scroll', \(\) =>/.test(comments),
  'an inline arrow removes nothing and leaks a listener that closes the panel on every scroll')
check('notes are read against the company, never against one recruiter',
  /WHERE c\.company_id = \? AND c\.candidate_id = \?/.test(read('../server/src/workspace.js')))
check('and the author\u2019s name is joined at read time, not copied at write time',
  /LEFT JOIN recruiters r ON r\.id = c\.recruiter_id/.test(read('../server/src/workspace.js')),
  'a recruiter who changes their surname should not leave notes signed with the old one')

section('A surname is shown once it is paid for, and never before')
/*
 * Four states, one rule: display_name IS the rule. The server masks it to a
 * first name until the reveal and swaps in the full one after, so anything that
 * reads a different field is a second path to the same answer — and one that
 * would print a surname the moment something else put that field in the
 * payload.
 */
check('the row reads display_name and nothing else',
  /<span className="result-name">\{candidate\.display_name\}<\/span>/.test(card))
check('and so does the profile',
  /<span className="result-name">[\s\S]{0,80}candidate \? candidate\.display_name : 'Loading…'/.test(dialog)
  && !/candidate\.name \?\? candidate\.display_name/.test(dialog))
check('which the server masks until the reveal',
  read('../server/src/schema.js').includes('view.display_name = maskedDisplayName(candidate.first_name)')
  && read('../server/src/schema.js').includes('if (full) view.display_name = full'))

section('What your team calls a candidate')
const tagSource = read('../client/src/components/CandidateTags.jsx')

check('the + stands beside the comments, on the row and in the profile',
  /<TagEditor/.test(card) && /<TagEditor/.test(dialog))
/* The strip moved down with the balancing column that used to hold it: it is
   among the chips under the summary, which is where the other things this team
   said about this candidate already are. */
check('the tag strip is among the chips under the summary',
  /<div className="result-tags">[\s\S]{0,400}<TagStrip/.test(card)
  && /className="modal-menu"[\s\S]{0,260}<TagStrip/.test(dialog))
check('and disappears entirely when there is nothing to say',
  /if \(!tags \|\| tags\.length === 0\) return null/.test(tagSource),
  'an empty box is furniture')
check('the row keeps one line however many tags there are',
  /\.tag-strip\{[^}]*flex-wrap:nowrap/.test(css)
  && /export function TagStrip\(\{ tags, limit = 1 \}\)/.test(tagSource),
  'a row whose height depends on how much somebody has annotated it is a list that jumps about')
check('what is held back is counted, not dropped',
  /\+\{rest\.length\}/.test(tagSource) && /title=\{rest\.map\(/.test(tagSource))

check('reading is the default and editing is a pencil away',
  /aria-label=\{editing \? 'Save these tags' : 'Edit these tags'\}/.test(tagSource),
  'crosses that are always live get pressed by accident on a list you are scrolling')
check('the crosses only exist while editing',
  /\{editing && \([\s\S]{0,200}className="chip-x"/.test(tagSource))
check('nothing is written until the tick',
  /onClick=\{\(\) => \(editing \? save\(\) : setEditing\(true\)\)\}/.test(tagSource))
check('the tags are solid and dark enough to carry white text',
  /\.tag\{[^}]*color:#fff/.test(css)
  && /\.tag-green\{background-color:#2b6b4a\}/.test(css)
  && !/\.tag-green\{background:#eaf4ee/.test(css),
  'a pale tint read as a disabled chip beside the ones this product already uses')
check('and lit from the top rather than flat',
  /\.tag\{[^}]*linear-gradient\(180deg,#ffffff2e/.test(css) || /\.tag\{[^}]*linear-gradient/.test(css))
check('the colour is picked from a fixed set, not typed',
  /const COLOURS = \['grey', 'red', 'amber', 'green', 'blue', 'purple'\]/.test(tagSource)
  && /TAG_COLOURS = \['grey', 'red', 'amber', 'green', 'blue', 'purple'\]/.test(read('../server/src/workspace.js')))
check('grey is the default', /useState\('grey'\)/.test(tagSource))
check('and five is the cap, said in the panel rather than found by refusal',
  /\{MAX\} is the maximum\./.test(tagSource) && /const MAX = 5/.test(tagSource))

check('the panel is portalled above whatever opened it',
  /createPortal\(/.test(tagSource) && /\.tag-panel\{[^}]*z-index:90/.test(css))
check('and its scroll listener is removable, like the comments panel\u2019s',
  /window\.addEventListener\('scroll', close, true\)/.test(tagSource)
  && /window\.removeEventListener\('scroll', close, true\)/.test(tagSource)
  && !/addEventListener\('scroll', \(\) =>/.test(tagSource))
check('the whole set is replaced in one transaction',
  /export const setTags = db\.transaction/.test(read('../server/src/workspace.js')),
  'a save that half-applied would be a set nobody chose')
check('and a page of results brings its tags with it',
  /export function tagIndex/.test(read('../server/src/workspace.js'))
  && /tags: context\.tags\?\.get\(candidate\.id\) \?\? \[\]/.test(read('../server/src/index.js')))

section('Narrowing a list by what your team called somebody')
/*
 * The rule itself is arithmetic over rows, so it is run rather than grepped.
 * Both screens that narrow candidates share it — a folder is narrowed by the
 * same questions a result list is — so proving it once proves it for both.
 */
const { applyResultFilters, EMPTY_RESULT_FILTERS } = await import('../client/src/components/resultFilters.js')

const row = (name, tags) => ({
  candidate: { display_name: name, availability: '', capacity: '' },
  tags, documents: [], score: 50,
})
const people = [
  row('Dana', [{ label: 'Phone screened', colour: 'green' }]),
  row('Omer', [{ label: 'Wants remote', colour: 'blue' }, { label: 'Phone screened', colour: 'green' }]),
  row('Noa', []),
]
const narrowed = (tag) => applyResultFilters(people, { ...EMPTY_RESULT_FILTERS, tag })
  .map((r) => r.candidate.display_name)

check('a tag keeps only the people wearing it',
  narrowed('Phone screened').join(',') === 'Dana,Omer')
check('and one of several tags still counts',
  narrowed('Wants remote').join(',') === 'Omer')
check('untagged people fall out',
  !narrowed('Phone screened').includes('Noa'))
check('the match ignores case, because the tag is somebody\u2019s typing',
  narrowed('phone SCREENED').join(',') === 'Dana,Omer')
check('and no tag set changes nothing',
  applyResultFilters(people, EMPTY_RESULT_FILTERS).length === 3)

const filterBar = read('../client/src/components/ResultFilters.jsx')
check('the control lists the tags with a search over them',
  /placeholder="Search tags"/.test(filterBar) && /options\.filter\(\(tag\) => tag\.label\.toLowerCase\(\)\.includes\(needle\)\)/.test(filterBar))
check('and offers only the tags the rows on screen are wearing',
  /function tagsIn\(rows\)/.test(panel)
  && /const tagOptions = tagsIn\(response\?\.results\)/.test(panel)
  && /const folderTagOptions = tagsIn\(opened\?\.items\)/.test(panel),
  'a filter that can return nothing is a filter that wastes a press')
check('so it hides itself when nobody is tagged',
  /if \(options\.length === 0\) return null/.test(filterBar))
check('both screens that narrow candidates get it',
  /tags=\{tagOptions\}/.test(panel) && /tags=\{folderTagOptions\}/.test(panel))

check('a tag written on a row reaches the list it is in',
  /onTagsChanged\?\.\(candidate\.id, next\)/.test(panel)
  && /function tagsChanged\(candidateId, next\)/.test(panel),
  'otherwise the filter cannot offer a tag until the next search')
check('the folder row draws the strip too',
  /<span className="drive-item-tags">[\s\S]{0,700}<TagStrip tags=\{item\.tags\}/.test(panel))
check('and wears no badge its twin in the search does not',
  !/includes\('cover_letter'\)[\s\S]{0,120}Cover letter/.test(panel),
  'a chip reporting what is attached is a detail of the profile, not a reason '
  + 'to open somebody')
check('the two rows lead with the same two facts',
  /\[item\.location, item\.availability\]\.filter\(Boolean\)/.test(panel)
  && !/\[item\.location, item\.availability, item\.capacity\]/.test(panel),
  'capacity appeared in the folder and nowhere else, which made one person '
  + 'look like two records')
check('and neither prints the summary',
  !panel.includes('drive-item-summary') && !panel.includes('<SummaryPreview'),
  'twenty rows of self-description is a page of prose with the names as the '
  + 'small text')
check('and the folder query carries them, one read for the whole folder',
  /tags: tags\.get\(item\.candidate_id\) \?\? \[\]/.test(read('../server/src/workspace.js')))


section('Balances are not on screen while the product works')

/*
 * The rule these check: a recruiter should not spend the working day watching a
 * meter go down. Reveals and Triage capacity are bought and then forgotten
 * about; what a person needs is the cost of the thing in front of them, and one
 * banner when something has actually stopped.
 *
 * triageTab is already read further up the file.
 */

/* The rendered form, not the words: the comment left where the line used to be
   quotes the old string, and a check that cannot tell prose from markup would
   fail on the note explaining itself. */
check('the Triage list shows no capacity figure',
  !/<strong>\{(remaining|balance)\}<\/strong>/.test(triageTab),
  'it read "137 CVs of capacity left" above the list and again in the builder')
check('and neither does the builder',
  (triageTab.match(/triage-capacity/g) ?? []).length === 0)
check('the stylesheet no longer carries rules for one',
  !css.includes('.triage-capacity{'))

check('there is no reveal-balance chip either',
  !panel.includes('function RevealBalance'),
  'a component whose whole job was the counter this rule removes')
check('and nothing renders one', !panel.includes('<RevealBalance'))

/* The figures still exist where they are managed - that is the whole point of
   removing them from everywhere else. */
check('Billing still says what the organization holds',
  (panel.match(/billing-balance-line/g) ?? []).length >= 2,
  'reveals and Triage each state their balance on the screen for buying more')

section('Warnings arrive at zero, and only at zero')

const balanceBanner = (panel.split('function BalanceBanner')[1] ?? '').split('\nfunction ')[0]
const triageBanner = (triageTab.split('function TriageBalance')[1] ?? '').split('\nfunction ')[0]

check('the reveal banner tests for zero, not for low',
  /wallet\.balance === 0/.test(balanceBanner) && !/lowBalance/.test(balanceBanner))
check('and says so in as many words at the end', /return null/.test(balanceBanner))
check('the Triage banner is silent above zero',
  /balance > 0 \|\| !show/.test(triageBanner))

section('One banner pattern, three products')

for (const [what, source] of [
  ['reveals', balanceBanner],
  ['Triage', triageBanner],
  ['seats', (panel.split('function SeatPlanBanner')[1] ?? '').split('\nfunction ')[0]],
]) {
  check(`the ${what} banner is a Notice with a cross`,
    /<Notice[\s\S]{0,200}onDismiss=\{dismiss\}/.test(source))
  check(`and remembers the dismissal against the fact`,
    /useStandingNotice\(\s*['`]/.test(source),
    'a plain key plus the fact, or a key that genuinely varies - see the hook')
}

/* Dismissed for the session, and only for the session. */
const notice = read('../client/src/components/Notice.jsx')
const api = read('../client/src/api.js')
check('dismissals live in sessionStorage', notice.includes('sessionStorage'))
check('and signing out forgets them',
  notice.includes('export function clearStandingNotices') && api.includes('clearStandingNotices()'),
  'signing out is a state change, not a page load - sessionStorage outlives it on its own')

section('Every warning names its product and lands on it')

check('the reveal banner offers to add reveals', balanceBanner.includes('Add reveals'))
check('the Triage banner offers to add Triage capacity',
  triageBanner.includes('Add Triage capacity'))
check('the seat banner offers to manage seats', panel.includes('Manage seats'))

check('and Billing can be opened on a named product',
  /const openBilling = useCallback\(\(product = 'reveals'\)/.test(panel)
  && /<BillingTab product=\{billingProduct\}/.test(panel))
for (const [what, product] of [
  ['reveals', "openBilling('reveals')"],
  ['seats', "openBilling('seats')"],
  ['Triage', "openBilling('triage')"],
]) {
  check(`the ${what} CTA asks for ${what}`, panel.includes(product))
}
/* Once, inside openBilling. Every caller goes through that, so every caller
   has to name a product — which is the property worth holding. */
check('nothing opens Billing without saying which product',
  (panel.match(/setDialog\('billing'\)/g) ?? []).length === 1
  && /openBilling = useCallback\([\s\S]{0,120}setDialog\('billing'\)/.test(panel),
  'that was how a Triage warning landed a recruiter on Reveals')

/* triageTab is already read at the top of the Triage section above. */
const triageRail = read('../client/src/components/TriageRail.jsx')
const railModule = read('../client/src/rail.js')

section('The card shows the person, not their prose')

/*
 * The summary left the result card and stayed on the profile.
 *
 * Two sentences of self-description read well on one card and badly on twenty:
 * every row grew to the height of its longest one, so a list being scanned for
 * a name became a page of prose with the names as the small text. The check
 * that matters is not that it was removed but that it was not LOST — take it
 * off the card without confirming both profile states still draw it and the
 * summary is gone from the product.
 */
check('the result card does not print the summary',
  !/<SummaryPreview summary=\{candidate\.summary\} \/>/.test(panel),
  'SummaryPreview on the card was one line; the profile keeps ProfessionalSummary')
check('but the unrevealed profile still does',
  (panel.match(/<ProfessionalSummary summary=\{candidate\.summary\} \/>/g) ?? []).length === 2,
  'once before the reveal and once after — removing the card copy must not touch these')

check('the score ends flush right, under the ⋮',
  /\.result-side \{[^}]*align-items: flex-end/.test(css.replace(/\s+/g, ' '))
  || /\.result-side\{[^}]*align-items:flex-end/.test(css),
  'centred, it hung under the middle of a strip whose width changes per row')

check('and the folder chip no longer opts out of the strip alignment',
  !/\.chip-folder \{[^}]*align-self/.test(css) && !/\.chip-folder\{[^}]*align-self/.test(css),
  'align-self: flex-start dated from when it sat in a column; beside the '
  + 'revealed chip it rode about two pixels high')

section('One rail, two lists')

/*
 * Triage stopped being a destination and became the other half of a switch.
 *
 * It is not a place you visit — it is a thing you made and come back to,
 * exactly like a search. Two nav entries with a list of searches underneath
 * said the two were different kinds of object. They are not; what differs is
 * whose they are, and that is what the switch has to say out loud.
 */
check('the rail has one nav destination now',
  !/className=\{tab === 'triage' \? 'ws-nav-item/.test(panel),
  'Triage moved to the switch over the history list')
check('and the switch offers both lists',
  /className="rail-toggle ws-rail-heading"/.test(panel)
  && /aria-pressed=\{railList === 'searches'\}/.test(panel)
  && /aria-pressed=\{railList === 'triage'\}/.test(panel))
check('it keeps the heading class, so both words are set as the heading was',
  /rail-toggle ws-rail-heading/.test(panel),
  'the 2px optical nudge that aligns the S of SEARCHES with the Y of YESTERDAY')

check('and it says whose list you are looking at',
  panel.includes('Only you can see these.') && panel.includes('Shared with your whole team.'),
  'a search is private to whoever ran it; a Triage belongs to the company — '
  + 'hiding that would be a poor trick to play on somebody who just switched')

check('the Triage rows are bucketed on when they were created',
  triageRail.includes('(triage) => triage.createdAt'),
  'updated_at is written three times per 25-CV tranche by the background '
  + "worker, so a colleague's run would climb your rail while it processed")
check('and railSlice can be told which timestamp to read',
  /export function railSlice\(items, stampOf = \(item\) => item\.updated_at\)/.test(railModule),
  'defaulting to updated_at keeps every existing caller correct')

check('a rail row opens that Triage, not the dashboard',
  /onOpen=\{\(id\) => \{ setTab\('triage'\); setTriageOpens\(\{ at: Date\.now\(\), id \}\) \}\}/.test(panel),
  'the tab first, then the instruction — an id means nothing until the tab is showing')
check('and the Triage tab acts on it',
  /const \[open, setOpen\] = useState\(opens \? \{ id: opens\.id \} : null\)/.test(triageTab)
  && /if \(opens\) setOpen\(\{ id: opens\.id \}\)/.test(triageTab))
check('keyed on the timestamp, so pressing the same row twice works',
  /\}, \[opens\?\.at\]\)/.test(triageTab),
  'the same id twice is the same value, and an effect on it would not fire')

check('a colleague\'s Triage says whose it is',
  triageRail.includes('triage.recruiterId !== meId')
  && triageRail.includes("triage.author ?? 'A colleague'"),
  'silent for your own — a list where every row says "you" says nothing')

section('Counts mean what they say')

/*
 * The Triage number is gone from the rail.
 *
 * It was a pill on a nav destination, where a number says "this is how much is
 * behind this door", and it carried the CV capacity balance before it carried
 * the workspace count — a recruiter with one Triage and 100 CVs of capacity
 * read "Triage 100". Triage is now one half of a switch, and the list it
 * switches to is the count. What survives from those two checks is the half
 * that still matters: whatever the rail says about Triage, it is never the
 * balance.
 */
check('the rail shows no Triage count at all',
  !/Triage<span className="ws-nav-count">/.test(panel)
  && !/rail-toggle-on[\s\S]{0,400}ws-nav-count/.test(panel),
  'a zero beside a switch reads as something being wrong, not as an empty list')
check('and never the CV capacity balance',
  !/\{wallet\.triage\.balance\}/.test(panel))
check('while Folders still counts folders', panel.includes('{folders.length}'))

section('The two lists are managed the same way')

for (const [name, source, noun] of [
  ['Folders', panel, 'folders'],
  ['Triage', triageTab, 'Triages'],
]) {
  check(`${name} has a search box that is always there`,
    source.includes(`placeholder="Search ${noun}"`) && source.includes('type="search"'))
  check(`${name} searches as you type`,
    new RegExp(`onChange=\\{\\(event\\) => setQuery\\(event\\.target\\.value\\)\\}`).test(source),
    'no Enter, no button, no form')
  check(`${name} sorts by date both ways`,
    source.includes("'Newest first'") && source.includes("'Oldest first'"))
  check(`${name} sorts by size both ways`,
    /\['size'/.test(source) && /\['smallest'/.test(source))
  check(`${name} says so when nothing matched`, source.includes('folder-search-empty'))
  check(`and offers a way back`, source.includes('>\n                Clear\n              </button>')
    || /Clear\s*<\/button>/.test(source))
}

check('only Triage has a status filter, because only Triage has statuses',
  triageTab.includes('TRIAGE_STATUSES') && !panel.includes('TRIAGE_STATUSES'))
check('and it offers the statuses the column can actually hold',
  ['draft', 'processing', 'ready', 'completed', 'failed']
    .every((state) => triageTab.includes(`['${state}',`)),
  'a filter offering a state the database cannot hold returns nothing, always')
check('search and status narrow the same list in one pass',
  /if \(status !== 'all' && t\.status !== status\) return false/.test(triageTab)
  && /return \(t\.title \|\| 'Untitled Triage'\)\.toLowerCase\(\)\.includes\(wanted\)/.test(triageTab),
  'so neither control can quietly override the other')
check('a filter that is hiding rows looks different from one that is not',
  triageTab.includes('list-sort-toggle-on') && css.includes('.list-sort-toggle-on{'))

section('The workspace serves')
check('/hr is served', (await fetch(`${BASE}/hr`)).status === 200)
const health = await json(await fetch(`${BASE}/api/health`))
check('the API is up behind it', health.ok === true)

finish()
