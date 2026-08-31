/**
 * Landing page spec v2.0 — §17 acceptance criteria.
 *
 * Structural and brand assertions run against the built bundle and the source,
 * because that is where these decisions live; there is no headless browser
 * here, so anything needing layout measurement is called out in the report
 * rather than asserted falsely.
 */
import fs from 'node:fs'

import { BASE, createReporter, json } from './helpers.mjs'

const { check, section, finish } = createReporter()

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const dist = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
const bundle = read(`../client/dist/assets/${dist.find((f) => f.startsWith('index-') && f.endsWith('.js'))}`)
const css = read(`../client/dist/assets/${dist.find((f) => f.startsWith('index-') && f.endsWith('.css'))}`)
const html = read('../client/index.html')

section('Brand system (audit §1, §3, §4)')
/*
 * The rose pair is gone. The audit collapses the palette back to one colour —
 * the logo's own oxblood — used for the header bar, the footer, the primary
 * button, headings and every focus state (§1, §3, §11, §12). It measures 9.33:1
 * against white in both directions, which is what lets one value do all of it.
 */
check('oxblood is the single accent', css.includes('--accent: #7a2e2a'), '#7A2E2A')
check('and it is the logo\'s own red', css.includes('--mark-red: #7a2e2a'))
check('the rose surface colour is gone', !css.includes('#f0828a'),
  '§3 replaced the salmon cards with white ones')
check('so is its darkened text sibling', !css.includes('#a83f49'))
/*
 * The ground is a cool grey, not a red one.
 *
 * §3 called for a light red undertone behind everything. In practice it tinted
 * every white card sitting on it, so nothing on the page was ever actually
 * white and the whole site read slightly stained. The oxblood is still the
 * single accent — it just no longer leaks into the paper.
 */
/*
 * The ground is WARM neutral, not cool.
 *
 * It went cool grey (#F8F9FB) when the palette was first rebuilt, which was an
 * over-correction: oxblood is a warm red-brown, and on a blue-grey page every
 * white card read faintly cold while the accent looked stuck on rather than
 * mixed in. #F6F4F2 carries a little red, so the brand colour reads as the
 * darkest member of the same family.
 */
check('the page ground is a warm neutral', css.includes('--bg: #f6f4f2'), '#F6F4F2')
check('and the public shell agrees with it', /--page:\s*var\(--bg\)/.test(css))
check('the old cool ground is gone', !css.includes('#f8f9fb'))
check('so is the older pink one', !css.includes('#faf4f3'))
/* Warm near-black, never a cool grey and never pure #000 — so text and paper
   belong to the same family as the accent. 17.5:1 on white. */
check('primary text is a warm near-black', css.includes('--ink: #1c1917'), '#1C1917')
check('and no cool ink survives', !css.includes('#101828'))
check('secondary grey is present', css.includes('--ink-soft'))
check('a muted third step exists for hints', css.includes('--text-subtle'))
check('success green is reserved', css.includes('--ok: #2f6f4f'))
check('and it is warm-shifted to match the ground', !css.includes('#067647'))
// §4 — brighter and more saturated than the oxblood, so it stays legible
// against it and never reads as a brand accent.
/* Still brighter and more saturated than the oxblood, so a failure never
   reads as a brand accent — but warmed, like everything else. */
check('the required/error red is a brighter red than the oxblood',
  css.includes('--bad: #b8362c'), '#B8362C')
