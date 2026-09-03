/**
 * The candidate's account page.
 *
 * One page rather than three tabs, a masthead rather than a row, the two ways
 * out of the marketplace in one box, and messaging docked in the corner instead
 * of somewhere you navigate to.
 *
 * Structural assertions against the source and the built CSS; layout is
 * measured in a browser elsewhere. The point of most of these is that the
 * arrangement is deliberate — several of them would pass just as happily if the
 * page were still three tabs, so each one names the thing that must not come
 * back rather than only the thing that is now there.
 */
import fs from 'node:fs'

import { BASE, createReporter, json } from './helpers.mjs'

const { check, section, finish } = createReporter()

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const dist = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
const css = read(`../client/dist/assets/${dist.find((f) => f.startsWith('index-') && f.endsWith('.css'))}`)

const portal = read('../client/src/pages/CandidatePortal.jsx')
const bar = read('../client/src/components/PortalBar.jsx')
const form = read('../client/src/components/CandidateForm.jsx')

section('The bar meets the top of the window')
/* The bar is the first child of .portal, so the container's top padding left a
   band of page tint above it — which read as the bar having come loose from the
   window rather than being its edge. */
check('the portal reserves no space above its bar',
  /\.portal,\.workspace-shell\{[^}]*padding-top:0/.test(css),
  'the bar carries its own margin-bottom, so the content below keeps its spacing')
check('the bar is still sticky to the top', /\.portal-bar\{[^}]*top:0/.test(css))

check('no workspace label sits beside the wordmark',
  /<PortalBar\s+onSignOut/.test(portal) && !/<PortalBar[^>]*label=/.test(portal),
  'a candidate has one screen here; naming it said nothing')
/* The label is still supported — the recruiter workspace has several areas and
   uses it. Only the candidate stopped passing one. */
check('but PortalBar can still take one for the recruiter side', bar.includes('label &&'))

check('sign out sits nearer the window edge than the content column',
  /\.portal-bar-actions\{[^}]*margin-right:-/.test(css),
  'it eats part of the bar padding, so the wordmark stays aligned and only the control moves')
/*
 * And the bar's row spans the bar rather than the reading column. The pull is
 * measured against .portal-bar's padding, which is all it can eat; while the row
 * was also capped at 1360px and centred, a second gutter sat outside that
 * padding and the button stopped ~33px short of the corner no matter how hard it
 * was pulled. Removing the cap is what lets the pull reach the window.
 */
check('because the bar row spans the bar, not the reading column',
  /\.portal \.portal-bar-inner\{[^}]*max-width:none/.test(css))
check('and the pull still shrinks on a phone',
  /\.portal-bar-actions\{margin-right:-0?\.65rem\}/.test(css),
  'no .portal override may outrank the narrow-screen rule, or the button hangs off the edge')

section('There is no masthead')
/*
 * The photo, name, email and phone had a band of their own across the top —
 * four facts the reader supplied, above the form where all four are editable.
 * The photo moved into the form, over the CV box, where it is a control rather
 * than a portrait; the other three were only ever a readout of the fields
 * directly beneath them.
 */
check('the identity band is gone', !portal.includes('portal-head'))
check('and its stacked lines with it', !portal.includes('portal-identity-lines'))
/* Below the CV box, not above it: the CV is what the form is for and the only
   required upload, so it leads. A large empty circle above a required field
   read as the field you had not filled in. */
check('the photo sits below the CV box',
  form.indexOf('photo-under-cv') > form.indexOf("<label className=\"field-label\">CV"),
  'and only once — it used to be here and in the masthead')
/* Left and at the ordinary size, matching the company sign-up: the same
   picture asked for in the same kind of form. It was centred and half again as
   large, which made an optional field the biggest thing on the page. */
check('left-aligned under it', /\.photo-under-cv\{[^}]*justify-content:flex-start/.test(css))
/*
 * And above it on the account page, which asks for the picture first: there the
 * CV is already on file and the portrait is what the person came to see, while
 * on the application the CV is the only required upload and has to lead.
 */
check('and above it on the account page', form.includes('photoFirst && ('))

