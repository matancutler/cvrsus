/**
 * The legal documents and the consent that gates account creation.
 *
 * Two things this file is protecting.
 *
 * The first is that there is exactly one copy of each document. The moment the
 * consent modal and the /terms page stop sharing a source, the text somebody
 * agreed to at sign-up and the text they can read afterwards are free to drift,
 * and the agreement stops meaning anything. Several checks below exist only to
 * fail if someone inlines a second copy.
 *
 * The second is that the box is genuinely a gate: unticked by default, refused
 * on submit, and never quietly satisfied by a default value or a disabled
 * button that cannot report why nothing happened.
 *
 * Structural assertions run against the source and the built bundle; there is
 * no headless browser here, so anything needing layout is measured elsewhere.
 */
import fs from 'node:fs'

import { BASE, createReporter, json } from './helpers.mjs'

const { check, section, finish } = createReporter()

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const dist = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
const bundle = read(`../client/dist/assets/${dist.find((f) => f.startsWith('index-') && f.endsWith('.js'))}`)
const css = read(`../client/dist/assets/${dist.find((f) => f.startsWith('index-') && f.endsWith('.css'))}`)

const documents = read('../client/src/legal/legalDocuments.jsx')
const consent = read('../client/src/components/LegalConsent.jsx')
const info = read('../client/src/pages/InfoPage.jsx')
const candidateForm = read('../client/src/components/CandidateForm.jsx')
const companyForm = read('../client/src/components/CompanySignUpForm.jsx')

section('The documents are present and complete')

/* Section counts, not word counts: a clause that gets dropped in an edit is the
   failure worth catching, and numbered headings are how you notice. */
const termsSections = [...documents.matchAll(/<h2>(\d+)\. /g)].map((m) => Number(m[1]))
const privacySplit = documents.indexOf('function PrivacyBody')
const allSections = [...documents.matchAll(/<h2>(\d+)\. /g)]
const inTerms = allSections.filter((m) => m.index < privacySplit).map((m) => Number(m[1]))
const inPrivacy = allSections.filter((m) => m.index > privacySplit).map((m) => Number(m[1]))

check('the Terms carry all 23 numbered sections',
  inTerms.length === 23 && inTerms[0] === 1 && inTerms[22] === 23,
  `found ${inTerms.length}: ${inTerms.join(',')}`)
check('and they are numbered consecutively, none skipped',
  inTerms.every((n, i) => n === i + 1))
check('the Privacy Policy carries all 18 numbered sections',
  inPrivacy.length === 18 && inPrivacy[0] === 1 && inPrivacy[17] === 18,
  `found ${inPrivacy.length}: ${inPrivacy.join(',')}`)
check('and they too are consecutive',
  inPrivacy.every((n, i) => n === i + 1))

/*
 * Clause text is compared with whitespace flattened. The prose is wrapped to
 * the column width of the source file, so any sentence long enough to matter
 * carries a newline and eight spaces somewhere in the middle of it — matching
 * the raw file would only ever assert on phrases short enough to fit one line,
 * which is the opposite of what wants protecting.
 */
const prose = documents.replace(/\s+/g, ' ')

/* Spot-checks on the clauses that carry the most weight — the ones a reader is
   most likely to be relying on, and the ones whose loss would be quietest. */
for (const [label, phrase] of [
  ['the AI-training carve-out survives in the Terms',
    'does not permit CURSUS to use candidate CVs, cover letters'],
  ['the liability cap keeps its figure', 'USD 100'],
  ['the governing-law clause keeps its forum', 'Tel Aviv-Jaffa'],
  ['the reveal-credit terms keep "do not expire"', 'Purchased Reveal Credits do not expire'],
  /* The refusal is now split in two, because the two halves rest on different
     things: CURSUS controls whether IT trains on candidate data, and can only
     rely on a contractual commitment about what its providers do. */
  ['the Policy still refuses model training by CURSUS itself',
    'does not train any model of its own on candidate CVs'],
  ['and states what it relies on for the providers',
    'not to train their general-purpose models'],
  ['the 30-day rights-response window survives', 'within 30 days'],
  ['the lawful-bases table is a table, not a paragraph', '<table className="legal-table">'],
]) check(label, prose.includes(phrase))

section('The brand reads as the drafts wrote it')
/*
 * CURSUS, as supplied — and as the rest of the running text on the site now
 * reads. These documents define who the agreement is with, so the name in them
 * is not a detail.
 *
 * Note what this does NOT assert: that the name matches the wordmark. It does
 * not. The logo in the header and footer still reads CVRSVS, deliberately, so
 * the site currently serves a policy naming a brand spelled differently from
 * the mark above it. That is a decision for whoever signs these off; the test
 * records the split rather than papering over it.
 */