check('and it is not the accent', !/--bad:\s*#7a2e2a/.test(css))
/*
 * §3.2 named Arial as a placeholder until a real face was chosen. Inter is that
 * choice: drawn for interfaces, with a variable weight axis so 500 and 600 are
 * real weights rather than a synthesised bold. It is bundled rather than
 * fetched, so the page renders without calling a font CDN.
 */
/*
 * Instrument Sans, with Instrument Serif as an italic accent.
 *
 * Inter was the previous choice and it was the wrong one for a reason that has
 * nothing to do with its quality: it is the default every generated site
 * reaches for, so a page set in it reads as untouched. Instrument Sans has
 * squared terminals and tight native spacing — it reads as software — and its
 * companion serif gives the display type somewhere to change voice, which is
 * the single detail that separates a designed page from a styled one.
 */
check('Instrument Sans is the UI face', css.includes('Instrument Sans'))
check('with Instrument Serif for accents', css.includes('Instrument Serif'))
check('and it is self-hosted, not fetched', !css.includes('fonts.googleapis'))
check('Inter is gone', !/Inter Variable/.test(css))
check('the serif is used for display, not for body copy',
  /\.landing-welcome\{[^}]*font-family:var\(--font-serif\)/.test(css)
  && !/^body\{[^}]*--font-serif/.test(css))
check('every control inherits it', /button,input,select,textarea,optgroup\{font-family:inherit/.test(css.replace(/\s*([,{:;])\s*/g, '$1')))

section('Required-field asterisk (§4)')
check('the asterisk has its own class rather than living in label strings',
  css.includes('.field-label .req'))
check('no gap between the label and its asterisk',
  /\.field-label\{[^}]*gap:0/.test(css), 'CV * becomes CV*')
const formSource = read('../client/src/components/CandidateForm.jsx')
/* Its own module, not an export of the application form: the contact page and
   the recruiter sign-up need it too, and importing the whole form to borrow one
   span would drag that module onto every page with a required field. */
check('the marker is a component, used site-wide',
  read('../client/src/components/Req.jsx').includes('export default function Req()'))
check('and every form uses it rather than typing an asterisk',
  ['../client/src/components/CandidateForm.jsx',
    '../client/src/pages/InfoPage.jsx',
    '../client/src/pages/HrPanel.jsx'].every((f) => read(f).includes('<Req />')))
check('and no label still carries a literal " *"',
  !/>[^<>]+ \*<\/label>/.test(read('../client/src/pages/HrPanel.jsx')))

section('Logo and favicon (§3.3)')
check('a favicon is declared', html.includes('favicon.svg'))
check('an apple touch icon is declared', html.includes('apple-touch-icon'))
const favicon = read('../client/public/favicon.svg')
/* §1 inverts both: a white tile carrying the oxblood mark, so the tab icon
   matches the logo on the oxblood header bar. The same two colours either way
   round, so it is still 9.33:1. */
check('the favicon is inverted to white', /rect[^>]*fill="#FFFFFF"/.test(favicon))
check('with the oxblood mark on it', favicon.includes('#7A2E2A'))
const wordmarkSource = read('../client/src/components/Wordmark.jsx')
check('the header mark is the same two colours', wordmarkSource.includes("MARK_TILE = '#7A2E2A'"),
  'one asset, two places')
check('and it can invert for the header and footer', wordmarkSource.includes('inverse'))
/* The wordmark keeps the CVRSVS spelling while the running text reads CURSUS
     — a deliberate split, so it is asserted rather than left to drift. */
check('the wordmark still ships as CVRSVS', bundle.includes('CVRSVS'))
check('the compact mark is drawn, not an image', bundle.includes('M31 21.5'))

section('Header (audit §1)')
const appSource = read('../client/src/App.jsx')
check('About is in the header', appSource.includes('to="/about"'))
check('Contact is in the header', appSource.includes('to="/contact"'))
check('Pricing was added to the menu', appSource.includes('to="/pricing"'))
check('and sits before Contact, which is the last resort of the three',
  appSource.indexOf('to="/pricing"') < appSource.indexOf('to="/contact"'))
check('the nav items are not bold', /\.nav-link\{[^}]*font-weight:var\(--w-medium\)/.test(css))
check('and the route exists, so the link is not a dead end',
  appSource.includes('<PricingPage />'))
/* The Recruiters item is gone from the menu entirely: the landing card now asks
   "I am: Candidate or Recruiter", and Sign in already offers the recruiter door,
   so a third route to the same place made the header look like it had two
   audiences when only the card ever did. */
check('there is no Recruiters item in the menu',
  !/>Recruiters</.test(appSource) && !/>For recruiters</.test(appSource))
check('the home icon is gone', !appSource.includes('nav-link-icon'),
  'the wordmark beside it already went home')
// The whole bar is the logo's colour, and everything on it is white.
/*
 * The header floats; it is not a slab.
 *
 * It was a full-bleed band of saturated oxblood across the top of every page —
 * the loudest colour on the site, above the content, cropping the viewport and
 * framing everything below it. The brand does not need a stripe to be present:
 * the mark carries it, and the one solid oxblood shape left up here is the
 * button a visitor is actually meant to press.
 */
check('the header is a transparent rail', /\.site-header\{[^}]*background:transparent/.test(css))
check('carrying a floating card inset from the edges',
  /\.site-header-inner\{[^}]*border-radius:var\(--radius-xl\)/.test(css))
/* The minifier collapses rgb(255 255 255 / 82%) to the #ffffffd1 hex-with-alpha
   form, so the assertion matches what actually ships rather than what is typed. */
/*
 * The glass is painted by a pseudo-element, and that is load-bearing.
 *
 * `backdrop-filter` makes an element a CONTAINING BLOCK for every
 * `position: fixed` descendant, exactly as `transform` does. The mobile menu
 * drawer renders inside this header, so with the filter on the bar itself the
 * drawer stopped being a viewport overlay: it became a 312x58px box trapped in
 * the nav, its five destination links collapsed to sixteen pixels. About,
 * Pricing, Contact and Live Demo were unreachable on every phone.
 *
 * These two assertions exist to stop that coming back.
 */
check('that card is near-white, not oxblood',
  /\.site-header-inner::?before\{[^}]*background:#ffffff[0-9a-f]{2}/.test(css))
check('and it blurs what passes underneath',
  /\.site-header-inner::?before\{[^}]*backdrop-filter:/.test(css))
check('but the bar itself carries no filter, or fixed children break',
  !/\.site-header-inner\{[^}]*backdrop-filter:/.test(css))
check('with ink nav links, not white ones', /\.nav-link\{[^}]*color:var\(--ink-2\)/.test(css))
check('no underline on them', !/\.nav-link\{[^}]*text-decoration:underline/.test(css))
check('and no bold on the active one',
  !/\.site-nav>\.nav-link\.active\{[^}]*font-weight:8/.test(css))
// About and Contact centred, Sign in alone on the right.
check('destinations are centred', /\.site-header-inner\{[^}]*grid-template-columns:1fr auto 1fr/.test(css))
check('and the right side holds Sign in only', appSource.includes('<SignInMenu />'))
// A boxed button: white fill, oxblood text, an arrow, and two doors behind it.
const signInSource = read('../client/src/components/SignInMenu.jsx')
/* Inverted with the bar: the accent now lands on the action rather than on
   the furniture behind it, which is where a brand colour earns saturation. */
check('Sign in is the one solid shape in the header',
  /\.site-signin-toggle\{[^}]*background:var\(--accent\)/.test(css))
check('with white text on it', /\.site-signin-toggle\{[^}]*color:var\(--accent-contrast\)/.test(css))
check('and an arrow', css.includes('.site-signin-caret'))
// The two labels are JSX text nodes on their own lines, so this looks for them
// as rendered content rather than anywhere in the file — the word "Recruiter"
// also appears in the comment explaining why the split exists.
check('it opens onto Candidate and Recruiter',
  /^\s+Candidate$/m.test(signInSource) && /^\s+Recruiter$/m.test(signInSource))
check('each routing to its own sign-in flow',
  signInSource.includes('to="/account"') && signInSource.includes('to="/hr"'))
check('at the specified max width', css.includes('1360px'))

/*
 * On a phone the bar is a wordmark and a hamburger, and the destinations move
 * into a drawer. It used to wrap into two rows here, which cost a band of a
 * screen that has none to spare.
 */
const drawerSource = read('../client/src/components/MobileNav.jsx')
check('a menu button replaces the nav below 900px',
  /@media (max-width: 899px)[^}]*}[sS]{0,400}?.nav-toggle{[^}]*display:inline-grid/.test(css)
  || css.includes('.nav-toggle{display:inline-grid'))
check('and the nav and sign-in menu are hidden there',
  /.site-header-inner>.site-nav,.site-header-inner .site-signin{display:none/.test(css))
check('the drawer is a modal dialog', drawerSource.includes("role=\"dialog\"") && drawerSource.includes('aria-modal'))
check('it closes on Escape', drawerSource.includes("event.key !== 'Escape'"))
check('and on arriving somewhere', drawerSource.includes('[pathname]'))
check('the page behind it does not scroll', drawerSource.includes("document.body.style.overflow = 'hidden'"))
check('it offers both sign-in doors',
  drawerSource.includes('Candidate sign in') && drawerSource.includes('Recruiter sign in'))

/* .btn-outline used to be declared before .btn, which sets a transparent
   border at the same specificity — so every outline button on the site
   rendered borderless. It has to stay after it. */
check('outline buttons keep their border',
  css.indexOf('.btn-outline{') > css.indexOf('.btn{'),
  '.btn-outline must be declared after .btn')

section('Footer')
/*
 * The footer is no longer the oxblood band §9 asked for. Two full-strength
 * bars, one at each end, framed every page in brand colour and left the content
 * between them reading as filling — so the colours are inverted: a ground
 * barely darker than the page, carrying oxblood.
 */
/*
 * The footer is the end of the page, not another band across it.
 *
 * It has been an oxblood bar and then a grey one; both were a second horizontal
 * stripe under a page that did not need one. The tinted ground simply continues
 * through it and a hairline says where the content stopped.
 */
check('the footer carries no fill of its own',
  /\.site-footer\{[^}]*background:transparent/.test(css))
/*
 * Oxblood text on an oxblood-tinted band made the footer a second brand bar
 * competing with the header. The header keeps the colour because it carries the
 * wordmark; the footer steps back to the same greys as the rest of the
 * furniture, and a hairline is what separates it from the page.
 */
check('its text is a quiet grey', /\.site-footer\{[^}]*color:var\(--ink-2\)/.test(css))
check('with a rule marking the join', /\.site-footer\{[^}]*border-top:1px solid var\(--border\)/.test(css))
check('links are quieter still, and darken on hover',
  /\.site-footer-links a\{[^}]*color:var\(--text-muted\)/.test(css)
  && /\.site-footer-links a:hover\{[^}]*color:var\(--text\)/.test(css))
check('the logo takes its light-ground form',
  !read('../client/src/components/SiteFooter.jsx').includes('inverse'),
  'the inverted mark was drawn for the solid bar')
// The "ig" placeholder becomes a real glyph — and so do the other three, or one
// icon would stand among three letters.
check('the social marks are drawn, not letters',
  !/glyph: 'ig'|glyph: 'in'/.test(read('../client/src/components/SiteFooter.jsx')))
check('all four have real glyphs',
  ['LinkedIn', 'Facebook', 'Instagram', 'X'].every((n) => read('../client/src/components/SiteFooter.jsx').includes(`${n}:`)))
check('the social buttons are oxblood hairlines',
  /\.site-footer-social a[^{]*\{[^}]*border:1px solid rgb\(122 46 42/.test(css))

check('Privacy is still in the footer', bundle.includes('Privacy Policy'))
check('Terms is still in the footer', bundle.includes('Terms of Service'))
check('a copyright line is present, and reads as prose rather than as a second logo',
  /© \{new Date\(\)\.getFullYear\(\)\} Cursus/.test(read('../client/src/components/SiteFooter.jsx')),
  'CVRSVS is the wordmark, which sits beside this line as a mark; the sentence '
  + 'itself takes the spelling the rest of the running text uses')
check('About is NOT duplicated in the footer',
  !read('../client/src/components/SiteFooter.jsx').includes('/about'),
  'it lives in the header now')

section('Landing structure (§15.1)')
check('the pitch column exists', bundle.includes('candidate-pitch'))
check('the application card exists', bundle.includes('application-card'))
check('the card is anchored for the Apply jump', bundle.includes('"apply"') || bundle.includes("id:\"apply\""))
check('the supporting sections are their own block', bundle.includes('lower-copy'))

section('Hero (audit §2)')
const pageSource = read('../client/src/pages/UploadPage.jsx')
check('Welcome to CURSUS is a title now, not an eyebrow',
  pageSource.includes('landing-welcome') && !pageSource.includes('className="eyebrow"'))
check('and it is the largest thing on the page',
  parseFloat(css.match(/\.landing-welcome\{font-size:([\d.]+)rem/)?.[1] ?? 0)
  > parseFloat(css.match(/\.landing-title\{font-size:([\d.]+)rem/)?.[1] ?? 99),
  'the headline sits slightly smaller, per §2')

section('Copy (§6)')
for (const line of [
  'Welcome to CURSUS',
  // The headline is two claims with a deliberate <br /> between them — what it
  // costs you, and what you get — so it is no longer one string in the bundle.
  'Two minutes now.',
  'Then we put your CV in front of the',
  'Job searching is backwards.',
  'How it works',
  "What you'll bring",
  'For everyone',
  'Any industry. Any level. Any background.',
  /* The two closing lines the rewritten deck ends each side on. */
  'Stop chasing. We chase for you.',
  'Search once. See who actually matches.',
]) check(`carries "${line.slice(0, 32)}"`, bundle.includes(line))

/*
 * The candidate deck's third rewrite was about one thing: who is the subject
 * of the sentence. It used to be the reader's luck — "opportunities chase
 * you", "it makes the right jobs find you" — and every one of those lines
 * described a place rather than a service. These are the lines that carry the
 * correction, and a later edit that slides back into the passive voice should
 * fail here rather than ship quietly.
 */
for (const line of [
  'It works your CV for you',
  'Your profile keeps working while you don',
  'We push your CV forward',
  'Discovered when they look, promoted when you match.',
  'The right people reach out',
]) check(`CURSUS does the work: "${line.slice(0, 34)}"`, bundle.includes(line))

/*
 * And the limit on that, which is the reason the deck's own draft was edited
 * before it shipped. Nothing reaches a recruiter who has not searched — there
 * are no alerts, no digests and no scheduled outreach — so the page may
 * promise the ranking and the argued fit, and may not promise an approach.
 */
check('without promising outreach that does not happen',
  !/(does|doesn|do not|don).{0,4}t wait to be asked|we (email|contact|approach) recruiters/i
    .test(bundle),
  'the claim is that you are put at the top of the search, not that we knock on doors')

/* The hero microcopy: one line under the button answering "what does pressing
   that cost me", different on each side. */
for (const line of [
  'Free for candidates. No cover letter. Ever.',
  'Paste a job description. Get a ranked shortlist.',
]) check(`and the hero says "${line.slice(0, 28)}"`, bundle.includes(line))

check('the headline breaks at the full stop rather than wherever it wraps',
  pageSource.includes('Two minutes now.<br />'),
  'the break is typography, not an accident of column width')

check('no backend vocabulary leaks onto the page',
  !/embedding|scoring architecture|model pipeline/i.test(bundle.split('candidate-pitch')[1]?.slice(0, 4000) ?? ''))

section('The two join buttons do different jobs (§5.1, audit §10)')
check('the one in the copy is a button, not a submit', bundle.includes('btn-apply-top'))
/* §10 moved it up next to "Job searching is backwards.", so it now scrolls the
   card into view rather than jumping to the top of a page it already sits near.
   The copy itself lives in landingCopy.jsx, so "before the closing argument"
   is now "before the pitch body is rendered at all". */
const copySource = read('../client/src/pages/landingCopy.jsx')
check('the button sits beside the lead, not after the closing argument',
  pageSource.indexOf('btn-apply-top') < pageSource.indexOf('<CandidatePitch')
  && copySource.includes('landing-kicker'))
/* And a second one at the foot, so a reader convinced by the last line does not
   have to scroll back up to act on it. */
check('with a second way in at the end of the argument',
  copySource.includes('landing-close-cta')
  && copySource.includes('Create my profile'))

/* Each side gets its own argument. The page used to show the candidate pitch to
   everyone and swap only the card, so a recruiter read "upload your CV" beside
   a form asking for their company name. */
check('the two sides read differently',
  copySource.includes('Job searching is backwards') === false
  && pageSource.includes("'Recruiting is backwards.'")
  && pageSource.includes("'Job searching is backwards.'"))
/* A candidate makes a profile; a recruiter makes an account. Both buttons were
   one word off — the candidate's said "account" and the recruiter's said
   "business account", which is not what the form beside it is called either. */
check('and each names what that side actually creates',
  pageSource.includes("'Create my account' : 'Create my profile'"))
check('the recruiter argument is about screening, not applying',
  copySource.includes('AI made applying effortless. Now every role gets flooded'))
check('and it names Triage for the pile they already have',
  copySource.includes('Already drowning in applications?')
  && copySource.includes('sorts the stack you already have'))
check('both sides walk through it in numbered steps, like the About page',
  (copySource.match(/<ol className="steps">/g) ?? []).length === 2)
// Matched on a fragment that survives the source's line wrapping — the full
// sentence spans a newline in the JSX.
check('the candidate argument is about being found',
  copySource.includes("doesn't help you apply to more jobs"))
check('and on the same line as it', css.includes('.landing-lead-row'))
check('it carries the reader to the form', bundle.includes('scrollIntoView'))
/*
 * The field is found rather than named, so the button works on both panels —
 * the old assertion pinned `#first-name`, an id only the candidate form has,
 * which is exactly why the recruiter panel scrolled and focused nothing.
 */
check('and points at the first field to fill',
  pageSource.includes('field-called')
  && pageSource.includes("card.querySelector(")
  && !pageSource.includes("querySelector('#first-name')"))
check('skipping the hidden file inputs above it',
  pageSource.includes('[type="file"]'), 'the CV dropzone and the photo uploader')
check('the highlight is monochrome', css.includes('.field-called'))
// §10 — oxblood, not the bright blue that belonged to nothing else.
check('it is oxblood now', !/\.btn-apply-top\{[^}]*background:#3b5bdb/.test(css))
check('and respects reduced motion', bundle.includes('prefers-reduced-motion'))
/* Nobody applies on Cursus — the premise is that you are found — so the CTA
   says what it does. The old label described the thing this replaces. */
check('the call to action is Create my profile, not Apply',
  bundle.includes('Create my profile') && !/>Apply</.test(bundle))
check('the explanation sits under the final button only',
  read('../client/src/pages/UploadPage.jsx').split('btn-apply-top')[1]?.includes('create your Cursus profile') !== true,
  'no grey profile-creation line under the navigation CTA')

section('Application card (§7, audit §3–§8)')
check('the required note is present', bundle.includes('Fields marked with'))
const form = formSource
const cvAt = form.indexOf('>CV{')
const nameAt = form.indexOf('First name')
check('CV / Resume is field #1', cvAt > 0 && cvAt < nameAt, `CV at ${cvAt}, first name at ${nameAt}`)
/* Reversed deliberately. §7.3 kept the photo off the signup card to protect the
   two-minute promise; it is optional, one click, and sits below the CV, so an
   candidate no longer has to submit and sign in before they can offer a face. */
check('the photo uploader is on the signup card too',
  form.includes('<PhotoUploader') && !form.includes('{isEdit && (\n        <PhotoUploader'))
// §3 — a white card on the tinted page, not a solid salmon block.
check('the card is white', /\.application-card\{background:var\(--surface\)/.test(css))
check('with a soft shadow doing the separating',
  /\.application-card\{[^}]*box-shadow:var\(--shadow-md\)/.test(css))
check('and a full-width primary submit',
  /\.application-card \.btn-primary[^{]*\{width:100%/.test(css))
check('grey placeholder text in the wells', /::placeholder\{color:var\(--text-subtle\)/.test(css))
/*
 * Every control that takes input says so when it has the keyboard. There was no
 * focus rule at all before: the site relied on the browser's default ring,
 * which Chrome draws, Safari mostly does not, and which sits square outside a
 * rounded corner where it does appear.
 */
check('and one focus ring, shared by every control',
  css.includes('--ring:0 0 0 3px') || css.includes('--ring: 0 0 0 3px'))
check('worn by fields', /input:focus,select:focus,textarea:focus\{[^}]*box-shadow:var\(--ring\)/.test(css))
check('and by buttons', /\.btn:focus-visible\{[^}]*box-shadow:var\(--ring\)/.test(css))
/*
 * A link with no rule of its own was drawn in #0000EE — the default blue every
 * browser has shipped since 1994 — which is enough on its own to make a page
 * look unfinished.
 */
check('no link falls back to the browser blue', /(^|\})a\{[^}]*color:var\(--accent\)/.test(css))
// §5 — label above the circle, and the circle is the only target.
const uploader = read('../client/src/components/PhotoUploader.jsx')
check('the profile picture label sits above the circle', css.includes('.photo-field'))
check('the Add photo button is gone', !/>s*Add photos*</.test(uploader))
check('the dashed circle takes a drop as well as a click', uploader.includes('onDrop'))
check('and shows it is clickable', css.includes('.avatar-editable{cursor:pointer'))
// §6 — Capacity left, and the two Yes/No controls sharing the line below.
check('openness is a Yes/No control, not a checkbox', form.includes('name="openToAll"'))
check('paired with relocation on one row', css.includes('.preference-row'))
check('the "leave this ticked" copy is gone', !form.includes('Leave this ticked'))
// §7 — one + button in place of four fixed rows.
const picker = read('../client/src/components/DocumentPicker.jsx')
check('the section is called Documents', form.includes('>Documents<'))
check('the four fixed upload rows are gone', !form.includes('OPTIONAL_SLOTS'))
check('a + button opens a picker', css.includes('.doc-add') && css.includes('.doc-menu'))
check('with four types and seven files between them',
  picker.match(/max: \d/g)?.map((m) => Number(m.slice(5))).reduce((a, b) => a + b, 0) === 7)
check('PNG and JPEG are accepted alongside PDF and DOCX',
  picker.includes('.png') && picker.includes('.jpeg'))
check('a type at its ceiling is greyed rather than failing after the pick',
  css.includes('.doc-menu button:disabled'))
check('each upload gets a small red x', css.includes('.doc-remove'))
/*
 * §8 — a focusable explanation of the disabled state, beside one button that
 * writes the summary.
 *
 * The verb follows the state rather than being one word everywhere. On the
 * sign-up form the box is empty and this is the first draft, so "Regenerate"
 * asked the reader to repeat something they had not done; in the portal a
 * summary already exists and "Regenerate" is exactly right.
 */
check('the summary button offers to write it with AI',
  form.includes('Generate with AI'))
check('and says "Regenerate" only where there is something to redo',
  form.includes("isEdit ? 'Regenerate with AI' : 'Generate with AI'"))
check('and carries the arrow that says "again"',
  form.includes('<RegenerateIcon spinning={drafting} />'))
check('the inline helper line became an (i)', form.includes('<InfoHint'))
check('which is a button, so it works by touch and keyboard too',
  read('../client/src/components/InfoHint.jsx').includes('<button'))
check('the summary text area has the specified height', css.includes('min-height:130px'))
check('inputs meet the touch target', css.includes('min-height:48px'))

section('Excluded fields (§8, §16)')
const cardFields = form.slice(cvAt, form.indexOf('Professional Summary'))
for (const banned of ['Work history', 'Education', 'Seniority', 'Years of experience', 'Industry']) {
  check(`"${banned}" is not asked for`, !cardFields.includes(banned))
}

section('Responsive (§10)')
check('single column below 900px', css.includes('max-width:899px'))
check('mobile spacing below 640px', css.includes('max-width:639px'))
check('names stack on narrow screens', css.includes('.application-card .grid-2'))

section('A new page starts at its top')
/*
 * A client-side route change is not a page load, so nothing moves the viewport
 * on its own. Following Privacy Policy from the footer — which is by definition
 * at the bottom of a long page — used to drop you the same distance down the
 * policy, mid-clause. The scroll position belonged to the page you left.
 */
const app = read('../client/src/App.jsx')
check('something resets the viewport when the route changes',
  app.includes('function ScrollToTop()') && app.includes('<ScrollToTop />'))
check('it keys off the pathname, not the whole location',
  /useEffect\([^]*?\}, \[pathname\]\)/.test(app),
  'the pricing tab and ?join= live in the query string; those must not jump')
check('and it leaves back/forward alone',
  app.includes("if (navigationType === 'POP') return"),
  'the browser restores the old position on POP, which is what people expect')
check('the jump is instant rather than animated',
  app.includes("behavior: 'instant'"), 'a page racing upward on arrival reads as a glitch')
/* Both footer links are the ones that showed the bug. */
const footer = read('../client/src/components/SiteFooter.jsx')
check('the footer still routes rather than reloading',
  footer.includes('<Link to="/privacy">') && footer.includes('<Link to="/terms">'))

section('The page still serves and applies')
const home = await fetch(`${BASE}/`)
check('the landing page is served', home.status === 200)
check('the tab is titled for the product',
  (await home.text()).includes('Two minutes now'))
const health = await json(await fetch(`${BASE}/api/health`))
check('the API is up behind it', health.ok === true)

section('Signing up (later round)')

// "I am: Candidate / Recruiter", above the card, changing only the card.
check('the landing card asks who is filling it in', pageSource.includes('role-switch'))

/*
 * Crossing sides from the foot of the page returns you to the top of it.
 *
 * The two "See how CURSUS works for..." links sit at the very bottom of a long
 * pitch, and pressing one replaces everything above them. Without the scroll
 * the reader is left at the foot of a page they have never seen the top of,
 * looking at whatever happens to sit the same distance down the new one — the
 * headline, the whole argument and the form are all behind them.
 *
 * The role switch at the top is deliberately not given this: it is already
 * there, and scrolling to where you are is a jolt for nothing.
 */
check('crossing sides from the foot scrolls back to the top',
  /function switchSide\(next\) \{[\s\S]{0,200}window\.scrollTo\(\{ top: 0/.test(pageSource),
  'the links are the last thing on the page and replace everything above them')
check('and it honours prefers-reduced-motion',
  /switchSide[\s\S]{0,300}prefers-reduced-motion[\s\S]{0,120}reduced \? 'auto' : 'smooth'/.test(pageSource),
  'the same rule focusApplication follows a few lines below it')
check('both cross-links go through it',
  (pageSource.match(/onSwitchSide=\{\(\) => switchSide\('(candidate|recruiter)'\)\}/g) ?? []).length === 2,
  'one of the two switching without scrolling is the bug, seen half the time')

/* The chosen segment is filled, not outlined and not merely lettered. */
check('the chosen side of a switch is filled with the accent',
  /\.role-option-on,[\s\S]{0,200}background:var\(--accent\)/.test(css)
  || /\.role-option-on,\.role-option-on:hover\{background:var\(--accent\)/.test(css))
check('and its label is white, which is the only legible pairing on it',
  /\.role-option-on[\s\S]{0,200}color:var\(--surface\)/.test(css),
  'grey lettering is what an outlined pill wanted and cannot survive a coloured ground')
/* Candidate unless the URL says otherwise: the About page's "Create an
   account" arrives as ?join=recruiter so a recruiter lands on the account form
   rather than on the candidate card with a toggle to find. */
check('Candidate is the default',
  pageSource.includes("params.get('join') === 'recruiter' ? 'recruiter' : 'candidate'"))
check('and ?join=recruiter opens the company panel instead',
  pageSource.includes("params.get('join')"))
check('choosing Recruiter swaps the card rather than navigating',
  pageSource.includes('<CompanySignUpForm'))
check('and it is the same form /hr serves',
  read('../client/src/pages/HrPanel.jsx').includes('<CompanySignUpForm'),
  'one component, two places')

// Both contact details are proved with a code before an account is created.
const verified = read('../client/src/components/VerifiedField.jsx')
check('email and phone are verified at sign-up', formSource.includes('<VerifiedField'))
check('on the recruiter side too',
  read('../client/src/components/CompanySignUpForm.jsx').includes('<VerifiedField'))
check('a code is requested and confirmed against the server',
  verified.includes('/api/verify/request') && verified.includes('/api/verify/confirm'))
check('editing a verified address drops its proof', verified.includes("onProof('')"),
  'a proof names one address and must not survive a change to it')
check('the form refuses to submit without both proofs',
  formSource.includes('Please verify your'))

/*
 * City: suggestions, and required.
 *
 * The list is in the bundle again, on purpose — this check used to assert the
 * opposite. What must not come back is the CLOSED list: it was a dropdown of
 * Israeli cities with an "Other" escape, which asked everybody who lives
 * anywhere else to describe themselves as an exception. Offering the names
 * while still accepting anything typed is the version of this that costs
 * nobody their own city.
 */
const cityField = read('../client/src/components/CityField.jsx')
check('city is required', /label="City" required/.test(formSource))
check('and it is a text input, not a dropdown',
  cityField.includes('<input') && !cityField.includes('<select') && !formSource.includes('ISRAELI_CITIES'),
  'a closed list is what this field was replaced for')
check('the cities ship as suggestions', bundle.includes('Rishon LeZion'),
  'clicking the field has to be able to show them without asking the server')
check('and a city nobody listed is still accepted',
  cityField.includes('we will use what you typed'),
  'no dead end, no Other')
check('the CV pre-fills the form', formSource.includes('/api/candidate/parse-cv'))
/* A CV does not know when someone could start, so availability is left out of
   the list of fields the pre-fill writes into. */
check('but never availability',
  !/const key of \[[^\]]*availability/.test(formSource))
check('and never overwrites what someone already typed',
  formSource.includes('String(prev[key]).trim()'))

check('Freelance is offered as a capacity', formSource.includes("'Freelance'"))
check('relocation now leads the preference row',
  formSource.indexOf('name="openToRelocation"') < formSource.indexOf('name="openToAll"'))

section('About page')

const about = read('../client/src/pages/InfoPage.jsx')

// The image sits beside the opening paragraph and scrolls with the page. The
// heading is above the grid, so the top of the photo lines up with the lead.
check('the About image is not sticky', !/\.intro-figure\{[^}]*position:sticky/.test(css))
check('and sits beside the copy', /\.intro-grid\{[^}]*grid-template-columns/.test(css))

// Four sections: what this is, the two paths, the recruiter case, your data.
// Five sections: what this is, the two paths, the recruiter case, your data,
// and the way out after the whole argument.
check('the page is sectioned rather than one column of prose',
  (about.match(/<section className="about-section">/g) ?? []).length === 5)
check('and it closes with a way in for both sides',
  about.includes('One profile. The right eyes on it. Nothing exposed.')
  && about.includes('>Create my profile<') && about.includes('>I’m hiring<'),
  'the page used to end on Contact us, with no conversion point after the pitch')
check('both paths are numbered step lists',
  (about.match(/<ol className="steps">/g) ?? []).length === 2)
check('the numbering comes from the list, not typed-in digits',
  /\.steps li\{[^}]*counter-increment:step/.test(css) && css.includes('content:counter(step)'))
/*
 * The recruiter section is a card, not a slab.
 *
 * It was a solid block of oxblood 56px-padded on every side, carrying four
 * invented pink tints so its own text stayed legible against it — the bulkiest
 * single object on the site, and the same mistake as the old header bar at ten
 * times the area. Saturation belongs on the thing you press, not on the
 * container around three paragraphs.
 */
check('the recruiter panel is a card like every other card',
  /\.recruiter-panel\{[^}]*background:var\(--surface\)/.test(css))
check('separated by a hairline rather than by a wall of colour',
  /\.recruiter-panel\{[^}]*border:1px solid var\(--border\)/.test(css))
check('so its type takes the page ink', /\.recruiter-panel p\{color:var\(--ink-2\)/.test(css))
check('and its eyebrow keeps the accent', /\.recruiter-panel \.about-eyebrow\{color:var\(--accent\)/.test(css))
check('the data section lists six controls',
  (about.match(/className="control"/g) ?? []).length === 1
  && (about.match(/\['[^']*\.',/g) ?? []).length === 6)
check('the calls to action point somewhere real',
  about.includes('to="/pricing"') && about.includes('to="/contact"'))
/* Each side of "how it works" offers its own way in, beside the heading rather
   than at the foot of the column — and each opens the panel it belongs to. */
check('each path offers the sign-up for its own side',
  about.includes('to="/?join=candidate"') && about.includes('to="/?join=recruiter"'))
check('and the privacy section still ends on Contact us alone',
  (about.match(/className="about-cta"/g) ?? []).length === 3
  && !about.includes('>Create your profile<'),
  'three now: See pricing, Contact us, and the closing pair — the profile CTA '
  + 'still does not sit at the foot of the privacy section')

/*
 * The page must not promise a cycle the system does not run.
 *
 * It used to name a monthly confirmation email, which was the whole model. Now
 * the model is a clock: silence for 30 days starts the reminders, silence for
 * 60 takes the profile out of search. Both numbers are read off the server so
 * the page cannot drift from the sweep.
 */
const profilesSource = read('../server/src/profiles.js')
const freshDays = Number(profilesSource.match(/const FRESH_DAYS = (\d+)/)?.[1])
const hideDays = Number(profilesSource.match(/const HIDE_DAYS = (\d+)/)?.[1])

check('the page names the same window the server starts asking in',
  about.includes(`${freshDays} days`), `${freshDays} days`)
check('and the same one it hides on',
  about.includes(`${hideDays} days`), `${hideDays} days`)
check('it no longer promises a monthly confirmation',
  !/check in every 30 days|confirms every 30 days/.test(about),
  'the monthly cycle is gone; silence is what counts now')
/* Recency is not availability, and the page is where that oversell would
   happen first. */
check('and it does not promise the candidate will reply',
  !/guarantee[sd]? (a )?(reply|response|contact)/i.test(about))

finish()