/*
 * Two marks for an empty circle, chosen by what the circle can do.
 *
 * A plus is an instruction and belongs where a picture can be added right now:
 * the application form, the administrator sign-up, and a profile being edited —
 * including one whose picture was just removed and not yet saved, which is the
 * moment a candidate most needs to see the way to put another one back. A
 * silhouette is a statement and belongs where there is nothing to press.
 */
const uploader = read('../client/src/components/PhotoUploader.jsx')
check('an empty circle shows a plus where a picture can be added',
  /canAdd \? <AddPhotoIcon size=\{40\} \/> : <PersonIcon size=\{44\} \/>/.test(uploader))
/* The noun is a prop now: the same control frames a company logo on the
   recruiter sign-up, and "Add a profile picture" is the wrong thing to say
   about one — the shape is the only other cue, and a screen reader has none. */
check('and the accessible name says the same thing',
  /canAdd \? `Add a \$\{noun\}` : `No \$\{noun\}`/.test(uploader)
  && /noun = 'profile picture',/.test(uploader))
check('the portal follows its own lock',
  form.includes('canAdd={!locked}') && form.includes('disabled={submitting || locked}'),
  'a locked page is a profile being read: no Remove, no picker, and a silhouette')
check('while the application form is always a place to add one',
  /canAdd = true/.test(uploader),
  'every other use of this component is a control, so the plus is the default')
check('which is what the portal asks for', portal.includes('photoFirst'))
/* The large frame is the account masthead's alone — there the portrait is the
   subject of the page, not one field among twenty. */
check('and large only on the account page',
  /\.photo-lead \.avatar\{[^}]*width:132px/.test(css)
  && !/\.photo-under-cv \.avatar\{[^}]*width:132px/.test(css))

section('View and profile are one page')
check('the tab strip is gone', !portal.includes('tabs tabs-inline'),
  'editing on one tab and checking the result on another is not two things')
check('and so is the tab state', !/const \[tab, setTab\]/.test(portal))
check('one region holds both', portal.includes('className="account-page"'))
check('the form is one half', portal.includes('className="account-main"'))
check('and how recruiters see you is the other', portal.includes('className="account-side"'))
check('two columns, not stacked', /\.account-page\{[^}]*grid-template-columns/.test(css))

/*
 * The reading column leads. It is the shorter of the two and the reason to open
 * the page; the form is where you go once you have read something you want to
 * change.
 */
/*
 * The form leads visually and the reading column follows.
 *
 * They were the other way round on the argument that the shorter column is the
 * reason to open the page; in use it is the opposite, because the form is what
 * somebody came to change and the left is where a form is expected.
 *
 * The source order is deliberately NOT flipped with it — the reading column
 * still comes first in the markup, so a screen reader and a narrow screen meet
 * the summary before the form. Only the grid placement swaps.
 */
check('the reading column still comes first in the source',
  portal.indexOf('className="account-side"') < portal.indexOf('className="account-main"'),
  'so a narrow screen stacks the summary above the form')