/*
 * Comments are stripped first. This asks about rendered text, and the file's
 * own commentary discusses both spellings by name — a `>[^<]*CVRSVS` run over
 * the raw source starts at some unrelated tag and reads straight into a comment
 * paragraph, so it was failing on the note that documents the split rather than
 * on any clause.
 */
const rendered = documents.replace(/\/\*[\s\S]*?\*\//g, '')
check('the documents name CURSUS', rendered.includes('operated under the CURSUS brand'))
check('and no CVRSVS survives in their rendered text', !rendered.includes('CVRSVS'),
  'the running text moved; only the wordmark kept the old spelling')

section('Unfilled fields stay visibly unfilled')
/*
 * The operator's own identity and contact routes are still bracketed in the
 * drafts. They are rendered rather than removed: a silently deleted placeholder
 * leaves a sentence that reads as finished and tells the reader nothing, and an
 * invented entity name would be worse than either.
 */
for (const field of ['LEGAL ENTITY NAME', 'REGISTERED ADDRESS', 'PRIVACY EMAIL', 'SUPPORT EMAIL', 'LEGAL EMAIL']) {
  check(`[${field}] is still shown as a placeholder`,
    documents.includes(`<Placeholder>${field}</Placeholder>`))
}
check('none of them was filled in with an invented company',
  !/Cvrsvs Ltd|CVRSVS Ltd|Cursus Ltd|CURSUS Ltd|@cvrsvs\.com|@cursus\.com/.test(documents),
  'a plausible-looking fake is the one thing a legal page cannot carry')
check('and the page says out loud that it is a draft',
  documents.includes('export const DRAFT_NOTICE') && info.includes('DRAFT_NOTICE'))

section('One copy, shown in two places')
/*
 * This is the whole point of the module. If either surface grows its own copy,
 * the document a candidate agreed to and the document they can read later stop
 * being the same document.
 */
check('the standalone pages import the documents rather than restating them',
  info.includes("from '../legal/legalDocuments.jsx'"))
check('the consent modal imports the same module',
  consent.includes("from '../legal/legalDocuments.jsx'"))
check('the old "being prepared" placeholder pages are gone',
  !info.includes('is being prepared') && !info.includes('has not been published yet'))
check('and neither form inlines any clause text of its own',
  !candidateForm.includes('Reveal Credit') && !companyForm.includes('Reveal Credit'))
/* Both routes still resolve through the same InfoPage, so a rename cannot leave
   one of them pointing at nothing. */
check('/terms and /privacy both route to the document renderer',
  info.includes("privacy: { legal: 'privacy' }") && info.includes("terms: { legal: 'terms' }"))

section('The consent box gates account creation')

check('the sentence is the one that was asked for',
  consent.includes('I agree to the') && consent.includes('Terms of Service')
  && consent.includes('Privacy Policy'))

/* Clause 1 of the Terms requires 18, and for a long time nothing asked. The
   affirmation shares this checkbox rather than adding a second one — see the
   note in LegalConsent.jsx — so the sentence and the refusal both name it. */
check('and it affirms the age the Terms require', consent.includes('I am 18 or over'))
check('the validation message is exact',
  consent.includes('You must confirm you are 18 or over and agree to the Terms of Service and ')
  && consent.includes('Privacy Policy to continue.'))

/* Unchecked by default, on both forms. Continued use of the site is not
   consent, and neither is having filled the form in before. */
check('the candidate box starts unticked', candidateForm.includes('useState(false)')
  && /const \[agreed, setAgreed\] = useState\(false\)/.test(candidateForm))
check('the recruiter box starts unticked',
  /const \[agreed, setAgreed\] = useState\(false\)/.test(companyForm))
check('neither is seeded from storage or a prop',
  !/agreed.*localStorage/.test(candidateForm + companyForm))

/* Blocked in the submit handler rather than by disabling the button: a button
   that cannot be pressed cannot explain itself, and the message under the
   checkbox only ever appears because pressing it was allowed. */
check('the candidate submit refuses without it',
  candidateForm.includes('if (consentMissing) return'))
check('the recruiter submit refuses without it',
  companyForm.includes('if (!agreed) return'))
check('the candidate button is not disabled instead',
  /disabled=\{submitting\}/.test(candidateForm))
check('nor the recruiter one', /disabled=\{busy\}/.test(companyForm))

section('It sits beside the act it authorizes, and nowhere else')
/*
 * Immediately above the final submit, on both forms — not beside the hero
 * call-to-action, which only scrolls.
 */
/**
 * What sits between the consent block and the submit button.
 *
 * Takes the source from the end of the `<LegalConsent … />` tag to the submit
 * button, strips JSX comments and the closing of any conditional wrapper, and
 * returns whatever tags are left. Anything at all means something has been
 * inserted between the agreement and the act it authorizes.
 */
function betweenConsentAndSubmit(source) {
  const start = source.indexOf('<LegalConsent')
  const attribute = source.indexOf('type="submit"', start)
  if (start < 0 || attribute < 0) return ['(consent or submit button not found)']
  // Stop at the button's opening bracket, not at the attribute inside it —
  // otherwise the button always counts itself as something in the way.
  const end = source.lastIndexOf('<', attribute)
  return source
    .slice(source.indexOf('/>', start) + 2, end)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')  // JSX comments
    .replace(/\)\}/g, '')                  // the close of `{!isEdit && ( … )}`
    .match(/<[A-Za-z]/g) ?? []
}

check('nothing sits between the candidate box and its submit button',
  betweenConsentAndSubmit(candidateForm).length === 0,
  betweenConsentAndSubmit(candidateForm).join(' '))
check('nothing sits between the recruiter box and its submit button',
  betweenConsentAndSubmit(companyForm).length === 0,
  betweenConsentAndSubmit(companyForm).join(' '))
/* "Immediately above the final submission button" cannot be satisfied by an
   earlier one if there is only ever one. */
check('the candidate form has exactly one submit button',
  (candidateForm.match(/type="submit"/g) ?? []).length === 1)
check('and so does the recruiter form',
  (companyForm.match(/type="submit"/g) ?? []).length === 1)
/* The landing page's own CTA is navigation, not submission — it must not have
   grown a checkbox. */
check('the hero call-to-action has no consent box beside it',
  !read('../client/src/pages/UploadPage.jsx').includes('LegalConsent'))
/* The edit page is a different act: that account exists because the box was
   ticked when it was made, and re-asking on every profile edit would turn a
   considered agreement into something you click past. */
check('the profile edit form does not ask again',
  candidateForm.includes('{!isEdit && (') && /!isEdit && !agreed/.test(candidateForm))
check('the two boxes have distinct ids, since both mount on one page',
  candidateForm.includes('id="candidate-consent"') && companyForm.includes('id="company-consent"'))

section('The links open a dialog, not a new page')
/*
 * A link would unload the page and take the form with it — the CV already
 * attached, the summary drafted from it, the codes already proved.
 */
check('they are buttons rather than anchors',
  consent.includes('<button type="button" className="legal-link"'))
check('and are explicitly type=button, so opening the terms cannot submit the form',
  (consent.match(/type="button" className="legal-link"/g) ?? []).length === 2)
check('neither opens a new tab',
  !/legal-link[^>]*target="_blank"/.test(consent))
check('the dialog renders through a portal, clear of the form element',
  consent.includes('createPortal') && consent.includes('document.body'))
check('Escape closes it', consent.includes("event.key === 'Escape'"))
check('the backdrop closes it', consent.includes('className="modal-backdrop legal-backdrop" onClick={onClose}'))
check('and the page behind is locked while it is open',
  consent.includes("document.body.style.overflow = 'hidden'"))
check('with the previous value restored rather than cleared',
  consent.includes('const previous = document.body.style.overflow')
  && consent.includes('document.body.style.overflow = previous'))

section('The dialog stays usable at the far end of a long document')
/* Header and footer pinned, body scrolling between them: the shared .modal lets
   the backdrop scroll, which would carry the close button off the top. */
check('the body is the only scrolling part',
  /\.legal-modal-body\{[^}]*overflow-y:auto/.test(css))
check('and the dialog itself clips rather than growing',
  /\.legal-modal\{[^}]*overflow:hidden/.test(css))
check('a flick at the end does not scroll the form underneath',
  /\.legal-modal-body\{[^}]*overscroll-behavior:contain/.test(css))
/* Both are flex items whose widest descendant — the 540px lawful-bases table —
   would otherwise force them past a phone screen. */
check('the dialog may shrink below its widest child',
  /\.legal-modal\{[^}]*min-width:0/.test(css))
check('and so may its body', /\.legal-modal-body\{[^}]*min-width:0/.test(css))
check('the wide table scrolls inside its own box',
  /\.legal-table-wrap\{[^}]*overflow-x:auto/.test(css))

section('The checkbox is a checkbox, not a text field')
/*
 * Both cards size every input for a thumb. min-height beats height however
 * specific the height rule is, so without this the 17px box was centred in a
 * 48px slot — a line and a half below the sentence it belongs to.
 */
check('it opts out of the forms\' input min-height',
  /\.consent-check input\[type=checkbox\]\{[^}]*min-height:0/.test(css))
check('and sits on the first line of the sentence, not below it',
  /\.consent-check\{[^}]*align-items:flex-start/.test(css))

section('What a deletion reaches, and what it cannot')
/*
 * The half of erasure that is not a database operation.
 *
 * A candidate can delete everything CURSUS holds and still be unable to touch
 * the PDF a recruiter saved to their laptop last week. Both documents now say
 * so in the places a reader actually arrives at — the plain-language summary,
 * the section on what recruiters get, the retention section, the rights section
 * — and the assertions below exist because that is precisely the kind of
 * clause that gets softened out of a document by somebody tidying it.
 */