check('but the form is placed first in the grid',
  /\.account-page\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(280px/.test(css)
  && /\.account-main\{grid-column:1/.test(css))

/*
 * `.portal .panel` caps panels at 900px and outranks a bare `.account-page`
 * rule, so the two-column region was being squeezed into the width meant for
 * one.
 */
check('it is allowed to be wider than a single-column panel',
  /\.portal \.account-page\{max-width:1180px/.test(css))
/* Centred, not merely capped: `.portal` is a 1360px flex column, so a child
   capped at 1180 sat against its left edge and put all the slack on the right. */
check('and centred, so the two side margins match',
  /\.portal \.account-page\{[^}]*margin-inline:auto/.test(css))

/* The inner cards have to lose their own outlines or the merge is a box of
   boxes. `.stat` is the one that actually carried the border. */
check('the cards inside it do not draw their own outlines',
  /\.account-side \.stat\b/.test(css) || css.includes('.account-side .stat,'))
check('and the two halves are divided by a rule, not a second border',
  /\.account-side\{[^}]*border-left:1px solid/.test(css),
  'on the inner edge of the reading column, which now follows the form')

/* The account controls close that column rather than running the width of the
   page — they are things you read and decide about yourself, like the rest of
   it, not a footnote to the form. */
check('the account controls sit inside the reading column',
  /<aside className="account-side"[\s\S]*?<AccountSettings[\s\S]*?<\/aside>/.test(portal))
check('and no longer carry a width meant for a full-width block',
  !/\.account-settings\{[^}]*max-width:900px/.test(css))
/*
 * They are part of that column, not a card dropped into it. A white box inside
 * a column of plain text read as a separate widget, and its own padding pushed
 * the headings out of line with everything above them.
 */
check('they draw no card of their own',
  !/\.account-settings\{[^}]*background:var\(--surface\)/.test(css))
check('and are separated by a rule instead',
  /\.account-settings\{[^}]*border-top:1px solid/.test(css))

section('The reading column says only what the candidate can act on')
/*
 * The reveal count reads as a sentence rather than a dashboard tile: one fact
 * in a column of prose, where a display-sized numeral was the loudest thing on
 * the page. Plural throughout, since the number is inline and the sentence is a
 * count rather than a subject that has to agree with it.
 */
check('the count sits inside its sentence', portal.includes('className="stat-line"'))
check('and is no longer display-sized', /\.stat-line \.stat-value\{[^}]*font-size:1\.35rem/.test(css))
/*
 * The count is the number of companies that spent a Reveal on them, which is
 * the authoritative reveal record rather than a counter kept alongside it.
 */
check('the sentence names the reveal, not just the contact details',
  portal.includes('revealed your profile'))
check('and it still counts companies rather than recruiters',
  portal.includes('revealedCompanies'),
  'one recruiter at a firm revealing means the firm holds them')
/*
 * "clear / likely / possible" is how sure the extractor is — a fact about our
 * reading of the CV rather than about the candidate. Shown to the person
 * themselves it invites an argument they have no way to win.
 *
 * Note what this does NOT assert: that a recruiter sees it instead. This panel
 * has no recruiter-side twin — a recruiter gets skills and the match analysis,
 * not the taxonomy labels — so removing the tag here removes it from the
 * product. The label itself is still shown; only our confidence in it is not.
 */
check('the confidence tags are gone from the candidate view',
  !portal.includes('chip-note') && !portal.includes("'possible'"))
check('and the label itself still is', portal.includes('{label.label}'))
/* Same reasoning one step further: "about 2.7 years of defence" is our
   arithmetic on a CV the candidate wrote, presented back to them as fact. */
check('the extracted years are gone too', !portal.includes('Experience we read'))
check('and nothing is left computing them', !portal.includes('leadershipYears'))

section('The form asks one thing at a time')
/*
 * Relocation and openness were two Yes/No pairs a couple of centimetres apart —
 * the arrangement that gets one answered against the other's label. The second
 * also carries a line of explanation, so the row was lopsided as well.
 */
check('the two visibility questions stack rather than sharing a row',
  /\.preference-row\{[^}]*grid-template-columns:minmax\(0,1fr\)/.test(css))
/*
 * The heading follows the size. On the account page's masthead the circle is
 * large, centred and has Remove under it — it explains itself. On the
 * application form it is small, left and sits among labelled fields, where an
 * unlabelled control is the one nobody is sure they have answered.
 */
check('the masthead photo carries no heading', form.includes('label={null}'))
check('but the application form one does',
  !/photo-under-cv[\s\S]{0,400}label=\{null\}/.test(form),
  'the uploader labels itself unless told not to')
check('but the uploader can still take one',
  read('../client/src/components/PhotoUploader.jsx').includes("label = 'Profile picture'"))
check('and the circle keeps its own accessible name either way',
  read('../client/src/components/PhotoUploader.jsx').includes('aria-label={photoUrl'),
  'which is why the visible span was never a <label>')

section('Deactivate and delete sit together')
/*
 * They are the same decision at two strengths and were at opposite ends of the
 * page — the reversible one as a green banner by the masthead, the permanent
 * one below the form.
 */
check('one box holds both', portal.includes('function AccountSettings'))
check('deactivate comes first, being the reversible one',
  portal.indexOf('confirmedOnly') < portal.indexOf('<DangerZone'))
check('and the delete block no longer trails the edit form',
  !/<\/CandidateForm>\s*<DangerZone/.test(portal.replace(/\s+/g, ' ')))
/*
 * Both are built the same way now — heading, prose, one button — so the
 * reversible decision no longer looks like an announcement sitting beside a
 * decision. The headings still name the thing; the buttons are just the verb.
 */
check('both are the same kind of block',
  (portal.match(/<section className="account-action">/g) ?? []).length === 2)
check('the deactivate button says only Deactivate',
  />\s*Deactivate\s*<\/button>/.test(portal))
check('and the delete one says only Delete',
  />\s*Delete\s*<\/button>/.test(portal))
/* The heading names the thing; the button is the verb. A button repeating its
   own heading is the section title said twice. */
check('neither repeats its heading in its own label',
  !/>\s*Deactivate profile\s*<\/button>/.test(portal)
  && !/>\s*Delete profile\s*<\/button>/.test(portal))

/*
 * Only the states that need answering stay at the top. Deactivated and
 * unconfirmed are questions; confirmed is a status line plus a control, which
 * belongs with the account controls.
 */
check('the banner splits by state rather than being copied',
  portal.includes('urgentOnly') && portal.includes('confirmedOnly'))
check('urgent states still sit above the fold',
  /<ActivityBanner[^>]*urgentOnly/.test(portal))
check('and there is still only one copy of the state machine',
  (portal.match(/function ActivityBanner/g) ?? []).length === 1)

section('The page is a page, not a card')
check('the account page draws no panel of its own',
  /\.portal \.account-page\{[^}]*background:none/.test(css))
check('and keeps a margin at the sides',
  /\.portal \.account-page\{[^}]*padding:0 clamp/.test(css))
check('the form heading and its blurb are gone',
  !portal.includes('This is the same form you filled in'))
/* The tinted fill made the dropzone read as a field already holding a value,
   when it is the one control that is empty until you act. */
check('the CV dropzone is white', /\.dropzone\{[^}]*background:var\(--surface\)/.test(css))
check('and the CV on file is a link, not just a name',
  form.includes("href={withToken('/api/candidate/me/documents/cv', 'candidate')}"),
  'the filename alone answered nothing — you chose it months ago')

section('Messaging is docked, not a destination')
check('the dock exists', portal.includes('function MessagingDock'))
check('and the messages tab does not', !portal.includes('function MessagesTab'))
check('it is fixed to the bottom right',
  /\.dock\{[^}]*position:fixed/.test(css) && /\.dock\{[^}]*bottom:0/.test(css))
/* Only the panels take clicks; the empty rail beside them must not swallow
   presses meant for the page underneath. */
check('the empty rail does not eat clicks',
  /\.dock\{[^}]*pointer-events:none/.test(css) && /\.dock>\*\{pointer-events:auto\}/.test(css))
check('a collapsed bar, a list, and windows beside it',
  portal.includes('dock-panel') && portal.includes('dock-list') && portal.includes('ChatWindow'))
/* Each window loads its own thread: two can be open, and a single thread held
   in the parent would mean the second overwrote the first. */
check('each window owns its thread', /function ChatWindow[\s\S]{0,900}useState\(null\)/.test(portal))
check('opening a third closes the oldest rather than doing nothing',
  portal.includes('MAX_OPEN_WINDOWS') && portal.includes('.slice(-MAX_OPEN_WINDOWS)'))
/* Minimised windows stay mounted so polling continues — a reply is already
   there when the window is opened again. */
check('minimising keeps the window mounted', /\.chat-window-min\{height:auto\}/.test(css))
check('the list polls even with nothing open',
  /setInterval\([\s\S]{0,200}loadThreads/.test(portal),
  'otherwise the unread badge only ever updated while you were already reading')
check('a conversation covers the list on a phone',
  css.includes('.dock:has(.chat-window) .dock-panel{display:none}'))

/* Each row says when it last moved and offers the two things you do to a
   conversation you are not reading. */
check('each row carries the date of its last message', portal.includes('dock-when'))
check('shortened, because a list is scanned rather than read',
  portal.includes('function shortWhen'))
check('and a menu beside it', portal.includes('<ConversationActions'))

/*
 * The menu renders through a portal to document.body.
 *
 * The dock's panel and its chat windows both set `overflow: hidden` so their
 * own contents scroll, and an absolutely positioned child cannot escape a
 * clipping ancestor — a menu opened from a collapsed conversation was rendered
 * and invisible. It also opens upward when there is no room below, which at the
 * bottom of the window is most of the time.
 */
const popMenu = read('../client/src/components/PopMenu.jsx')
check('the menu escapes the containers that clip it',
  popMenu.includes('createPortal') && popMenu.includes('document.body'))
check('and flips above the button when there is no room below',
  popMenu.includes('const above = roomBelow < height + GAP'))
/*
 * Moving it to the body is only half the job — the anchored variant's offsets
 * come with it, and both did real damage:
 *
 * `right: 0` survived, and a fixed box with a `left` set inline as well resolves
 * to a width spanning the two, so the 190px menu covered the window. `z-index: 5`
 * was scoped to the row it used to live in; as a sibling of the dock (40) it drew
 * behind the panel. Together: a very large box, behind the window.
 */
check('the portalled menu releases the anchored variant\'s right edge',
  /\.dock-menu-floating\{[^}]*right:auto/.test(css),
  'otherwise left + right resolve to a box the width of the window')
/*
 * It used to be pinned at 45 — above the dock at 40, below a dialog at 50 — so
 * that a menu could never be drawn over a modal. That reasoning has been
 * overtaken: the same component is now opened from INSIDE the candidate
 * profile, where sitting under the dialog meant every click on the menu landed
 * on the dialog instead and Reveal silently did nothing.
 *
 * Nothing is lost by raising it. The menu closes on any document click, on
 * Escape, on scroll and on resize — and opening a dialog takes a click — so
 * there is no state in which a stale menu floats over a dialog it does not
 * belong to.
 */
check('and sits above the dock it belongs to, and above any dialog it is opened from',
  /\.dock-menu-floating\{[^}]*z-index:90/.test(css) && /\.dock\{[^}]*z-index:40/.test(css),
  'under the modal backdrop at 50, a menu opened from a dialog is unclickable')
check('its width comes from its items',
  /\.dock-menu-floating\{[^}]*width:max-content/.test(css))

/*
 * Both tables of per-party conversation state go when an account does.
 *
 * They are keyed by the candidate/recruiter pair rather than by a message, so
 * deleting someone's messages does not take them along — the rows outlive the
 * conversation they describe and point at an account that no longer exists.
 * conversation_hidden had been leaking this way since it was added; the unread
 * mark would have joined it.
 */
const profiles = read('../server/src/profiles.js')
const accounts = read('../server/src/accounts.js')
for (const [file, source, key] of [
  ['deleting a candidate', profiles, 'candidate_id'],
  ['deleting a recruiter', accounts, 'recruiter_id'],
]) {
  for (const table of ['conversation_hidden', 'conversation_unread']) {
    check(`${file} clears ${table}`,
      new RegExp(`DELETE FROM ${table} WHERE ${key} = \\?`).test(source),
      'keyed by the pair, so removing the messages does not remove this')
  }
}

/* A reset link is a live credential, so it must not outlive the account it
   opens — the same rule, for the same reason, as the conversation rows above. */
check('deleting a recruiter clears any outstanding reset link',
  /DELETE FROM recruiter_password_resets WHERE recruiter_id = \?/.test(accounts))

/* A candidate's corrections to their own categorisation are keyed by candidate,
   not by profile version — that is what lets an edit survive a re-read of the
   CV — so deleting their profile rows does not reach them. */
check('deleting a candidate clears their label edits',
  /DELETE FROM candidate_label_overrides WHERE candidate_id = \?/.test(profiles))

/*
 * The profile is read until the pencil is pressed, and the lock is a disabled
 * fieldset rather than `inert`.
 *
 * Both take every control out of reach in one place, which beats `disabled` on
 * each field — one forgotten prop is a hole. But `inert` is recent, React 18
 * has no first-class support for it, and older browsers ignore it outright, so
 * whether the lock held depended on the reader's browser. A disabled fieldset
 * is as old as forms.
 */
check('the account form locks with a disabled fieldset',
  /<fieldset className="form-fields" disabled=\{locked\}>/.test(form))
check('and not with inert, which not every browser honours',
  !/inert=/.test(form))
/* The payload is built from React state, so disabling the controls cannot
   empty it — the two facts have to stay true together. */
check('the payload is built from state, not scraped from the form',
  /const data = new FormData\(\)/.test(form) && !/new FormData\(event\.target\)/.test(form))
/*
 * "Editable" has to mean every field, including the two that carry a Verified
 * badge.
 *
 * VerifiedField locks a verified value by default, which is right at sign-up:
 * you proved an address a moment ago, and editing it afterwards would leave the
 * proof attached to a value it was never about. On the profile it is wrong —
 * the address is verified because it has been on the account for months, so the
 * lock made email and phone permanently read-only and the pencil appeared not
 * to work. The Verify button comes back on its own the moment the value differs
 * from what is stored.
 */
/*
 * The pencil is never a submit button.
 *
 * It used to become one the moment the form unlocked — type flipping to
 * "submit" and a `form` attribute appearing. React flushes a click's state
 * update synchronously, so by the time the browser ran that same click's
 * default action the button had already turned into a submit button pointing at
 * the form: one press unlocked the form and immediately submitted it, and
 * onSubmit locked it straight back. It looked completely dead.
 *
 * Only to a real pointer, though. `element.click()` runs its default action
 * before React re-renders, so every synthetic test pressed it in the one way
 * that could not fail — which is why this survived several rounds of "verified
 * working". Asking the form to submit itself removes the browser's second
 * action entirely.
 */
check('the edit pencil never submits by default action',
  /requestSubmit\(\)/.test(form) && !/type=\{locked \? 'button' : 'submit'\}/.test(form),
  'one press must do one thing')
check('and carries no form attribute to submit through',
  !/form=\{locked \? undefined : 'candidate-form'\}/.test(form))

check('the profile leaves its verified contacts typeable',
  (read('../client/src/components/CandidateForm.jsx').match(/lockWhenVerified=\{false\}/g) ?? []).length === 2)
check('and VerifiedField honours that rather than always locking',
  /readOnly=\{verified && lockWhenVerified\}/.test(read('../client/src/components/VerifiedField.jsx')))

check('the control that unlocks it sits outside the fieldset',
  form.indexOf('form-lock-bar') < form.indexOf('<fieldset className="form-fields"'),
  'a toggle inside the locked subtree cannot be pressed to unlock it')

check('it closes on scroll, so a stale position is never shown',
  popMenu.includes("window.addEventListener('scroll', close, true)"),
  'capture phase: the dock scrolls its own columns, and those do not bubble')
check('offering mark as unread', portal.includes('Mark as unread'))
check('and delete conversation', portal.includes('Delete conversation'))
/*
 * A <button> inside a <button> is invalid and browsers make the inner one
 * unclickable — which would be the menu. The row and the menu are siblings.
 */
/*
 * A <button> inside a <button> is invalid, and browsers resolve it by making
 * the inner one unclickable — which would be the menu.
 *
 * Checked inside ConversationRow rather than across the file: the menu is its
 * own component now and is defined further up, so an ordering test over the
 * whole source proves nothing about the nesting.
 */
const conversationRow = portal.slice(
  portal.indexOf('function ConversationRow'),
  portal.indexOf('function ConversationRow') + 1600,
)
/* Both indexes are required to exist. `indexOf` returns -1 when the closing tag
   is missing, and -1 sorts before everything — so a genuinely nested menu would
   have satisfied a bare `a < b`. */
const rowClose = conversationRow.indexOf('</button>')
const rowMenu = conversationRow.indexOf('<ConversationActions')
check('the menu is a sibling of the row button, not nested inside it',
  portal.includes('dock-row-wrap') && rowClose > 0 && rowMenu > 0 && rowClose < rowMenu)

/* One menu component, mounted on the list row and in the open window — so which
   actions you can reach does not depend on the conversation being open. */
check('the same menu serves the list and the window',
  (portal.match(/<ConversationActions/g) ?? []).length === 2
  && (portal.match(/function ConversationActions/g) ?? []).length === 1)

section('Nothing was left behind')
/* The candidate's old thread list and reading pane. The recruiter side never
   used them — it has ChatSidebar — so with the dock in place they were dead. */
for (const orphan of ['.thread-list{', '.thread-view{', '.thread-active{']) {
  check(`${orphan.replace('{', '')} is gone from the stylesheet`, !css.includes(orphan))
}
check('and the classes are gone from the source too',
  !portal.includes('thread-list') && !portal.includes('thread-view'))

section('The page serves')
check('/account is served', (await fetch(`${BASE}/account`)).status === 200)
const health = await json(await fetch(`${BASE}/api/health`))
check('the API is up behind it', health.ok === true)

section('A saved answer survives an edit')
/*
 * The bug this section exists for: a candidate answered "yes" to being open to
 * all opportunities, and found the question unanswered again every time they
 * opened their profile. The value was in the database throughout. The re-seed
 * effect called toFormState with one argument where the function takes two, so
 * the preferences half — which is where this answer lives, on its own table —
 * came back undefined and collapsed to null on every mount.
 */
check('the re-seed effect passes the preferences it is re-seeding from',
  /setForm\(toFormState\(candidate, preferences\)\)/.test(form),
  'toFormState(candidate) alone silently discards the saved yes/no')

check('and the initial seed still does too',
  /useState\(\(\) => toFormState\(candidate, preferences\)\)/.test(form))

/* Both intake answers start as a real answer rather than as no answer. */
check('open to all opportunities defaults to yes on a blank form',
  /openToAllOpportunities: true,/.test(form))
check('open to relocation defaults to yes on a blank form',
  /openToRelocation: 'yes',/.test(form))

/* ...and a stored profile is never handed the blank form's default. */
check('but a stored profile shows what is stored',
  form.includes('openToAllOpportunities: preferences?.openToAll ?? null'),
  'substituting true here would reopen somebody who had closed themselves off')

/*
 * The display rule. `false`, `0` and an empty string are three different
 * things, and only the last one means "not filled in".
 */
check('the hide-when-empty rule tests for absence, not falsiness',
  !/const shown = \(value\) => !locked \|\| Boolean\(value\)/.test(form)
  && /value !== '' && value !== null && value !== undefined/.test(form),
  'Boolean(false) is false, and a No is an answer')

/* And the form can say "I cleared this", which it could not before: skipping
   empty values made a cleared field indistinguishable from an untouched one. */
check('an emptied field is still sent',
  /for \(const \[key, value\] of Object\.entries\(rest\)\) data\.append\(key, value\)/.test(form),
  'skipping empties means a cleared Capacity can never be removed')

section('Hide my profile from these companies')
check('the section exists', portal.includes('Hide my profile from these companies'))
check('and sits directly below how you are categorised',
  portal.indexOf('<Categorisation') < portal.indexOf('<HiddenCompanies')
  && portal.indexOf('<HiddenCompanies') < portal.indexOf('<AccountSettings'))

/* The same furniture as the categorisation above it, so it reads as part of the
   page rather than as something bolted to the bottom of it. */
check('it reuses the categorisation section styling',
  /className="panel panel-narrow categorisation hidden-companies"/.test(portal))
check('and the same pencil-then-tick control',
  /<HiddenCompanies[\s\S]{0,80}\/>/.test(portal)
  && /aria-label=\{editing \? 'Finish editing hidden companies'/.test(portal))
check('and the same chips as the label rows', /className="chip chip-add"/.test(portal)
  && (portal.match(/className="chip-x"/g) ?? []).length === 2)

check('an empty list says so rather than showing nothing',
  portal.includes('No companies hidden'))
check('and the pencil is still there when the list is empty',
  /\{list\.length === 0 && !editing && <span className="muted">No companies hidden<\/span>\}/
    .test(portal),
  'the empty state is inside the chip row, not instead of the section')

/* No cap. Skills and industries have one because a profile with forty labels
   describes nobody; a person may genuinely not want to hear from forty firms. */
check('no per-list limit is shown to the candidate',
  !/MAX_HIDDEN|hiddenCap|\{MAX_LABELS\} is the maximum[\s\S]{0,400}hidden-companies/.test(portal))

section('Delete conversation says what it does')
/* It writes one row to conversation_hidden and touches no message: the other
   party keeps their copy and a later message brings the thread back. The
   behaviour is the considered one, so the label is what changed. */
check('the candidate menu no longer promises a delete',
  !portal.includes("label: 'Delete conversation'")
  && portal.includes("label: 'Remove from my inbox'"))

finish()