check('the Terms say a downloaded copy is beyond CURSUS',
  prose.includes('has no way to recall, expire or delete a file you already hold'))
check('and name the moment a copy leaves the Service',
  prose.includes('the point at which a copy of the candidate&rsquo;s documents leaves CURSUS'))
check('the Policy states there is no watermark, expiry or view-only mode',
  prose.includes('no watermark, no expiry and no view-only mode'))
check('the erasure section names the third-party-copy limit',
  prose.includes('we cannot delete a copy we never held'))

/* Forward-looking rather than absolute: deletion ends every future disclosure,
   which is a promise CURSUS can actually keep. */
check('Terms 15 keeps deletion forward-looking rather than absolute',
  prose.includes('Deletion works forwards, and it reaches only CURSUS&rsquo;s own copies'))
check('and "thorough" is scoped to what CURSUS controls',
  prose.includes('it reaches everything CURSUS holds and controls'))
check('the Policy carries the subheading that says what deletion cannot do',
  prose.includes('<h3>What a deletion cannot reach</h3>'))
check('and it comes before the survivor list rather than inside it',
  documents.indexOf('<h3>What a deletion cannot reach</h3>')
  < documents.indexOf('<h3>What survives a deletion</h3>'))
/* An <h2> here would have made it section 11 and pushed every later number
   along, which is what the consecutive-numbering checks above would catch. */
check('it is an h3, so the numbered-section counts are untouched',
  !/<h2>[^<]*What a deletion cannot reach/.test(documents))

/*
 * Both documents used to claim the access history survived any deletion. It
 * does not: deleteCandidateCompletely drops view_events and reveals with
 * everything else, and only a recruiter closure leaves the record standing.
 */
check('the survivor bullet no longer claims the access history survives a candidate deletion',
  prose.includes('A candidate deleting their profile removes that history with everything else'))
check('and neither statement still claims survival of "either" closure',
  !prose.includes('either account is closed'),
  'a candidate deletion removes the access history; only a recruiter closure leaves it')

/* A Reveal outlives the recruiter who bought it, not the profile itself: a
   block or a deletion ends it, so "permanently" was too strong. */
check('no unscoped permanence is promised to recruiters',
  !prose.includes('for the whole recruiter Organization, permanently'))
check('and the Reveal is scoped to the life of the profile',
  prose.includes('for as long as the profile remains on the Service'))

check('the recruiter-retention bullet distinguishes obligation from capability',
  prose.includes('a requirement CURSUS places on them, not a control it operates'),
  'CURSUS can require a recruiter to delete; it cannot make them')
check('the Triage copy is described by control, not ownership',
  prose.includes('the Organization is its controller under Section 7A')
  && !prose.includes('that document belongs to the Organization'),
  'Section 11 gives the candidate ownership of what they upload')

check('the Last updated date moved with these changes',
  documents.includes("const UPDATED = '24 August 2026'"))
check('no straight or curly apostrophes leaked into the document bodies',
  !/[‘’]/.test(documents.slice(documents.indexOf('function TermsBody'))),
  'JSX text uses &rsquo;; the only curly apostrophe belongs to DRAFT_NOTICE')

section('The delete dialog says the same thing the documents do')
/*
 * The agreement stands alone and the count sits under it as a footnote, because
 * the download is the one fact on that screen the agreement cannot speak for.
 * Asserted here rather than left to a screenshot: it is the last thing a
 * candidate reads before an irreversible act.
 */
const portal = read('../client/src/pages/CandidatePortal.jsx')
const flatPortal = portal.replace(/\s+/g, ' ')

check('the dialog warns that a downloaded copy cannot be recalled',
  flatPortal.includes('We cannot recall those copies'))
check('it is a footnote under the agreement, not an item in a list of losses',
  flatPortal.includes('className="danger-footnote"')
  && flatPortal.indexOf('danger-agree') < flatPortal.indexOf('danger-footnote'),
  'what deletion destroys and what it cannot reach are different claims')
check('and the footnote is marked as an aside',
  /\*\$\{preview\.downloads\}/.test(portal) && portal.includes("'*No recruiter"))
check('the old per-account loss list is gone',
  !portal.includes('danger-list'))

section('The pages serve')
for (const [path, title] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
  // eslint-disable-next-line no-await-in-loop
  const res = await fetch(`${BASE}${path}`)
  check(`${path} is served`, res.status === 200)
  check(`and the bundle behind it carries "${title}"`, bundle.includes(title))
}
const health = await json(await fetch(`${BASE}/api/health`))
check('the API is up behind them', health.ok === true)

finish()
