import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import multer from 'multer'

import { workbook } from './xlsx.js'
import { notifySlack, stamp } from './slack.js'

/**
 * Whoever a notification is about, as a name.
 *
 * Slack lines are read by a person scanning a channel, so an id is no use and
 * a missing name should not print "undefined undefined". Falls back to the
 * username, which always exists.
 */
/**
 * A charge, with the two ways it can fail told apart.
 *
 * A card decline is the customer's problem to fix and they are emailed about
 * it. An exception out of the provider is ours — a misconfigured integration, a
 * provider outage, a bug — and the customer gets a plain refusal while the
 * detail goes to the channel where somebody can act on it. Emailing "your
 * payment failed" for our own outage would send people to re-enter card
 * details that were never the problem.
 *
 * Neither path credits anything: the caller only proceeds on a settled payment.
 */
async function chargeAndReport({ req, amount, currency, description, productType, refusal }) {
  const shared = [
    `${req.company.name} · ${recruiterName(req.recruiter)}`,
    `Product: ${productType}`,
  ]

  let payment
  try {
    payment = await billingProvider.charge({
      companyId: req.company.id, amount, currency, description,
    })
  } catch (error) {
    /*
     * An error reference rather than the message. The message can carry
     * provider internals and Slack is a wide audience; the reference is enough
     * to find the request in the log, which is where the detail belongs.
     */
    const reference = crypto.randomUUID().slice(0, 8)
    console.error(`  purchase error ${reference}:`, error)

    track('purchase_error', {
      actorType: 'recruiter', actorId: req.recruiter.id, productType, reference,
    })
    notifySlack('Purchase error', [
      `${req.company.name} · ${req.recruiter.email ?? recruiterName(req.recruiter)}`,
      `Product: ${productType}`,
      'Stage: charge',
      `Error: ${reference}`,
      stamp(),
    ])

    throw new HttpError(502, 'Something went wrong taking the payment. Nothing was charged.')
  }

  if (payment.status !== 'paid') {
    track('payment_failed', {
      actorType: 'recruiter', actorId: req.recruiter.id, productType,
    })

    if (req.recruiter.email) {
      sendPaymentFailedEmail({
        to: req.recruiter.email,
        name: req.recruiter.first_name,
        amount: formatAmount(amount),
        productType,
      }).catch(() => {})
    }

    notifySlack('Payment failed', [
      ...shared,
      `Amount: ${formatAmount(amount)}`,
      /* Whatever the provider said, and nothing it did not — no card details,
         no tokens. */
      `Failure: ${payment.failureReason ?? payment.status ?? 'declined'}`,
      stamp(),
    ])

    throw new HttpError(402, refusal)
  }

  return payment
}

function recruiterName(recruiter) {
  return [recruiter?.first_name ?? recruiter?.firstName, recruiter?.last_name ?? recruiter?.lastName]
    .filter(Boolean).join(' ') || recruiter?.username || 'Unknown'
}

/**
 * An activation event, at most once per recruiter.
 *
 * The brief wants the first search, the first reveal and the first Triage in
 * Slack and nothing after them, so the check is "has this event ever been
 * recorded for this recruiter" — asked of the analytics table rather than of a
 * new column, because the answer is already there and a second store of the
 * same fact is a second thing to keep in step.
 */
function activatedOnce(name, recruiter, company, extra = []) {
  const seen = db.prepare(`
    SELECT 1 FROM analytics_events WHERE name = ? AND actor_type = 'recruiter' AND actor_id = ?
    LIMIT 1
  `).get(name, recruiter.id)

  track(name, { actorType: 'recruiter', actorId: recruiter.id })
  if (seen) return

  notifySlack(`Recruiter activated — ${{
    recruiter_first_search: 'First Search',
    recruiter_first_reveal: 'First Reveal',
    recruiter_first_triage: 'First Triage',
  }[name] ?? name}`, [
    `${recruiterName(recruiter)} · ${company?.name ?? 'Unknown company'}`,
    ...extra,
    stamp(),
  ])
}
import db, {
  UPLOAD_DIR,
  countCandidates,
  findCandidateByContact,
  candidatesByIds,
  getCandidate,
  insertCandidate,
  duplicateIdentities,
  insertContactMessage,
  sweepContactMessages,
  listCandidates,
  listCandidatesWithText,
  referencedUploadNames,
  updateCandidate,
} from './db.js'
import {
  TRIAGE,
  addFile,
  chargeableCvs,
  applicantFile,
  blankTriage,
  createDraft,
  deleteTriage,
  draftBytes,
  draftFiles,
  failedFiles,
  getTriage,
  launchReadiness,
  listTriages,
  markReviewed,
  mustOwn,
  pipelineStates,
  removeFile,
  results,
  setJobDescription,
  setTitle,
  triageUploadNames,
} from './triage.js'
import {
  queueDepth,
  requestNextTranche,
  resumeQueue,
  startProcessing,
} from './triageQueue.js'
import {
  CSRF_HEADER,
  clearSessionCookies,
  generateLoginCode,
  issueCsrfToken,
  issueToken,
  newSessionId,
  readSession,
  requireCsrf,
  requireRole,
  setSessionCookie,
  verifyPassword,
} from './auth.js'
import {
  authenticateRecruiter,
  claimRecruiterSession,
  companyWebsite,
  countCompanies,
  createCompany,
  createRecruiter,
  defaultPasswordFor,
  deleteRecruiterCompletely,
  findRecruiterForReset,
  getCompany,
  getRecruiter,
  issueLoginCode,
  sweepLoginCodes,
  issuePasswordReset,
  PASSWORD_RESET_MINUTES,
  listRecruiters,
  photoVersion,
  recruiterDeletionPreview,
  recruiterDisplayName,
  recruiterSessionIsCurrent,
  redeemLoginCode,
  setCompanyWebsite,
  releaseRecruiterSession,
  redeemPasswordReset,
  setRecruiterPassword,
  updateRecruiter,
} from './accounts.js'
import { billingProvider, billingSimulated } from './billing.js'
import {
  candidateThreadCount,
  candidateThreads,
  hideConversation,
  candidateUnreadTotal,
  closeThread,
  createFolder,
  deleteFolder,
  FOLDER_STATUSES,
  folderIndex,
  getFolder,
  isFolderStatus,
  listComments,
  listTags,
  tagIndex,
  listFolders,
  listThread,
  markThreadRead,
  markThreadUnread,
  moveFolder,
  placeCandidate,
  positionBetween,
  recruiterThreads,
  recruiterUnreadByCandidate,
  removeFromFolders,
  renameFolder,
  reopenThread,
  addComment,
  setTags,
  MAX_TAGS,
  TAG_COLOURS,
  sendMessage,
  setFolderStatus,
  threadStatus,
} from './workspace.js'
import {
  appendTurn,
  createSearchChat,
  deleteSearchChat,
  dismissCandidate,
  dismissedCandidateIds,
  getSearchChat,
  listSearchChats,
  renameSearchChat,
  restoreCandidate,
  setChatFolder,
} from './chats.js'
import {
  APP_URL,
  OTP_ECHO,
  sendAvailabilityCheckEmail,
  sendAvailabilityConfirmedEmail,
  sendAvailabilityDeclinedEmail,
  sendCandidateWelcome,
  sendDeactivationEmail,
  sendLoginCode,
  sendMessageEmail,
  sendPasswordReset,
  sendPaymentFailedEmail,
  sendRecruiterUnderReview,
  sendReplyEmail,
  sendRevealNotice,
  sendRevealsEmptyEmail,
  sendSeatExpiryEmail,
  sendTriageEmptyEmail,
} from './notify.js'
import {
  MODEL,
  analyseMatches,
  /* Named directly rather than reached through extractContactDetails: the
     demo Triage never calls a model, so it wants the deterministic reader on
     purpose rather than as a fallback nobody chose. */
  deterministicContact,
  extractContactDetails,
  extractProfileFields,
  generateSummary,
  isConfigured as aiConfigured,
  SUMMARY_MAX_CHARS,
} from './ai.js'
import { track } from './analytics.js'
import { ensureSummary, repairSummaries } from './summary.js'
import {
  PUBLIC_DEMO,
  candidateForToken,
  claimPublicSearch,
  claimedSearchFor,
  clientFingerprint,
  publicSearch,
  recentSearchCount,
  recordDemoRun,
  recordRevealIntent,
  runPublicSearch,
  searchCandidateIds,
  sweepAnonymousDemoArtefacts,
} from './publicDemo.js'
import {
  COMPLIMENTARY_REVEALS,
  COMPLIMENTARY_TRIAGE_CVS,
  CURRENCY,
  SEAT_SELF_SERVE_MAX,
  findRevealPack,
  findTriagePack,
  formatAmount,
  pricingCatalogue,
} from './pricing.js'
import {
  consumeReveal,
  consumeTriageCvs,
  creditReveals,
  creditTriages,
  refundTriageCvs,
  setTriageAllocations,
  triageAllocations,
  triageAllowanceRemaining,
  triageCapacityCheck,
  triageCvsUsed,
  triageWorkspaces,
  triageBalance,
  setSeatPlan,
  grantComplimentaryReveals,
  grantComplimentaryTriage,
  migrateExistingOrganizations,
  quoteSeatPlan,
  allocationRemaining,
  revealAllocations,
  revealBalance,
  companyRevealsUsed,
  seatEntitlement,
  seatUsage,
  seatsExhausted as walletSeatsExhausted,
  setAutoReplenish,
  setRevealAllocations,
  walletOverview,
  setSplitEqually,
  splitsEqually,
  capacitySince,
  seatList,
  resettleSeats,
} from './wallet.js'
import {
  CAPACITY_OPTIONS,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_SLOTS,
  DOCUMENT_SLOT_KEYS,
  DOCUMENT_TYPES,
  EXTRACTED_SLOT_KEYS,
  LEGACY_DOCUMENT_SLOTS,
  MAX_DOCUMENT_BYTES,
  SUPPORTING_EXTENSIONS,
  candidateForRecruiter,
  maskedDisplayName,
} from './schema.js'
import {
  generateCode,
  issueVerificationCode,
  mintProof,
  normalizeDestination,
  proofCovers,
  redeemVerificationCode,
  sweepVerificationCodes,
} from './verification.js'
import {
  activityStatus,
  candidatesBlockingRecruiter,
  confirmActive,
  deactivate,
  deleteCandidateCompletely,
  deleteDocument,
  deletionPreview,
  documentSlotsByCandidate,
  effectiveProfile,
  getDocument,
  hasRevealed,
  listDocuments,
  markCandidateSeen,
  hiddenDueAt,
  pendingCheckin,
  reactivate,
  recordReveal,
  redeemCheckinToken,
  industriesFor,
  revealIndex,
  revealedBy,
  revealedCandidateIds,
  profileCompletion,
  recordScores,
  saveDocument,
  saveExtraction,
  setBlockedCompanies,
  getBlockedCompanies,
  setOverride,
  recordViewEvent,
  viewSummary,
  EXTRACTED_FIELDS,
} from './profiles.js'
import { runCheckinSweep, runSeatExpirySweep } from './checkins.js'
import {
  availabilityStates,
  availabilityToken,
  checkableState,
  requestAvailabilityCheck,
  resolveAvailabilityChecks,
} from './availability.js'
import {
  backfillIntelligence,
  buildIntelligence,
  bumpProfileVersion,
  editCandidateLabel,
  EDITABLE_DIMENSIONS,
  getIntelligence,
  isMatchingRelevantChange,
  MAX_LABEL_WORDS,
  MAX_LABELS_PER_DIMENSION,
} from './matching/intelligence.js'
import {
  getPreferences,
  setPreferences,
  validatePreferences,
} from './matching/preferences.js'
import { runSearch, showMore } from './matching/pipeline.js'
import { getSession } from './matching/session.js'
import { getJob } from './matching/jobProfile.js'
import { assertFileContent, rateLimit, sniffFile } from './security.js'
import { MATCHING } from './matching/config.js'
import {
  EMBEDDING_MODEL,
  allEmbeddings,
  embedQuery,
  isConfigured as embeddingsConfigured,
  profileText,
  rankBySimilarity,
  refreshEmbedding,
} from './embeddings.js'
import { extractText } from './extract.js'
import {
  keywordsFrom,
  normalizeAgainstPool,
  parseJobDescription,
  passesFilters,
  scoreCandidate,
} from './match.js'
import { SKILLS, canonicalize, detectSkills } from './skills.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = express()

const PORT = Number(process.env.PORT) || 5175
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12
/*
 * Abuse ceilings for the candidate's hidden-company list.
 *
 * Not a product limit. The list is as long as the candidate's career needs it
 * to be; these stop one account from writing rows without bound.
 */
const MAX_BLOCKED_COMPANIES = 200
const MAX_COMPANY_NAME_LENGTH = 120

/** Bumped whenever the consent wording changes, so old consents are auditable. */
const CONSENT_VERSION = '2026-08-v2'

// Falling back to a random per-boot secret means sessions do not survive a
// restart, which is the safe failure mode when .env has not been set up.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')

// Not a warning: the app is fully usable without it, just less good at matching.
if (!aiConfigured()) {
  console.log(`\n  ANTHROPIC_API_KEY is not set, so ${MODEL} is not being used.`)
  console.log('  CV reading and match scoring fall back to keyword matching.')
  console.log('  Set it in server/.env to turn on the AI path.\n')
}

if (!embeddingsConfigured()) {
  console.log(`  VOYAGE_API_KEY is not set, so ${EMBEDDING_MODEL} is not being used.`)
  console.log('  Searches shortlist on keyword overlap rather than meaning.\n')
}

/*
 * Behind a proxy, req.secure and req.ip come from headers the proxy sets — and
 * trusting those headers when nothing is in front of the app lets a caller
 * claim any address, which would defeat the rate limiter. Off unless declared.
 */
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY)

/*
 * Credentials are cookies now, so the browser attaches them automatically —
 * including on requests another origin causes. A permissive CORS policy would
 * hand those responses to that origin, so the allow-list is explicit and
 * credentials are only shared with origins we name.
 */
const ALLOWED_ORIGINS = String(process.env.CORS_ORIGINS ?? '')
  .split(',').map((entry) => entry.trim()).filter(Boolean)

app.use(cors({
  origin(origin, callback) {
    // Same-origin and non-browser callers send no Origin at all.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
    return callback(null, false)
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
}))

app.use(express.json({ limit: '2mb' }))

// Minted on the first request so the page always has one to echo back.
app.use((req, res, next) => { issueCsrfToken(res, req); next() })
app.use(requireCsrf)

/**
 * Headers that apply to everything, including uploaded files.
 *
 * `nosniff` is the important one here: without it a browser may ignore the
 * Content-Type we send and guess from the bytes, which turns a stored file into
 * whatever it looks like. The sandbox CSP applies to any document served from
 * this origin, so even if something executable did get stored and rendered, it
 * has no origin to act on and no script to run with.
 */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  next()
})

/*
 * A recruiter account is signed in on one device at a time.
 *
 * The token has to be genuine *and* name the sign-in the account is currently
 * on. Signing in elsewhere replaces that id, so this is where the older device
 * finds out — on its next request, whatever it was doing.
 *
 * A recruiter token from before this existed carries no session id and cannot
 * be told apart from a second copy of itself, so it is refused too. That costs
 * everyone signed in at the time one fresh sign-in, which is the whole price of
 * the rule and only payable once.
 */
const SUPERSEDED = 'Signed out: this account was signed in on another device.'

const recruiterOnly = requireRole(SESSION_SECRET, 'recruiter', (session) => (
  recruiterSessionIsCurrent(session.id, session.sid) ? null : SUPERSEDED
))
const candidateOnly = requireRole(SESSION_SECRET, 'candidate')

/*
 * Limits on the routes a stranger can reach without an account.
 *
 * Sizing is per route, not one global number: an application is a slow,
 * deliberate act and ten an hour is generous, while a sign-in code request is
 * the one endpoint that both confirms an address exists AND sends mail, so it
 * is the tightest. Password and code guessing get their own counters because
 * the cost of a wrong answer there is somebody else's account.
 */
const RATE_MAX = {
  /*
   * Sized for a shared connection, not a single person.
   *
   * A university careers service, a co-working space or any office behind one
   * NAT address is many genuine candidates on one IP — so a limit tuned to
   * "how often would one person apply" locks out a roomful of real candidates
   * and looks, from their side, like the site is broken.
   */
  apply: Number(process.env.RATE_APPLY_MAX ?? 60),
  requestCode: Number(process.env.RATE_CODE_MAX ?? 20),
  verifyCode: Number(process.env.RATE_VERIFY_MAX ?? 30),
  login: Number(process.env.RATE_LOGIN_MAX ?? 30),
  register: Number(process.env.RATE_REGISTER_MAX ?? 10),
  contact: Number(process.env.RATE_CONTACT_MAX ?? 5),
  checkin: Number(process.env.RATE_CHECKIN_MAX ?? 20),
  /*
   * The public JD demo. Tighter than the rest, because it is the only
   * unauthenticated route that runs the matching pipeline — so each call costs
   * real analysis work, and a loop over it is both a scraping attempt and a
   * bill. The demo also keeps a second, slower per-client limit that survives a
   * restart; this one is the fast guard on the route itself.
   */
  demo: Number(process.env.RATE_DEMO_MAX ?? 12),
}

const limits = {
  apply: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: RATE_MAX.apply,
    message: 'Too many applications from this connection. Please try again later.',
  }),
  requestCode: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: RATE_MAX.requestCode,
    message: 'Too many sign-in codes requested. Please wait a few minutes.',
  }),
  verifyCode: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: RATE_MAX.verifyCode,
    message: 'Too many attempts. Please wait a few minutes.',
  }),
  login: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: RATE_MAX.login,
    message: 'Too many sign-in attempts. Please wait a few minutes.',
  }),
  register: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: RATE_MAX.register,
    message: 'Too many company registrations from this connection.',
  }),
  contact: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: RATE_MAX.contact,
    message: 'Too many messages sent. Please try again later.',
  }),
  checkin: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: RATE_MAX.checkin,
  }),
  demo: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: RATE_MAX.demo,
    message: 'Too many demo searches from this connection. Create an account to keep searching.',
  }),
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------- uploads ---

const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`)
    },
  }),
  // Spec §5.2: 5MB per file, enforced server-side as well as in the browser.
  limits: { fileSize: MAX_DOCUMENT_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()

    if (file.fieldname === 'photo') {
      if (!PHOTO_EXTENSIONS.includes(ext)) {
        return cb(new Error(`"${ext}" is not a supported image. Use a JPG, PNG or WebP.`))
      }
      return cb(null, true)
    }

    /*
     * A pile of applicant CVs, arriving as one Triage upload.
     *
     * Kept as its own field rather than reusing the 'cv' slot: that one is a
     * marketplace candidate's own document and is bound to a candidate row,
     * while these belong to the recruiter who received them and must never be
     * confused for consent to join Cursus. Different field, different table,
     * different deletion policy.
     */
    if (file.fieldname === 'cvs') {
      if (!DOCUMENT_EXTENSIONS.includes(ext)) {
        return cb(new Error(`"${ext}" is not a CV we can read. Upload PDF or DOCX files.`))
      }
      return cb(null, true)
    }

    // A job description a recruiter attaches instead of pasting. Read for its
    // text and deleted straight afterwards — it is the recruiter's document,
    // not a candidate's, and nothing here needs to keep it.
    if (file.fieldname === 'jd') {
      if (!DOCUMENT_EXTENSIONS.includes(ext)) {
        return cb(new Error(`Unsupported file type "${ext}". Upload a PDF or DOCX file.`))
      }
      return cb(null, true)
    }

    if (!DOCUMENT_SLOT_KEYS.includes(file.fieldname)) {
      return cb(new Error(`Unexpected upload field "${file.fieldname}".`))
    }

    // §7 — the CV still has to be readable as text; the supporting types also
    // take PNG and JPEG.
    const allowed = allowedFor(file.fieldname)
    if (!allowed.includes(ext)) {
      return cb(new Error(
        `Unsupported file type "${ext}". Upload a ${allowed.map((e) => e.slice(1).toUpperCase()).join(', ')} file.`,
      ))
    }
    cb(null, true)
  },
})

/** What a given upload slot accepts. The CV is the only narrow one. */
function allowedFor(slot) {
  return slot === 'cv' ? DOCUMENT_EXTENSIONS : SUPPORTING_EXTENSIONS
}

/**
 * Runs straight after multer on every upload route.
 *
 * Bundled with the parser rather than added per route, so a new upload endpoint
 * cannot be written that forgets it — the pair is what gets mounted.
 */
const verifyUploads = (req, _res, next) => {
  try {
    /*
     * A bulk upload rejects files, not requests.
     *
     * Everywhere else on the site an upload is one document that the form
     * requires, so a file that is not what it claims should fail the whole
     * request — a candidate application with a fake CV is not an application.
     * A Triage batch is the opposite case: it is a folder somebody dragged in,
     * and Section 10 is explicit that one bad file must not fail the batch. So
     * the array form separates the liars out and lets the route report them
     * per file, while the single and fields forms keep failing closed.
     */
    if (Array.isArray(req.files)) {
      const kept = []
      const rejected = []

      for (const file of req.files) {
        try {
          assertFileContent(file.path, DOCUMENT_EXTENSIONS, { label: 'CV' })
          kept.push(file)
        } catch (error) {
          rejected.push({ name: file.originalname, reason: error.message })
          fs.promises.unlink(file.path).catch(() => {})
        }
      }

      req.files = kept
      req.rejectedUploads = rejected
      return next()
    }

    assertUploadsAreWhatTheyClaim(req)
    next()
  } catch (error) {
    discard(Object.values(req.files ?? {}).flat(), req.file)
    next(error)
  }
}

const applicationUpload = [
  upload.fields([
    { name: 'photo', maxCount: 1 },
    ...DOCUMENT_SLOT_KEYS.map((slot) => ({ name: slot, maxCount: 1 })),
  ]),
  verifyUploads,
]

const photoUpload = [upload.single('photo'), verifyUploads]
const jdUpload = [upload.single('jd'), verifyUploads]

/**
 * A Triage batch: many CVs, one request.
 *
 * Chunked by the browser rather than sent as one enormous body — Section 2.3
 * warns against a single monolithic upload, and the client sends batches of a
 * few dozen so a dropped connection costs one chunk instead of the whole pile.
 * TRIAGE_UPLOAD_CHUNK bounds what any one request may carry; the per-Triage
 * ceiling is enforced on the route, where the running total is known.
 */
const TRIAGE_UPLOAD_CHUNK = Number(process.env.TRIAGE_UPLOAD_CHUNK ?? 40)
const triageUpload = [upload.array('cvs', TRIAGE_UPLOAD_CHUNK), verifyUploads]

/*
 * The same field name, a much smaller ceiling, and its own multer instance.
 *
 * The count limit is multer's, which means the twenty-sixth part is refused
 * while it is still arriving rather than written to disk and deleted after —
 * the difference matters on a route open to anybody. The route checks the
 * number again on its own account, because a middleware limit that is the only
 * limit is one refactor away from not being a limit.
 */
const demoTriageUpload = upload.array('cvs', PUBLIC_DEMO.triageMaxFiles)

function discard(...files) {
  for (const file of files.flat()) {
    if (file) fs.promises.unlink(file.path).catch(() => {})
  }
}

/**
 * Checks what every uploaded file REALLY is, and deletes the lot if any lies.
 *
 * multer's fileFilter can only see the name and the declared Content-Type,
 * both of which the uploader chooses. This runs once the bytes are on disk —
 * the earliest point the question can actually be answered.
 *
 * The file touching disk before validation is safe here because uploads live
 * outside the web root and are only ever served back through an authenticated
 * route; nothing executes them, and a rejected one is removed immediately.
 */
function assertUploadsAreWhatTheyClaim(req) {
  /*
   * multer hands back an ARRAY for .array() and an OBJECT for .fields(). Array
   * uploads are checked file-by-file in verifyUploads above and never reach
   * here; this path is the all-or-nothing one, and reading req.files.photo off
   * an array would silently yield undefined rather than erroring.
   */
  const fieldFiles = req.files ?? {}

  const photo = req.file?.fieldname === 'photo' ? req.file : fieldFiles.photo?.[0]
  const jd = req.file?.fieldname === 'jd' ? req.file : fieldFiles.jd?.[0]

  const checks = [
    ...(photo ? [{ file: photo, allowed: PHOTO_EXTENSIONS, label: 'photo' }] : []),
    ...(jd ? [{ file: jd, allowed: DOCUMENT_EXTENSIONS, label: 'job description' }] : []),
    ...uploadedDocuments(req).map(({ file, slot }) => ({
      file,
      allowed: allowedFor(slot),
      label: slot === 'cv' ? 'CV' : 'document',
    })),
  ]

  for (const { file, allowed, label } of checks) {
    assertFileContent(file.path, allowed, { label })
  }
}

/** Every uploaded document across all slots, as a flat list. */
function uploadedDocuments(req) {
  if (Array.isArray(req.files)) return []
  return DOCUMENT_SLOT_KEYS
    .map((slot) => ({ slot, file: req.files?.[slot]?.[0] }))
    .filter((entry) => entry.file)
}

/**
 * Stored names are server-generated, but resolve and re-check anyway so a
 * malformed row can never reach outside the uploads directory.
 */
function resolveUpload(storedName) {
  if (!storedName) return null
  const filePath = path.resolve(UPLOAD_DIR, storedName)
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null
  return fs.existsSync(filePath) ? filePath : null
}

/**
 * Serves a stored upload with the headers that stop it being active content.
 *
 * The type is taken from the file's own bytes, never from the name or from
 * anything the uploader said, and anything unrecognised is sent as an opaque
 * download. `sandbox` is the line that matters: a document served from this
 * origin gets no script execution and no access to the session, so even a file
 * that slipped past every earlier check cannot act as this site.
 */
function sendUploadedFile(res, filePath, { fileName = null } = {}) {
  const found = sniffFile(filePath)

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")

  if (!found || found.markup) {
    // Never rendered, only saved — the browser is given nothing to interpret.
    res.setHeader('Content-Type', 'application/octet-stream')
    return res.download(filePath, fileName ?? 'download')
  }

  res.setHeader('Content-Type', found.type)
  return res.sendFile(filePath)
}

/** Reads a CV, rejecting files with no usable text layer. */
async function readCv(file) {
  const cvText = await extractText(file.path, file.originalname)
  if (cvText.replace(/\s/g, '').length < 50) {
    throw new HttpError(
      422,
      'Almost no text could be read from that file. If it is a scanned PDF, please upload a text-based version.',
    )
  }
  return cvText
}

// ----------------------------------------------------------------- public ---

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    candidates: countCandidates(),
    companies: countCompanies(),
    // Policy, not secrets: how often a route may be called is something an
    // honest client benefits from knowing, and an attacker learns by trying.
    // Published so the UI and the tests read the real number rather than
    // guessing at one that drifts.
    rateLimits: RATE_MAX,
  })
})

/*
 * The live JD demo on the recruiter landing page.
 *
 * A recruiter with no account pastes a job description and gets real matches
 * from the real pool, masked. This is the only unauthenticated route that runs
 * the matching pipeline, which makes it the one that has to be most careful:
 * every field the browser receives is chosen in publicDemo.js by allowlist, and
 * nothing here can spend a reveal or name a candidate.
 */
app.post('/api/public/demo/search', limits.demo, async (req, res, next) => {
  try {
    const jobDescription = String(req.body?.jobDescription ?? '').trim()

    if (jobDescription.length < PUBLIC_DEMO.minJdLength) {
      throw new HttpError(400, 'Paste a bit more of the role: a sentence or two about '
        + 'the work, the stack and the seniority is enough to match against.')
    }
    if (jobDescription.length > PUBLIC_DEMO.maxJdLength) {
      throw new HttpError(400, 'That job description is longer than this demo accepts.')
    }

    /*
     * The durable half of the rate limit. express-rate-limit holds its counters
     * in memory, so a restart hands everyone a fresh allowance; this one is
     * counted from the searches actually stored and survives that.
     */
    const clientHash = clientFingerprint(req, SESSION_SECRET)
    if (recentSearchCount(clientHash) >= PUBLIC_DEMO.searchesPerWindow) {
      track('demo_search_throttled', { actorType: 'anonymous' })
      throw new HttpError(429, 'You have used the demo searches available on this connection. '
        + 'Create a recruiter account to keep searching.')
    }

    track('demo_search_submitted', { actorType: 'anonymous', length: jobDescription.length })

    const outcome = await runPublicSearch({ jobDescription, clientHash, secret: SESSION_SECRET })

    track('demo_search_completed', {
      actorType: 'anonymous', results: outcome.results.length, considered: outcome.considered,
    })

    res.json(outcome)
  } catch (error) {
    if (!(error instanceof HttpError)) {
      track('demo_search_failed', { actorType: 'anonymous' })
    }
    next(error)
  }
})

/*
 * What the demo will accept, before anybody tries.
 *
 * The composer's placeholder names the CV limit — "up to 25" — and §8 asks that
 * limits live in configuration rather than in interface logic, because a
 * threshold that only exists in the client is a threshold an attacker edits
 * out. So the sentence is built from this rather than from a number typed into
 * a component, and the two cannot drift.
 */
app.get('/api/public/demo/limits', (_req, res) => {
  res.json({
    triageMaxFiles: PUBLIC_DEMO.triageMaxFiles,
    minJdLength: PUBLIC_DEMO.minJdLength,
    maxJdLength: PUBLIC_DEMO.maxJdLength,
  })
})

/*
 * Cursus Triage, for somebody who has not signed up.
 *
 * The other half of the product, demonstrated on the visitor's own documents.
 * The search demo shows the marketplace — people they have never met, masked —
 * and has to be careful about every field it returns. This one is the opposite
 * shape: the CVs are theirs, the applicants are their own, and nothing here
 * touches the candidate pool at all. What has to be careful is the resource
 * cost, because it takes file uploads from anyone on the internet.
 *
 * Three things keep it bounded:
 *
 *  - the deterministic scorer, never the model. The paid product spends a model
 *    call reading the job description once and then ranks the pile with the
 *    same cheap scorer used here; this route does the whole thing that way, so
 *    a demo run costs CPU on a handful of documents and nothing per CV. It is
 *    honestly the same ordering a paid Triage opens with.
 *  - the file ceiling, PUBLIC_DEMO.triageMaxFiles, enforced by multer's own
 *    count limit as well as by the check below — the middleware refuses the
 *    extra parts before they are written to disk.
 *  - the same durable per-connection counter the demo search is throttled by,
 *    so a visitor cannot run the search demo out and then keep going here.
 *
 * Nothing is persisted. No triage row, no applicant row, no ledger entry: the
 * files are read, scored, answered on, and unlinked in the `finally` below
 * whether the request succeeded or threw. A stranger's CVs are the most
 * sensitive thing this server is ever handed and it has no business keeping
 * them a moment longer than the response takes.
 */
app.post(
  '/api/public/demo/triage',
  limits.demo,
  demoTriageUpload,
  verifyUploads,
  async (req, res, next) => {
    const files = Array.isArray(req.files) ? req.files : []
    /* verifyUploads takes the liars out of req.files and unlinks them before
       the handler runs. Reported rather than dropped: "you gave me five and I
       ranked three" needs the other two accounted for, which is the same thing
       the paid route does with preRejected. */
    const rejected = (req.rejectedUploads ?? []).map((entry) => ({
      fileName: entry.name,
      name: null,
      score: null,
      unreadable: true,
      reason: entry.reason,
      matched: [],
      missing: [],
    }))

    try {
      const jobDescription = String(req.body?.jobDescription ?? '').trim()

      if (jobDescription.length < PUBLIC_DEMO.minJdLength) {
        throw new HttpError(400, 'Paste a bit more of the role: a sentence or two about '
          + 'the work, the stack and the seniority is enough to rank against.')
      }
      if (jobDescription.length > PUBLIC_DEMO.maxJdLength) {
        throw new HttpError(400, 'That job description is longer than this demo accepts.')
      }
      if (files.length === 0) {
        throw new HttpError(400, rejected.length > 0
          /* They did attach something; it was not what it claimed to be. Saying
             "attach the CVs" to somebody who just attached five files is the
             kind of refusal that reads as the site being broken. */
          ? 'None of those files could be used: a CV has to be a PDF or a Word document.'
          : 'Attach the CVs you want sorted.')
      }

      /* The durable half of the rate limit, shared with the search demo:
         express-rate-limit counts in memory and forgets on restart. */
      const clientHash = clientFingerprint(req, SESSION_SECRET)
      if (recentSearchCount(clientHash) >= PUBLIC_DEMO.searchesPerWindow) {
        track('demo_triage_throttled', { actorType: 'anonymous' })
        throw new HttpError(429, 'You have used the demo runs available on this connection. '
          + 'Create a recruiter account to keep going.')
      }

      /* Counted before the reading starts, so a run that throws halfway has
         still spent one of this connection's allowance — otherwise the throttle
         is something a visitor can hold open by failing. */
      recordDemoRun({ kind: 'triage', clientHash })
      track('demo_triage_submitted', { actorType: 'anonymous', files: files.length })

      /*
       * The JD read once, deterministically.
       *
       * parseJobDescription is the same parser /api/hr/parse-jd answers with,
       * so what the demo ranks against is what the product would have ranked
       * against had no model been configured — not a simplified stand-in.
       */
      const profile = parseJobDescription(jobDescription)
      const criteria = {
        title: profile.title ?? '',
        jobDescription,
        requiredSkills: profile.requiredSkills ?? [],
        preferredSkills: profile.preferredSkills ?? [],
        keywords: profile.keywords ?? keywordsFrom(jobDescription),
      }

      /*
       * Read in sequence rather than all at once. Twenty-five PDFs opened in
       * parallel is twenty-five extractor processes for one anonymous request;
       * the paid pipeline bounds this with TRIAGE.parseConcurrency and the
       * demo, which nobody is waiting on a queue for, simply waits.
       */
      const rows = []
      for (const [index, file] of files.entries()) {
        const text = await extractText(file.path, file.originalname).catch(() => null)

        /*
         * A scan has no text layer. Reported as unreadable rather than scored
         * at zero — §10 of the Triage brief asks that a file we could not read
         * says so, because "we could not read this" and "this is a poor match"
         * are different answers and only one of them is about the candidate.
         */
        if (!text || text.trim().length < 40) {
          rows.push({
            fileName: file.originalname,
            name: null,
            score: null,
            unreadable: true,
            reason: 'No readable text: this looks like a scan or an image-only PDF.',
            matched: [],
            missing: [],
            order: index,
          })
          continue
        }

        const contact = deterministicContact(text)
        const scored = scoreCandidate(
          { cv_text: text, current_title: null, desired_role: null, notes: null, skills: [] },
          criteria,
        )

        rows.push({
          fileName: file.originalname,
          /* Their own applicant, so their own name — there is nothing to mask
             here. Falls back to the filename, which is what the paid results
             table does when a CV does not state a name it can find. */
          name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null,
          location: contact.city ?? null,
          /*
           * Used to order the pile and then discarded — never serialised.
           *
           * Section 3 forbids showing the preliminary pass as a score and
           * Section 4 forbids inventing a separate Triage percentage; the paid
           * results view honours both by never letting prelim_score leave the
           * server (see applicantView in triage.js). This route runs ONLY the
           * preliminary pass, so publishing its number as a "match" percentage
           * would be exactly the thing both sections rule out — and it would be
           * a different measure from the one Search shows under the same word.
           *
           * The visitor gets what the first pass actually knows: an order, and
           * the requirements each CV does and does not evidence.
           */
          sortKey: scored.score,
          components: scored.breakdown.length,
          /*
           * What the CV evidences, and what it does not — the two things a
           * recruiter reads a Triage row for.
           *
           * Required first, then preferred, rather than the required list
           * alone. parseJobDescription buckets by heading and works on lines,
           * so a job description written as one paragraph with "Preferred:"
           * somewhere in it puts every skill in the preferred bucket — and a
           * row reporting only the required ones would then show a score with
           * no evidence beside it at all. Both buckets are the honest answer
           * to "why this number".
           */
          matched: [...scored.matchedRequired, ...scored.matchedPreferred].slice(0, 6),
          missing: [...scored.missingRequired, ...scored.missingPreferred].slice(0, 4),
          unreadable: false,
          reason: null,
          /* Upload order, kept so ties resolve the way the paid preliminary
             pass resolves them: by the order the recruiter handed them over. */
          order: index,
        })
      }

      const scoredRows = rows.filter((row) => !row.unreadable)

      /*
       * A brief the deterministic reader could make nothing of.
       *
       * parseJobDescription, keywordsFrom and the title tokeniser are all
       * ASCII-only, so a job description written in Hebrew, Arabic or any other
       * non-Latin script yields no requirements, no keywords and no title —
       * scoreCandidate then has no components to weigh and returns zero for
       * every CV. Ordering that is ordering nothing, and presenting it as a
       * ranking would be the demo's most confident lie. Said plainly instead.
       */
      const readable = scoredRows.some((row) => row.components > 0)
      if (scoredRows.length > 0 && !readable) {
        throw new HttpError(400, 'We could not read any requirements out of that brief. '
          + 'Name the skills and the seniority the role needs (in English, which is the '
          + 'only language this demo reads) and we can rank against them.')
      }

      const ranked = scoredRows
        .sort((a, b) => b.sortKey - a.sortKey || a.order - b.order)
        .map((row, index) => {
          const { sortKey, components, order, ...shown } = row
          return { ...shown, rank: index + 1 }
        })

      /* Both kinds of "not scored" in one list: a file we could not read, and a
         file we would not accept. The visitor cares that it is not in the
         ranking and why; which of our two checks stopped it is our business. */
      const unreadable = [...rows.filter((row) => row.unreadable), ...rejected]

      track('demo_triage_completed', {
        actorType: 'anonymous', ranked: ranked.length, unreadable: unreadable.length,
      })

      res.json({
        ranked,
        unreadable,
        /* Everything handed over, including what was refused — otherwise the
           note says "your 3 CVs" to somebody who attached five. */
        considered: files.length + rejected.length,
        /* Said by the server, like every other limit the demo advertises, so
           the sentence in the composer cannot drift from the rule. */
        maxFiles: PUBLIC_DEMO.triageMaxFiles,
      })
    } catch (error) {
      if (!(error instanceof HttpError)) {
        track('demo_triage_failed', { actorType: 'anonymous' })
      }
      next(error)
    } finally {
      /* Always. The bytes have been read into memory by then; what is on disk
         is a copy of a stranger's CV with no row anywhere pointing at it. */
      await Promise.all(files.map((file) => fs.promises.unlink(file.path).catch(() => {})))
    }
  },
)

/*
 * The conversion point: a logged-out recruiter pressed Reveal.
 *
 * Deliberately reveals nothing. It records which candidate they wanted so the
 * workspace can offer that person again after they register, and answers with
 * the terms of the offer rather than with any candidate data. The client shows
 * the sign-up gate on the strength of this.
 */
app.post('/api/public/demo/reveal-intent', limits.demo, (req, res, next) => {
  try {
    const record = publicSearch(req.body?.searchToken)
    if (!record) throw new HttpError(404, 'That search has expired. Run it again to continue.')

    /* Resolved against the candidates this search returned, so a token from
       another search — or a guess — matches nothing. */
    const candidateId = candidateForToken({
      searchToken: record.token,
      token: req.body?.candidateToken,
      candidateIds: searchCandidateIds(record.session_id),
      secret: SESSION_SECRET,
    })
    if (!candidateId) throw new HttpError(404, 'That candidate is not part of this search.')

    recordRevealIntent({ token: record.token, candidateId })
    track('demo_reveal_clicked', { actorType: 'anonymous', jobId: record.job_id })

    res.json({
      signupRequired: true,
      freeReveals: COMPLIMENTARY_REVEALS,
      // The other half of the welcome, so the gate can offer what an account
      // actually comes with rather than half of it.
      freeTriageCvs: COMPLIMENTARY_TRIAGE_CVS,
      // Said by the server so the offer in the gate and the credit that is
      // actually granted cannot drift apart.
      creditCardRequired: false,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Ends the session properly.
 *
 * With the token in localStorage the client could forget it on its own. An
 * httpOnly cookie can only be cleared by the server, so signing out has to be a
 * request — and that is the better design anyway: it is now a thing that
 * happens, rather than a thing the browser was trusted to do.
 */
app.post('/api/auth/sign-out', (req, res) => {
  /*
   * A recruiter also gives the account back, so the token cannot be replayed
   * after the cookie is gone — clearing a cookie only asks the browser to
   * forget, and anything that copied the token first would not have to.
   *
   * Read without requireRole, because signing out has to work from a session
   * this server has already superseded: that device is holding a token it will
   * never be allowed to use again, and refusing to let it press Sign out would
   * strand the shell on screen. releaseRecruiterSession checks whether this is
   * really the live session before ending it.
   */
  const session = readSession(SESSION_SECRET, 'recruiter', req)
  if (session) releaseRecruiterSession(session.id, session.sid)

  clearSessionCookies(res, req)
  res.json({ ok: true })
})

/**
 * Public counts for the landing page.
 *
 * Real figures, read live. The temptation with social proof is to seed it —
 * but a number on a landing page is a factual claim to every visitor who reads
 * it, and one that can be checked the moment somebody joins and sees an empty
 * marketplace. The UI hides the banner rather than showing a small number, so
 * the choice is between telling the truth and saying nothing.
 */
app.get('/api/stats', (_req, res) => {
  // Everyone who joined: a CV is required to have an account at all.
  const candidates = countCandidates()
  const companies = countCompanies()

  /*
   * Whether the numbers are worth showing is decided here, not in the browser,
   * so it can be changed without rebuilding the client. Set STATS_MIN=0 to
   * show them from the first sign-up.
   */
  const minimum = Number(process.env.STATS_MIN ?? 25)

  res.json({
    candidates,
    companies,
    minimum,
    ready: candidates >= minimum && companies >= 1,
  })
})

app.get('/api/skills', (_req, res) => {
  res.json({ skills: SKILLS.map(({ name, category }) => ({ name, category })) })
})

/**
 * Contact form on the public footer pages.
 *
 * Stored before any delivery is attempted: no mail provider is wired up yet,
 * and an enquiry that only exists in a log line is an enquiry that gets lost.
 * Unauthenticated by necessity — that is the point of a contact page — so it is
 * length-capped here and needs the same rate limiting as the apply route before
 * this faces the internet.
 */
app.post('/api/contact', limits.contact, (req, res) => {
  const name = trimOrNull(req.body?.name)
  const email = trimOrNull(req.body?.email)
  const message = trimOrNull(req.body?.message)
  // §12 — optional server-side: the form requires it, but a missing reason is
  // no reason to lose somebody's message.
  const reason = trimOrNull(req.body?.reason)

  if (!name || !email || !message) {
    throw new HttpError(400, 'Please fill in your name, your email address and a message.')
  }
  if (!email.includes('@')) throw new HttpError(400, 'That email address does not look right.')
  if (message.length > 5000) throw new HttpError(400, 'Please keep your message under 5000 characters.')
  if (reason && reason.length > 120) throw new HttpError(400, 'That reason is not one of the options.')

  insertContactMessage({ name, email, reason, message })

  /*
   * The enquiry is stored, not printed.
   *
   * This used to log the sender's name, email address and the first 120
   * characters of their message on every submission — which puts personal data
   * wherever the process output goes, typically a file or a log service nobody
   * has assessed, kept for however long that system keeps things and readable
   * by anyone who can read logs. The message is in the database, which is where
   * it was always meant to be read from.
   *
   * What is left says one arrived, so an operator watching the console can see
   * the route working without the console becoming a second copy of the data.
   */
  console.log(`  [contact] enquiry received${reason ? ` (${reason})` : ''}`)

  // Same trick as the verification codes above: keeps a table nobody prunes
  // from growing without bound, at the cost of one indexed DELETE.
  sweepContactMessages()

  res.status(201).json({ ok: true })
})

// -------------------------------------------------- sign-up verification ---

/**
 * Sends a code to an email address or phone number nobody has claimed yet.
 *
 * Unauthenticated by necessity: it is used before an account exists. That makes
 * it a way to send mail to an arbitrary address, so it is rate limited on the
 * same bucket as sign-in codes and says nothing about whether the destination
 * is already registered — an enumeration oracle here would leak who has an
 * account to anyone who cared to ask.
 */
app.post('/api/verify/request', limits.requestCode, async (req, res, next) => {
  try {
    const channel = String(req.body?.channel ?? '')
    const destination = String(req.body?.destination ?? '').trim()

    if (channel !== 'email' && channel !== 'phone') {
      throw new HttpError(400, 'Choose whether to verify an email address or a phone number.')
    }
    if (channel === 'email' && !looksLikeEmail(destination)) {
      throw new HttpError(400, 'That email address does not look right.')
    }
    if (channel === 'phone' && !normalizeDestination('phone', destination)) {
      throw new HttpError(400, 'That phone number does not look right.')
    }

    const code = generateCode()
    const { expiresInMinutes } = issueVerificationCode({
      channel, destination, code, secret: SESSION_SECRET,
    })
    await sendLoginCode({ channel, destination, code, expiresInMinutes })

    // Cheap to do here, and it keeps the table from growing without bound
    // without needing a scheduler nobody has set up yet.
    sweepVerificationCodes()

    res.json({
      sent: true,
      channel,
      maskedTo: maskContact(destination, channel),
      expiresInMinutes,
      // Development convenience only; see server/src/notify.js.
      ...(OTP_ECHO ? { devCode: code } : {}),
    })
  } catch (error) {
    next(error)
  }
})

/** Exchanges a correct code for a short-lived proof the sign-up route accepts. */
app.post('/api/verify/confirm', limits.verifyCode, (req, res, next) => {
  try {
    const channel = String(req.body?.channel ?? '')
    const destination = String(req.body?.destination ?? '').trim()
    const code = String(req.body?.code ?? '').trim()

    if (channel !== 'email' && channel !== 'phone') throw new HttpError(400, 'Unknown channel.')

    const result = redeemVerificationCode({ channel, destination, code, secret: SESSION_SECRET })
    if (!result.ok) {
      const message = {
        'no-code': 'Request a code first.',
        expired: 'That code has expired. Request a new one.',
        'too-many-attempts': 'Too many incorrect attempts. Request a new code.',
      }[result.reason] ?? 'That code is not correct.'
      throw new HttpError(400, message)
    }

    res.json({ verified: true, proof: mintProof({ channel, destination, secret: SESSION_SECRET }) })
  } catch (error) {
    next(error)
  }
})

/**
 * Both contact details, proved.
 *
 * Shared by the two sign-up routes so neither can be relaxed on its own. The
 * proof has to name the address actually being registered — checking only that
 * a proof is well-formed would let one verified address stand in for any other.
 */
function assertContactsVerified(body, { email, phone }) {
  const checks = [
    { channel: 'email', destination: email, proof: body?.emailProof, label: 'email address' },
    { channel: 'phone', destination: phone, proof: body?.phoneProof, label: 'phone number' },
  ]

  for (const { channel, destination, proof, label } of checks) {
    if (!proofCovers({ proof, channel, destination, secret: SESSION_SECRET })) {
      throw new HttpError(400, `Please verify your ${label} before continuing.`)
    }
  }
}

/**
 * Clause 1 of the Terms, actually applied.
 *
 * "You must be at least 18 years old" has been in the Terms since they were
 * written, and until now nothing asked and nothing checked — the Privacy
 * Policy's matching promise that we do not knowingly create accounts for people
 * under 18 was a statement no code could have made true or false.
 *
 * The affirmation is the person's own. There is no date of birth on any form
 * and no age anywhere in the schema, deliberately: asking everybody to prove
 * their age to sit above a threshold almost all of them clear is a great deal
 * of identity data collected to catch very few people. What this does is make
 * the declaration explicit, refuse the account without it, and record when it
 * was made and against which version of the wording.
 */
function assertConsent(body) {
  if (parseBoolean(body?.consent) !== true) {
    throw new HttpError(
      400,
      'Please confirm you are 18 or over and agree to the Terms of Service and Privacy Policy.',
    )
  }
}

app.post('/api/candidates', limits.apply, applicationUpload, async (req, res, next) => {
  const documents = uploadedDocuments(req)
  const photoFile = req.files?.photo?.[0]
  const everyFile = [...documents.map((d) => d.file), photoFile]

  const cvEntry = documents.find((entry) => entry.slot === 'cv')
  if (!cvEntry) {
    discard(everyFile)
    return res.status(400).json({ error: 'Attach your CV as a PDF or DOCX file.' })
  }

  try {
    const profile = readProfileFields(req.body, { require: true })
    // Both contact details are proved before an account exists. Checked here,
    // after the fields are validated and before anything is written, so a
    // half-created account can never be left behind by a failure either side.
    assertContactsVerified(req.body, { email: profile.email, phone: profile.phone })
    // §5 + §17 — validated before anything is written, so a rejected
    // preference cannot leave a half-created account behind.
    assertConsent(req.body)

    /*
     * Read before the guard, so nothing waits between the check and the insert.
     *
     * readCv parses a PDF off disk. With it below the lookup, the await handed
     * the event loop back for a few hundred milliseconds between "no row
     * exists" and "insert a row" — long enough for a second request holding the
     * same replayable proof to pass the same check, and both to insert. One
     * process, one thread, and still a race, because the gap is an await rather
     * than a lock.
     *
     * better-sqlite3 is synchronous, so with no await between them the check
     * and the insert cannot be interleaved by anything.
     */
    const preferences = readPreferenceInput(req.body)
    const cvText = await readCv(cvEntry.file)

    /*
     * One identity, one candidate row.
     *
     * There was no check here at all, and it is the whole of the bug people
     * reported as "it forgot my profile". The email column has no UNIQUE
     * constraint, so a second application on an address that already had an
     * account simply inserted another row — and the two paths that bind a
     * session to a row disagree about which row an identity means: applying
     * binds to the id it just inserted, while signing in resolves to the NEWEST
     * matching row. They agree only while exactly one row exists.
     *
     * So: apply, sign out, come back to the site, meet the application form
     * again because nothing on it knows you have an account, fill it in — and
     * from that moment every sign-in lands on the new empty row while the
     * original, holding the CV, the documents, the messages, the reveals and
     * the blocked companies, is unreachable by any lookup in the codebase.
     *
     * Refused rather than merged. The contact is proved, so this IS the account
     * holder, and signing them in would be defensible — but the form they just
     * filled in would then silently overwrite a profile they may not have meant
     * to replace, and there is no undo for that. Sending them to sign in costs
     * one step and destroys nothing.
     */
    const byEmail = findCandidateByContact(profile.email)
    const byPhone = profile.phone ? findCandidateByContact(profile.phone) : null

    if (byEmail || byPhone) {
      /*
       * Named, because "those details" is not enough to act on.
       *
       * Two people share a household phone, or somebody mistypes one digit into
       * a number that happens to be in use: told only that a profile exists,
       * they cannot tell which of the two fields to change, and "you already
       * have a profile" is not even true. Saying which one collided makes the
       * next step obvious and stops the message asserting something we do not
       * know.
       *
       * Both, when both collide — which is the ordinary case of a person
       * re-applying, and the one where "sign in" really is the answer.
       */
      const both = byEmail && byPhone
      const what = both
        ? 'That email address and phone number are'
        : byEmail ? 'That email address is' : 'That phone number is'

      throw new HttpError(
        409,
        `${what} already on a Cursus profile. `
        + (both || byEmail
          ? 'Sign in to open it — you can change anything on it from there, including your CV.'
          : 'Sign in with it to open that profile, or use a different number here.'),
      )
    }

    const id = insertCandidate({
      /* The optional three, for the INSERT's named parameters. readProfileFields
         omits them when the request did not carry them — which is right for an
         update and impossible for an insert, where every column has to be
         bound. Before the spread, so anything that WAS sent wins. */
      middle_name: null,
      availability: null,
      notes: null,
      ...profile,
      years_experience: null,
      current_title: null,
      desired_role: null,
      file_name: cvEntry.file.originalname,
      stored_name: cvEntry.file.filename,
      file_size: cvEntry.file.size,
      photo_name: photoFile?.filename ?? null,
      cv_text: cvText,
      skills: detectSkills(cvText),
      detected_years: null,
      created_at: new Date().toISOString(),
    })

    await storeDocuments(id, documents)
    applyIntakeExtras(id, req.body)
    writePreferences(id, preferences, { openToAll: true, tags: [] })

    // Extraction is slow enough to matter on a form submit, so it runs after the
    // response. The profile page shows "reading your CV" until it lands.
    void runExtraction(id, cvText)

    /*
     * Welcome, and the acquisition line in Slack.
     *
     * Both after the profile is written and neither awaited: a candidate whose
     * account exists must not be told the sign-up failed because a mailbox was
     * slow, and the response is what they are waiting for.
     */
    track('candidate_signed_up', { actorType: 'candidate', actorId: id })
    sendCandidateWelcome({ to: profile.email, name: profile.first_name }).catch(() => {})
    notifySlack('New candidate signup', [
      `${profile.name} · ${profile.email}`,
      profile.location ?? '',
      stamp(),
    ])

    res.status(201).json({
      id,
      documents: documents.length,
      charactersRead: cvText.length,
      account: { email: profile.email, phone: profile.phone },
      /*
       * Signed in on the spot, so applying leads to their account rather than
       * to a sign-in page asking them to prove they are the person who filled
       * in the form a second ago.
       *
       * Bound to the id just inserted. That used to be a hazard — an
       * application on an address that already existed opened the new profile
       * it created and could not reach the older one — and is now simply
       * accurate: the route above refuses to create a second row for a contact
       * that already has one, so the id just inserted is the only row this
       * identity has.
       */
      token: startSession(res, req, 'candidate', id),
    })
  } catch (error) {
    discard(everyFile)
    next(error)
  }
})

/** Saves each uploaded slot and returns the filenames it replaced. */
/**
 * Whether this recruiter's employer is one the candidate asked not to be seen by.
 *
 * The blocklist was applied on the two search paths and nowhere else, which
 * made it a filter on discovery rather than a control over access: a recruiter
 * at a blocked company who held the candidate's id — from a colleague, an
 * earlier search run before the block was added, a folder, or simply by
 * counting — could still open the profile, spend a reveal and receive the name,
 * email, phone, links, photograph and documents.
 *
 * That is the one control the product tells candidates to rely on to hide from
 * their current employer, so it has to hold at the point of access and not only
 * at the point of listing. Checked per request rather than cached: somebody who
 * adds a blocker should be out of reach on the next click, not the next search.
 */
function blockedFromCandidate(recruiterId, candidateId) {
  return candidatesBlockingRecruiter(recruiterId).has(candidateId)
}

/**
 * The same refusal, as middleware, for every recruiter route that names a
 * candidate in its path.
 *
 * Four routes used to carry this check written out by hand, and eight more that
 * needed it did not have it — team notes, tags and the whole of messaging among
 * them. A guard that has to be remembered is a guard that gets forgotten, and
 * the way that failure presents is a candidate being readable by the one
 * employer they asked to be hidden from.
 *
 * Running before the handler rather than inside it also settles the reveal
 * route's ordering question for good: nothing can be charged for a request that
 * never reaches the code that charges.
 *
 * A candidate id that matches nobody passes through, so a missing record still
 * gets the route's own 404 rather than this one.
 */
function refuseIfBlocked(paramName = 'id') {
  return (req, res, next) => {
    const candidateId = Number(req.params[paramName])
    if (Number.isInteger(candidateId) && blockedFromCandidate(req.session.id, candidateId)) {
      return res.status(404).json({ error: BLOCKED_MESSAGE })
    }
    return next()
  }
}

/** The body-carried twin, for routes that name the candidate in their payload. */
function refuseBlockedId(req, candidateId) {
  if (blockedFromCandidate(req.session.id, candidateId)) {
    throw new HttpError(404, BLOCKED_MESSAGE)
  }
}

/** The refusal, worded the same way wherever it is raised. */
const BLOCKED_MESSAGE = 'This candidate is not available to your organization.'

/**
 * The company a recruiter belongs to.
 *
 * Reveals are company-scoped, so this is asked for on every path that decides
 * what a recruiter may see. Resolved from the row rather than carried in the
 * token: a token outlives a change of employer, and the answer must not.
 */
function companyIdFor(recruiterId) {
  return getRecruiter(recruiterId)?.company_id ?? null
}

/**
 * Starts a session: sets the httpOnly cookie the browser will use, and returns
 * the token for callers that authenticate with a Bearer header instead.
 *
 * Both exist on purpose. The browser never touches the returned value — its
 * session lives in a cookie no script can read — while scripts and API clients
 * carry the token deliberately, where there is no ambient authority to steal.
 */
function startSession(res, req, role, id) {
  /*
   * A recruiter sign-in names itself and claims the account, which is what
   * ends any session already running elsewhere. Written before the token is
   * issued: if the write fails there is no token to have been trusted.
   */
  const sid = role === 'recruiter' ? claimRecruiterSession(id, newSessionId()) : undefined

  const token = issueToken(SESSION_SECRET, { role, id, sid }, SESSION_HOURS)
  setSessionCookie(res, req, { role, token, hours: SESSION_HOURS })
  return token
}

const EXTRACTED_SLOTS = new Set(EXTRACTED_SLOT_KEYS)

async function storeDocuments(candidateId, documents) {
  const replaced = []

  for (const { slot, file } of documents) {
    /*
     * §2, §3.1 — every matching-relevant document is read, not just the CV.
     *
     * A cover letter or recommendation routinely carries what a CV leaves out:
     * why someone moved, what they actually led, a language nobody listed.
     * Extraction is best-effort per document — an unreadable extra must never
     * fail an application, so a failure stores the file with no text and the
     * profile is simply built from the rest.
     */
    let text = null
    if (EXTRACTED_SLOTS.has(slot)) {
      text = await extractText(file.path, file.originalname).catch(() => null)
    }

    const previous = saveDocument({
      candidateId,
      slot,
      fileName: file.originalname,
      storedName: file.filename,
      fileSize: file.size,
      mimeType: file.mimetype,
      extractedText: text,
    })

    if (previous) replaced.push(previous)
  }

  return replaced
}

/**
 * Intake fields that live on the candidate row or in their own table.
 *
 * Every field here is written only when the request actually carried it.
 *
 * It used to write all four unconditionally, which meant an edit that did not
 * mention them cleared them: parseBoolean(undefined) is null and
 * trimOrNull(undefined) is null, and those nulls went straight into the UPDATE.
 * A candidate who had answered "no" to relocation, saved a new phone number
 * from a client that did not send the relocation field, and came back to find
 * the answer gone was not imagining it. `blockedCompanies` below always had the
 * guard; the rest did not, and the asymmetry was the bug.
 *
 * A key that is present but empty still means something — an emptied Notice
 * period is a real edit — so this tests for absence, not for falsiness.
 */
function applyIntakeExtras(candidateId, body) {
  const changes = {}

  if (body.openToRelocation !== undefined) {
    const relocation = parseBoolean(body.openToRelocation)
    changes.open_to_relocation = relocation === null ? null : (relocation ? 1 : 0)
  }

  if (body.capacity !== undefined) {
    const capacity = trimOrNull(body.capacity)
    changes.capacity = capacity && CAPACITY_OPTIONS.includes(capacity) ? capacity : null
  }

  if (body.noticePeriod !== undefined) changes.notice_period = trimOrNull(body.noticePeriod)
  if (body.preferredRegions !== undefined) changes.preferred_regions = trimOrNull(body.preferredRegions)

  if (parseBoolean(body.consent)) {
    changes.consent_at = new Date().toISOString()
    changes.consent_version = CONSENT_VERSION
  }

  // updateCandidate is a no-op on an empty object, but saying so here is
  // cheaper than reading that to find out.
  if (Object.keys(changes).length > 0) updateCandidate(candidateId, changes)

  if (body.blockedCompanies !== undefined) {
    setBlockedCompanies(candidateId, splitList(body.blockedCompanies))
  }
}

/**
 * §5 — reads and VALIDATES opportunity preferences without writing anything.
 *
 * Separate from the write on purpose. This throws for an invalid combination,
 * and it has to be called before the candidate row exists — validating after
 * the insert would reject the request while leaving a half-made account behind,
 * which is precisely the partial-ingestion state §17 rules out.
 *
 * Absent fields inherit rather than reset: a client that does not yet know
 * about this control must not silently reopen a candidate to everything they
 * declined.
 */
function readPreferenceInput(body, existing = null) {
  if (body.openToAllOpportunities === undefined && body.interestTags === undefined) return null

  /*
   * Three cases, not two. Absent inherits. A value that reads as yes or no is
   * the answer. A value that reads as neither — an empty string, a word we do
   * not recognise — inherits as well, because `!== false` used to turn every
   * unparseable value into "open to everything", which is the widest possible
   * reading of a request we could not understand.
   */
  const sent = body.openToAllOpportunities === undefined
    ? null
    : parseBoolean(body.openToAllOpportunities)

  const openToAll = sent === null ? (existing?.openToAll ?? true) : sent

  const tags = body.interestTags === undefined
    ? (existing?.tags ?? []).map((tag) => tag.raw)
    : splitList(body.interestTags)

  return validatePreferences({ openToAll, tags })
}

/** Writes validated preferences. Returns whether anything actually moved. */
function writePreferences(candidateId, valid, before) {
  if (!valid) return false

  setPreferences(candidateId, valid)

  return before.openToAll !== valid.openToAll
    || JSON.stringify(before.tags.map((tag) => tag.raw)) !== JSON.stringify(valid.tags)
}

/** Runs the Claude extraction and masking pass, then records the outcome. */
async function runExtraction(candidateId, cvText) {
  try {
    const extraction = await extractProfileFields(cvText)
    saveExtraction(candidateId, extraction)
    track('cv_extraction_completed', {
      actorType: 'candidate', actorId: candidateId,
      source: extraction.source, skills: extraction.skills.length,
    })
  } catch (error) {
    console.warn(`  extraction failed for candidate ${candidateId}: ${error.message}`)
    track('cv_extraction_failed', { actorType: 'candidate', actorId: candidateId, error: error.message })
  }

  /*
   * §10 Path 3 — the candidate who wrote nothing and pressed nothing.
   *
   * Runs here because this is the point at which the CV has been read and the
   * employment history is known, which is what the sanitiser needs to recognise
   * the employers to abstract. Awaited, so the two stages below see the profile
   * in its final state rather than racing it.
   *
   * Guaranteed to leave the summary either sanitised or untouched, never
   * half-written: ensureSummary writes once, at the end, or not at all.
   */
  try {
    await ensureSummary(candidateId, { cvText })
  } catch (error) {
    console.warn(`  summary could not be settled for candidate ${candidateId}: ${error.message}`)
    track('summary_failed', { actorType: 'candidate', actorId: candidateId, error: error.message })
  }

  // After extraction, so the vector is built from the structured profile rather
  // than raw CV text alone.
  await runEmbedding(candidateId)

  // §3.2 — Stage B. Turns the freshly extracted facts into the reusable
  // multi-label intelligence every future search reads instead of the CV.
  runIntelligence(candidateId)
}

/**
 * §16 — builds the profile intelligence for the candidate's current version.
 *
 * Isolated failure by design: a candidate whose interpretation could not be
 * built is still a candidate, and still retrievable on their embedding and
 * structured fields. Losing them from search entirely because one stage threw
 * would be a far worse outcome than a thinner set of labels.
 */
function runIntelligence(candidateId) {
  try {
    const built = buildIntelligence(candidateId)
    track('profile_intelligence_built', {
      actorType: 'candidate', actorId: candidateId,
      labels: built.labels.length, metrics: built.metrics.length, version: built.version,
    })
  } catch (error) {
    console.warn(`  profile intelligence failed for candidate ${candidateId}: ${error.message}`)
  }
}

/**
 * Builds or refreshes the candidate's search vector. Runs after the response,
 * like extraction: a recruiter's search is what needs this, not the candidate
 * waiting on a form submit.
 */
async function runEmbedding(candidateId) {
  if (!embeddingsConfigured()) return

  try {
    const candidate = getCandidate(candidateId)
    if (!candidate) return

    const outcome = await refreshEmbedding(
      candidateId,
      profileText(candidate, effectiveProfile(candidateId)),
    )
    if (outcome.status === 'stored') {
      track('candidate_embedded', { actorType: 'candidate', actorId: candidateId })
    }
  } catch (error) {
    // A missing vector costs recall on one candidate; it is not worth failing
    // anything else over.
    console.warn(`  embedding failed for candidate ${candidateId}: ${error.message}`)
  }
}

/** Shared by the application form and the candidate's own edit form. */
function readProfileFields(body, { require: required }) {
  const firstName = capitalizeName(body.firstName)
  const middleName = capitalizeName(body.middleName)
  const lastName = capitalizeName(body.lastName)
  const email = String(body.email ?? '').trim()
  const phone = String(body.phone ?? '').trim()

  if (required || firstName) {
    if (!firstName) throw new HttpError(400, 'First name is required.')
  }
  if (required || lastName) {
    if (!lastName) throw new HttpError(400, 'Last name is required.')
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'A valid email address is required.')
  }

  /*
   * Nine digits, not seven — the number has to be one they can sign in with.
   *
   * This accepted seven while phoneKey (db.js) needs nine to build a lookup key
   * at all, so an eight-digit number registered happily and then resolved to
   * nothing for ever: request-code answered 404, the sign-in page read that as
   * "no account exists" and offered to create one, and following that offer is
   * what produced a second row for a person who already had one. The looser
   * validation was not permissive, it was a trapdoor.
   *
   * Still only a digit count, because formats vary by country.
   */
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) {
    throw new HttpError(400, 'A valid phone number is required.')
  }

  /*
   * City is required, and it is free text.
   *
   * It used to be a dropdown of Israeli cities with an "Other" escape, which
   * asked everyone outside that list to describe themselves as an exception.
   * Matching filters on the string either way, so the list bought nothing the
   * free field does not.
   */
  const location = trimOrNull(body.location)
  if (!location) throw new HttpError(400, 'Your city is required.')
  if (location && location.length > 80) {
    throw new HttpError(400, 'That city name is too long.')
  }

  /*
   * Rejected rather than silently truncated.
   *
   * This is the candidate's own writing about themselves. Quietly cutting it
   * and saving the remainder would show them a profile they did not write, and
   * they would have no way to tell it had happened. The form caps the field, so
   * reaching this is a paste past the limit or a direct API call — both of which
   * deserve to be told.
   */
  const notes = trimOrNull(body.notes)
  if (notes && notes.length > SUMMARY_MAX_CHARS) {
    throw new HttpError(
      400,
      `Please keep your professional summary to ${SUMMARY_MAX_CHARS} characters; `
      + `yours is ${notes.length}.`,
    )
  }

  /*
   * The optional three are written only when the request carried them.
   *
   * They used to be written unconditionally, so a save that did not mention
   * them cleared them — the same shape of bug applyIntakeExtras had, and it
   * matters more here now that `notes` is the Professional Summary and is
   * generated for people who never type one. A recruiter-facing summary that
   * disappears because the candidate corrected their phone number is not a
   * summary anybody can rely on.
   *
   * The required fields stay unconditional: they are validated above and a
   * request without them has already been refused.
   */
  const fields = {
    name: [firstName, middleName, lastName].filter(Boolean).join(' '),
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    location,
  }

  if ('middleName' in body) fields.middle_name = middleName || null
  if ('availability' in body) fields.availability = trimOrNull(body.availability)
  if ('notes' in body) fields.notes = notes

  return fields
}

// -------------------------------------------------------- candidate auth ---

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim())
}

function maskContact(value, channel) {
  const text = String(value ?? '')
  if (channel === 'email') {
    const [user, domain] = text.split('@')
    const head = user.slice(0, 2)
    return `${head}${'•'.repeat(Math.max(user.length - 2, 1))}@${domain}`
  }
  return `${'•'.repeat(Math.max(text.replace(/\D/g, '').length - 3, 1))}${text.slice(-3)}`
}

app.post('/api/candidate/request-code', limits.requestCode, async (req, res, next) => {
  try {
    const identifier = String(req.body?.identifier ?? '').trim()
    if (!identifier) throw new HttpError(400, 'Enter the email address you applied with.')

    /*
     * Email only, and the phone number is not a second door.
     *
     * Every email this product depends on goes to the same address: the
     * freshness reminders, the notice that a recruiter revealed them, the
     * warning before the profile is hidden. If that mailbox is dead the
     * product does not work for them — so signing in through it is what keeps
     * "active" meaning something. Signing in by SMS would let a candidate with
     * an unreachable inbox reset their activity clock and go on looking
     * current to recruiters who are paying to reach them.
     *
     * The phone is still proved at signup and still sold to recruiters as part
     * of a Reveal. It is simply not a way in.
     */
    if (!looksLikeEmail(identifier)) {
      throw new HttpError(400, 'Sign in with the email address you applied with. '
        + 'We no longer send sign-in codes by text message.')
    }

    const channel = 'email'
    const candidate = findCandidateByContact(identifier)

    // Deliberately tells the caller that no account exists, so the sign-in page
    // can offer to create one. The cost is that this endpoint can be used to
    // check whether a given person has applied — throttle it before exposing
    // this server to the internet.
    if (!candidate) {
      throw new HttpError(404, 'No application was found for that email address.')
    }

    const code = generateLoginCode()
    const { expiresInMinutes } = issueLoginCode({
      candidateId: candidate.id, channel, code, secret: SESSION_SECRET,
    })

    const destination = channel === 'email' ? candidate.email : candidate.phone
    await sendLoginCode({ channel, destination, code, expiresInMinutes })

    // The login-code twin of the sweep on the verification route above.
    sweepLoginCodes()

    res.json({
      sent: true,
      channel,
      maskedTo: maskContact(destination, channel),
      expiresInMinutes,
      // Development convenience only; see server/src/notify.js.
      ...(OTP_ECHO ? { devCode: code } : {}),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/candidate/verify-code', limits.verifyCode, (req, res, next) => {
  try {
    const identifier = String(req.body?.identifier ?? '').trim()
    const code = String(req.body?.code ?? '').trim()

    const candidate = findCandidateByContact(identifier)
    if (!candidate) throw new HttpError(401, 'That code is not valid.')

    const result = redeemLoginCode({ candidateId: candidate.id, code, secret: SESSION_SECRET })
    if (!result.ok) {
      const message = {
        'no-code': 'Request a new code first.',
        expired: 'That code has expired. Request a new one.',
        'too-many-attempts': 'Too many incorrect attempts. Request a new code.',
      }[result.reason] ?? 'That code is not valid.'
      throw new HttpError(401, message)
    }

    /*
     * Signing in is evidence the person is still around, and it is the only
     * such evidence for the many candidates who never answer the monthly email.
     * Stamped here rather than on every authenticated request: one write per
     * sign-in is enough to answer "in the last 30 days", and stamping per
     * request would put a database write in front of every page load.
     */
    markCandidateSeen(candidate.id)

    res.json({
      token: startSession(res, req, 'candidate', candidate.id),
      name: candidate.name,
    })
  } catch (error) {
    next(error)
  }
})

// ----------------------------------------------------- candidate account ---

function candidateProfile(candidate) {
  const { cv_text, stored_name, photo_name, ...rest } = candidate
  return {
    ...rest,
    hasPhoto: Boolean(photo_name),
    // The photo URL is keyed on the session, not the file, so a replaced photo
    // would render from cache indefinitely. This changes with the stored file
    // and breaks that — the same trick the recruiter avatars use.
    photoVersion: photoVersion(photo_name),
    open_to_relocation: candidate.open_to_relocation === null ? null
      : Boolean(candidate.open_to_relocation),
  }
}

/** The candidate's whole account in one payload. */
function candidatePayload(candidateId) {
  const candidate = getCandidate(candidateId)
  if (!candidate) return null

  const documents = listDocuments(candidateId)
  const profile = effectiveProfile(candidateId)

  return {
    candidate: candidateProfile(candidate),
    documents,
    slots: DOCUMENT_SLOTS,
    // §7 — what the + picker offers, and how many of each it will take. Sent
    // rather than duplicated in the client, so the ceilings the form enforces
    // are the ones the server will actually accept.
    documentTypes: DOCUMENT_TYPES,
    profile,
    blockedCompanies: getBlockedCompanies(candidateId),
    views: viewSummary(candidateId),
    unread: candidateUnreadTotal(candidateId),
    // For the count beside the Messages tab, the way the recruiter bar has one.
    conversations: candidateThreadCount(candidateId),
    completion: profileCompletion(candidate, profile, documents),
    activity: {
      ...activityStatus(candidate),
      /* When the profile goes if nothing changes — the date the reminders
         count down to, so the portal and the emails quote the same day. */
      hiddenDueAt: hiddenDueAt(candidate),
      pending: Boolean(pendingCheckin(candidateId)),
    },
    // §5 — what the candidate has said they are open to.
    preferences: { ...getPreferences(candidateId), tagCap: MATCHING.preferenceTagCap },
    /*
     * §3.2 — what we concluded about them, shown back to them.
     *
     * A candidate is entitled to see the labels that decide which recruiters
     * find them. Inference that only the operator can see is how people end up
     * mis-categorised with no way to notice, let alone object.
     */
    intelligence: summariseIntelligence(candidateId),
  }
}

/** The candidate-facing view of their own profile intelligence. */
function summariseIntelligence(candidateId) {
  const built = getIntelligence(candidateId)
  if (!built) return null

  return {
    generatedAt: built.generatedAt,
    source: built.source,
    seniority: built.seniority,
    labels: built.labels.map((label) => ({
      dimension: label.dimension,
      concept: label.conceptId,
      label: label.rawLabel,
      // Confidence is how sure we are the label fits them — not a match score,
      // and labelled that way wherever it surfaces (§3.2).
      confidence: label.confidence,
      evidence: label.evidence,
    })),
    experience: built.metrics,
  }
}

/**
 * Drafts a professional summary from a CV, for the candidate to edit before
 * saving. Nothing is stored — the draft only exists in the form until they
 * submit it, so a summary they disliked never ends up on their profile.
 *
 * Two ways in, because it is offered at two moments:
 *   - during onboarding, the CV they have just chosen is posted with the
 *     request, since there is no account yet to read it from;
 *   - from the profile page, a signed-in candidate needs to send nothing.
 *
 * The file is deleted immediately either way.
 *
 * Rate limited and upload-verified on the same terms as parse-cv beneath it:
 * it takes an upload from anybody and spends a model call on it, and for a
 * while it was the one such route with neither guard on it.
 */
app.post('/api/candidate/summary', limits.apply, upload.single('cv'), verifyUploads, async (req, res, next) => {
  try {
    let cvText = ''

    if (req.file) {
      cvText = await readCv(req.file)
    } else {
      const session = readSession(SESSION_SECRET, 'candidate', req)
      if (!session) {
        throw new HttpError(400, 'Attach your CV, or sign in so we can read the one on file.')
      }
      cvText = cvText || getDocument(session.id, 'cv')?.extracted_text
        || getCandidate(session.id)?.cv_text || ''
    }

    if (!cvText || cvText.trim().length < 120) {
      throw new HttpError(422, 'There is not enough text in your CV to write a summary from.')
    }

    const drafted = await generateSummary(cvText)
    if (!drafted) {
      throw new HttpError(
        503,
        'Automatic summaries are not available right now. Please write yours in your own words.',
      )
    }

    res.json({
      summary: drafted.summary,
      maxChars: SUMMARY_MAX_CHARS,
      // The draft ran long and was cut at a sentence end. Said out loud so the
      // candidate knows to reread it rather than assuming it is finished.
      truncated: Boolean(drafted.truncated),
    })
  } catch (error) {
    next(error)
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
  }
})

/**
 * Reads the contact details out of a CV so the form can fill itself in.
 *
 * The file is read and deleted — nothing is stored and no account is touched,
 * because this runs before either exists. The candidate sees every value in an
 * editable field and can change any of it, which is the whole reason this is
 * safe to do automatically: it is a first draft of the form, not an assertion
 * about who they are.
 *
 * Rate limited on the apply bucket. It costs a model call and accepts an upload
 * from anyone, so it needs the same ceiling as the route it feeds.
 */
app.post('/api/candidate/parse-cv', limits.apply, upload.single('cv'), verifyUploads, async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Attach your CV.')

    /*
     * Everything past this point is best effort.
     *
     * readCv throws on a file with no text layer, and the extractor can fail on
     * a PDF that is merely unusual — an embedded font it cannot load is enough.
     * Neither is a reason to hand the candidate an error: they are standing in
     * front of a form that works perfectly well typed out by hand, and the only
     * thing they have lost is the shortcut. An empty result says exactly that;
     * a 500 says the site is broken.
     *
     * The upload itself is still validated before here, so a genuinely bad file
     * is refused by verifyUploads rather than swallowed by this.
     */
    let cvText = null
    try {
      cvText = await readCv(req.file)
    } catch (error) {
      console.warn(`  CV pre-fill could not read the upload: ${error.message}`)
    }

    if (!cvText || cvText.trim().length < 40) return res.json({ fields: {} })

    const found = await extractContactDetails(cvText)

    // Only what was actually found. Sending nulls would let the client
    // overwrite something the candidate had already typed with nothing.
    const fields = Object.fromEntries(
      Object.entries(found).filter(([, value]) => value !== null && value !== ''),
    )

    res.json({ fields })
  } catch (error) {
    next(error)
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
  }
})

// ------------------------------------------------------ freshness check-in ---

/**
 * Answering the monthly email. No session: the emailed token is the credential,
 * which is why it is single use, hashed at rest and expires.
 *
 * Requiring a login here would be the end of the feature — the people most
 * likely to ignore a login prompt are exactly the ones whose profiles would
 * then be hidden by mistake.
 */
app.post('/api/checkin/:token', limits.checkin, (req, res, next) => {
  try {
    const answer = String(req.body?.answer ?? '').toLowerCase()
    if (answer !== 'yes' && answer !== 'no') {
      throw new HttpError(400, 'Answer yes or no.')
    }

    const outcome = redeemCheckinToken(String(req.params.token ?? ''), answer)
    if (!outcome.ok) {
      const messages = {
        unknown: 'That link is not valid. Sign in to your account to update your status.',
        used: 'That link has already been used. Sign in to change your answer.',
        expired: 'That link has expired. Sign in to your account to update your status.',
      }
      throw new HttpError(410, messages[outcome.reason] ?? 'That link cannot be used.')
    }

    const candidate = getCandidate(outcome.candidateId)

    // Answering no is the one outcome worth acknowledging by email: the profile
    // has just gone quiet, and silence about that reads like a fault.
    if (answer === 'no' && candidate?.email) {
      void sendDeactivationEmail({ to: candidate.email, name: candidate.name })
    }

    /* Whoever was waiting on this candidate learns the answer, whichever
       question prompted it. One link answers both. */
    if (candidate) notifyAvailabilityWatchers(candidate, answer)

    res.json({ answer, activity: activityStatus(candidate) })
  } catch (error) {
    next(error)
  }
})

/**
 * The same yes/no from inside the account — for the prompt an unconfirmed
 * candidate sees when they sign in, and for anyone who lost the email.
 */
app.post('/api/candidate/me/checkin', limits.checkin, candidateOnly, (req, res, next) => {
  try {
    const answer = String(req.body?.answer ?? '').toLowerCase()
    if (answer !== 'yes' && answer !== 'no') throw new HttpError(400, 'Answer yes or no.')

    if (answer === 'yes') {
      confirmActive(req.session.id)
    } else {
      deactivate(req.session.id)
      const candidate = getCandidate(req.session.id)
      if (candidate?.email) {
        void sendDeactivationEmail({ to: candidate.email, name: candidate.name })
      }
    }

    /* The same fact, given through the account rather than through a link.
       Read after the update so the notification describes the new state. */
    const answered = getCandidate(req.session.id)
    if (answered) notifyAvailabilityWatchers(answered, answer)

    res.json({ activity: activityStatus(answered) })
  } catch (error) {
    next(error)
  }
})

/**
 * Reactivating after an explicit deactivation. A separate route from the yes/no
 * check-in so it cannot happen by accident: signing in never calls this, and
 * nothing else does either.
 */
app.post('/api/candidate/me/reactivate', candidateOnly, (req, res, next) => {
  try {
    reactivate(req.session.id)
    res.json({ activity: activityStatus(getCandidate(req.session.id)) })
  } catch (error) {
    next(error)
  }
})

/*
 * The candidate correcting how they have been categorised.
 *
 * The labels are read out of the CV, and the reading is sometimes wrong — a
 * career that changed direction, a word the extractor took literally. Until now
 * the only remedy offered was "edit your profile and we will read it again",
 * which is a slow, indirect way to say "no, I do not work in Logistics".
 *
 * An edit is recorded as a standing instruction rather than as a one-off write,
 * because analysis rewrites every label whenever the CV changes; see
 * candidate_label_overrides. It takes effect on the stored profile immediately,
 * so it changes who finds this person rather than only what this page shows.
 */
app.patch('/api/candidate/me/labels', candidateOnly, (req, res, next) => {
  try {
    const action = req.body?.action === 'remove' ? 'remove' : 'add'
    const dimension = String(req.body?.dimension ?? '')
    const text = String(req.body?.label ?? '')

    const result = editCandidateLabel({
      candidateId: req.session.id, dimension, text, action,
    })

    if (!result.ok) {
      throw new HttpError(400, {
        dimension: 'That is not an area you can edit here.',
        empty: 'Type the area you want to add.',
        'too-long': `Keep it to ${MAX_LABEL_WORDS} words or fewer.`,
        full: `You can have ${MAX_LABELS_PER_DIMENSION} at a time. Remove one first.`,
        /* Named rather than stored as typed: a label outside the vocabulary
           would show on the page and change nothing about who finds you. */
        unknown: 'We do not recognise that area, so adding it would not change '
          + 'which searches find you. Try a broader word for the same thing.',
      }[result.reason] ?? 'That change could not be made.')
    }

    res.json(candidatePayload(req.session.id))
  } catch (error) {
    next(error)
  }
})

/** Which dimensions the account page may offer, and the ceilings on them. */
/*
 * The companies a candidate does not want seeing them.
 *
 * Its own route rather than a field on the profile PATCH, for the same reason
 * the label edits above have one: this is a list the candidate manages on its
 * own, and routing it through the whole-profile save would mean every change to
 * it re-validated, re-read and re-wrote twenty unrelated fields.
 *
 * `companies` must be present to change anything. An absent key leaves the list
 * exactly as it was; an empty array is a real instruction and clears it. Those
 * are different requests and this route treats them differently — the profile
 * save learned the same lesson the hard way, see applyIntakeExtras.
 */
app.patch('/api/candidate/me/blocked-companies', candidateOnly, (req, res, next) => {
  try {
    const sent = req.body?.companies

    if (sent === undefined) throw new HttpError(400, 'No change was sent.')
    if (!Array.isArray(sent)) throw new HttpError(400, 'Send the companies as a list.')

    /*
     * A ceiling, not a feature. There is no product reason to cap this — a
     * candidate may have worked at a great many places they would rather not
     * hear from — so it sits far above any real list and exists only so that a
     * script cannot write an unbounded number of rows against one account.
     */
    if (sent.length > MAX_BLOCKED_COMPANIES) {
      throw new HttpError(400, `You can hide from up to ${MAX_BLOCKED_COMPANIES} companies.`)
    }

    for (const entry of sent) {
      if (String(entry ?? '').trim().length > MAX_COMPANY_NAME_LENGTH) {
        throw new HttpError(400, 'One of those company names is too long.')
      }
    }

    setBlockedCompanies(req.session.id, splitList(sent))

    res.json(candidatePayload(req.session.id))
  } catch (error) {
    next(error)
  }
})

app.get('/api/candidate/me/label-options', candidateOnly, (_req, res) => {
  res.json({
    dimensions: EDITABLE_DIMENSIONS,
    maxPerDimension: MAX_LABELS_PER_DIMENSION,
    maxWords: MAX_LABEL_WORDS,
  })
})

app.get('/api/candidate/me', candidateOnly, (req, res) => {
  const payload = candidatePayload(req.session.id)
  if (!payload) return res.status(404).json({ error: 'Account not found.' })
  res.json(payload)
})

app.get('/api/candidate/me/photo', candidateOnly, (req, res) => {
  const candidate = getCandidate(req.session.id)
  const photoPath = candidate && resolveUpload(candidate.photo_name)
  if (!photoPath) return res.status(404).json({ error: 'No photo on file.' })
  sendUploadedFile(res, photoPath)
})

/** A candidate may always download their own documents. */
app.get('/api/candidate/me/documents/:slot', candidateOnly, (req, res) => {
  const doc = getDocument(req.session.id, req.params.slot)
  const filePath = doc && resolveUpload(doc.stored_name)
  if (!filePath) return res.status(404).json({ error: 'No file in that slot.' })
  res.download(filePath, doc.file_name)
})

app.delete('/api/candidate/me/documents/:slot', candidateOnly, async (req, res, next) => {
  try {
    if (req.params.slot === 'cv') {
      throw new HttpError(400, 'Your CV is required. Upload a replacement instead of removing it.')
    }

    const removed = deleteDocument(req.session.id, req.params.slot)
    if (removed) await fs.promises.unlink(path.join(UPLOAD_DIR, removed)).catch(() => {})

    res.json(candidatePayload(req.session.id))
  } catch (error) {
    next(error)
  }
})

/** Same form as the application; every document is optional on an edit. */
app.patch('/api/candidate/me', candidateOnly, applicationUpload, async (req, res, next) => {
  const documents = uploadedDocuments(req)
  const photoFile = req.files?.photo?.[0]

  try {
    const candidate = getCandidate(req.session.id)
    if (!candidate) throw new HttpError(404, 'Account not found.')

    const changes = readProfileFields(req.body, { require: true })

    /*
     * A contact detail that changed has to be proved, exactly as it was at
     * sign-up.
     *
     * Being signed in says the session belongs to this account; it says nothing
     * about whether the person holds the NEW address. Without this, anyone with
     * a borrowed session could point the account's email at their own inbox —
     * and every sign-in code from then on would go to them, which is the whole
     * account. Unchanged details need nothing: they were proved when the
     * account was made and there is no proof in hand for them.
     */
    for (const [field, channel] of [['email', 'email'], ['phone', 'phone']]) {
      const wanted = changes[field]
      if (!wanted || wanted === candidate[field]) continue

      const proof = String(req.body?.[`${channel}Proof`] ?? '')
      if (!proofCovers({ proof, channel, destination: wanted, secret: SESSION_SECRET })) {
        throw new HttpError(400, channel === 'email'
          ? 'Verify your new email address before saving it.'
          : 'Verify your new phone number before saving it.')
      }

      /*
       * And it must not be somebody else's.
       *
       * The apply route refuses a second row for an identity; this one did not,
       * so the same collision could be created from the other side — point this
       * profile's phone at a number another row already has, and every sign-in
       * with it lands on whichever row is newer. Proving the destination shows
       * they control it; it does not show the other account is theirs.
       *
       * Their own row is excluded, so re-spelling their own number as
       * "0501234567" instead of "050-123-4567" is not a collision with
       * themselves.
       */
      const owner = findCandidateByContact(wanted)
      if (owner && owner.id !== candidate.id) {
        /* Named, for the same reason the apply route names it: this loop knows
           exactly which of the two fields collided. */
        throw new HttpError(
          409,
          `That ${channel === 'email' ? 'email address' : 'phone number'} is already on another `
          + 'Cursus profile. Sign in to that profile instead, or use a different one here.',
        )
      }
    }

    // Validated before any write, for the same reason as the apply route.
    const beforePreferences = getPreferences(candidate.id)
    const preferences = readPreferenceInput(req.body, beforePreferences)
    const cvEntry = documents.find((entry) => entry.slot === 'cv')
    let cvText = null

    if (cvEntry) {
      cvText = await readCv(cvEntry.file)
      Object.assign(changes, {
        file_name: cvEntry.file.originalname,
        stored_name: cvEntry.file.filename,
        file_size: cvEntry.file.size,
        cv_text: cvText,
        skills: detectSkills(cvText),
      })
    }

    if (photoFile) changes.photo_name = photoFile.filename
    else if (String(req.body.removePhoto) === 'true') changes.photo_name = null

    updateCandidate(candidate.id, changes)
    applyIntakeExtras(candidate.id, req.body)

    /*
     * §10 Path 1 and §13 — what the candidate wrote is authoritative, and is
     * sanitised before it becomes the version recruiters read.
     *
     * Only when they actually sent one: an edit that never mentions the summary
     * leaves it alone, including the one generated for them. Not awaited on the
     * response path — the field is already saved by readProfileFields above, so
     * the worst a slow model call costs is a few seconds during which the
     * unsanitised text is the stored one, and the alternative is making every
     * profile save wait on it.
     */
    if (req.body?.notes !== undefined) {
      void ensureSummary(candidate.id).catch((error) => {
        console.warn(`  summary sanitisation failed for candidate ${candidate.id}: ${error.message}`)
      })
    }

    // §5 — recorded before the version decision below, because changing who may
    // find you is exactly the kind of change that must invalidate analyses.
    const preferencesChanged = writePreferences(candidate.id, preferences, beforePreferences)

    // Corrections to AI-extracted fields arrive as a JSON blob alongside the form.
    if (req.body.profile) {
      const corrections = JSON.parse(req.body.profile)
      for (const [field, value] of Object.entries(corrections)) {
        if (EXTRACTED_FIELDS.includes(field)) setOverride(candidate.id, field, value)
      }
      track('profile_fields_corrected', {
        actorType: 'candidate', actorId: candidate.id,
        fields: Object.keys(corrections),
      })
    }

    const replaced = await storeDocuments(candidate.id, documents)

    // Only once the rows point at the new files is it safe to unlink the old.
    for (const stored of replaced) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, stored)).catch(() => {})
    }
    if (cvEntry && candidate.stored_name && candidate.stored_name !== cvEntry.file.filename) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, candidate.stored_name)).catch(() => {})
    }
    if ((photoFile || changes.photo_name === null) && candidate.photo_name) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, candidate.photo_name)).catch(() => {})
    }

    /*
     * §6.1 / §6.2 — the version only moves for changes matching depends on.
     *
     * This is the line that makes "a new CV invalidates stale analyses; a new
     * photo does not" true. Bumping the version leaves every cached JD analysis
     * keyed to the old one, so it is never consulted again without anything
     * being deleted; leaving it alone means a recruiter's paid-for analysis
     * survives a change that could not possibly have altered the conclusion.
     */
    const matchingRelevant = Boolean(cvText)
      || isMatchingRelevantChange(candidate, changes)
      || preferencesChanged

    if (matchingRelevant) bumpProfileVersion(candidate.id)

    // A new CV re-extracts and re-embeds. An edit to the fields alone still
    // changes what the profile means, so the vector is refreshed either way —
    // source_hash makes that a no-op when nothing meaningful moved.
    if (cvText) void runExtraction(candidate.id, cvText)
    else if (matchingRelevant) { void runEmbedding(candidate.id); runIntelligence(candidate.id) }

    res.json(candidatePayload(candidate.id))
  } catch (error) {
    discard([...documents.map((d) => d.file), photoFile])
    next(error)
  }
})

// -------------------------------------------------------- account deletion ---

/** What the confirmation screen shows before the candidate commits. */
app.get('/api/candidate/me/deletion-preview', candidateOnly, (req, res) => {
  res.json({ preview: deletionPreview(req.session.id) })
})

/**
 * Spec §5.6 — hard delete, nothing retained, session dead immediately.
 *
 * Irreversible, so it takes a second explicit confirmation: the candidate types
 * their own email address. A misclick cannot destroy an account.
 */
app.delete('/api/candidate/me', candidateOnly, async (req, res, next) => {
  try {
    const candidate = getCandidate(req.session.id)
    if (!candidate) throw new HttpError(404, 'Account not found.')

    /*
     * An explicit acknowledgement, and nothing stronger.
     *
     * This route asked for a code sent to the contact on the account, which is
     * the only check that distinguishes the account holder from whoever is
     * sitting at their unlocked screen. That was removed at the owner's
     * request; what stands in its place is the session plus a statement that
     * the consequences have been read.
     *
     * Still required here rather than trusted to the checkbox: a client-side
     * gate is a gate on the page, not on the endpoint, and a DELETE that fires
     * on an empty body is one stray request away from an emptied account.
     */
    if (req.body?.acknowledged !== true) {
      throw new HttpError(400, 'Confirm you understand this cannot be undone.')
    }

    track('candidate_account_deleted', {
      actorType: 'candidate', actorId: candidate.id,
      ...deletionPreview(candidate.id),
    })

    /* Read before the erasure, said after it. The row is about to stop
       existing, and a churn notification with no name in it tells nobody
       anything. */
    const erased = {
      name: candidate.name ?? [candidate.first_name, candidate.last_name].filter(Boolean).join(' '),
      email: candidate.email,
    }

    const files = deleteCandidateCompletely(candidate.id)
    for (const stored of files) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, stored)).catch(() => {})
    }

    notifySlack('Candidate account deleted', [
      `${erased.name} · ${erased.email}`,
      stamp(),
    ])

    res.json({ deleted: true, filesRemoved: files.length })
  } catch (error) {
    next(error)
  }
})

app.get('/api/candidate/threads', candidateOnly, (req, res) => {
  res.json({ threads: candidateThreads(req.session.id) })
})

app.get('/api/candidate/threads/:recruiterId', candidateOnly, (req, res) => {
  const recruiterId = Number(req.params.recruiterId)
  const recruiter = getRecruiter(recruiterId)
  if (!recruiter) return res.status(404).json({ error: 'Recruiter not found.' })

  markThreadRead({ candidateId: req.session.id, recruiterId, reader: 'candidate' })

  res.json({
    recruiter: {
      id: recruiter.id,
      name: recruiterDisplayName(recruiter),
      company: recruiter.company_name,
    },
    messages: listThread(req.session.id, recruiterId),
    status: threadStatus(req.session.id, recruiterId),
  })
})

app.post('/api/candidate/threads/:recruiterId', candidateOnly, (req, res, next) => {
  try {
    const recruiterId = Number(req.params.recruiterId)
    if (!getRecruiter(recruiterId)) throw new HttpError(404, 'Recruiter not found.')

    // Candidates reply to conversations; they cannot cold-message recruiters.
    const existing = listThread(req.session.id, recruiterId)
    if (existing.length === 0) {
      throw new HttpError(403, 'You can only reply to a recruiter who has messaged you.')
    }

    // The point of closing: the candidate can still read the history, but the
    // conversation takes no more messages until the recruiter reopens it.
    if (threadStatus(req.session.id, recruiterId) === 'closed') {
      throw new HttpError(409, 'This conversation has been closed by the recruiter.')
    }

    const body = String(req.body?.body ?? '').trim()
    if (!body) throw new HttpError(400, 'Write a message first.')

    sendMessage({ candidateId: req.session.id, recruiterId, sender: 'candidate', body })

    /*
     * The recruiter is told, and the reply itself is not in the email.
     *
     * Same rule as the message that started the thread: the conversation lives
     * on Cursus, where it can be closed, reported and kept with the candidate
     * it belongs to. An email carrying the words would leave a copy outside all
     * of that. No Slack — every reply is ordinary product traffic.
     */
    const repliedTo = getRecruiter(recruiterId)
    const replier = getCandidate(req.session.id)
    if (repliedTo?.email) {
      sendReplyEmail({
        to: repliedTo.email,
        name: repliedTo.first_name,
        candidateName: replier?.name ?? replier?.first_name ?? null,
        candidateId: req.session.id,
      }).catch(() => {})
    }
    track('candidate_replied', { actorType: 'candidate', actorId: req.session.id })

    res.status(201).json({
      messages: listThread(req.session.id, recruiterId),
      status: threadStatus(req.session.id, recruiterId),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Mark a conversation unread again, or clear it from the inbox.
 *
 * Both act on the candidate's own view. Clearing does not delete the messages:
 * the recruiter keeps their copy, and anything sent afterwards brings the
 * conversation back. See conversation_hidden in schema.js for why.
 */
app.post('/api/candidate/threads/:recruiterId/unread', candidateOnly, (req, res, next) => {
  try {
    const recruiterId = Number(req.params.recruiterId)
    if (!getRecruiter(recruiterId)) throw new HttpError(404, 'Recruiter not found.')

    /* Nothing to mark means the two have never exchanged anything, which for a
       candidate means there is no conversation to be in. */
    if (!markThreadUnread({ candidateId: req.session.id, recruiterId, reader: 'candidate' })) {
      throw new HttpError(404, 'No conversation to mark unread.')
    }

    res.json({ threads: candidateThreads(req.session.id) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/candidate/threads/:recruiterId', candidateOnly, (req, res, next) => {
  try {
    const recruiterId = Number(req.params.recruiterId)
    if (!getRecruiter(recruiterId)) throw new HttpError(404, 'Recruiter not found.')

    hideConversation({ candidateId: req.session.id, recruiterId, party: 'candidate' })
    res.json({ threads: candidateThreads(req.session.id) })
  } catch (error) {
    next(error)
  }
})

// ------------------------------------------------ company + recruiter auth ---

/**
 * §17 — the password rules, stated once.
 *
 * The client shows these as a checklist that ticks off while someone types;
 * this is the copy the checklist is generated from and the check the server
 * actually enforces, so the two can never describe different rules.
 */
export const PASSWORD_RULES = [
  { key: 'length', label: 'At least 8 characters', test: (value) => value.length >= 8 },
  { key: 'upper', label: 'One uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { key: 'digit', label: 'One number', test: (value) => /\d/.test(value) },
  {
    key: 'symbol',
    label: 'One special character',
    // Anything that is not a letter, a digit or whitespace. A fixed punctuation
    // list would reject perfectly good passwords built from characters nobody
    // thought to enumerate.
    test: (value) => /[^A-Za-z0-9\s]/.test(value),
  },
]

/**
 * An address, shown to somebody who already owns it.
 *
 * Enough to tell which of your mailboxes to open and not enough to be an
 * address: the reply to a reset request is readable by whoever made the
 * request, which is not necessarily the account holder.
 */
function maskEmail(address) {
  const [name = '', domain = ''] = String(address ?? '').split('@')
  if (!domain) return ''
  const head = name.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(1, name.length - head.length))}@${domain}`
}

function assertPassword(password) {
  const failed = PASSWORD_RULES.filter((rule) => !rule.test(password))
  if (failed.length === 0) return

  throw new HttpError(
    400,
    `That password needs: ${failed.map((rule) => rule.label.toLowerCase()).join(', ')}.`,
  )
}

/** Shared by both account-creating routes below. */
function readNewAccount(body) {
  const firstName = capitalizeName(body?.firstName ?? '')
  const lastName = capitalizeName(body?.lastName ?? '')
  const password = String(body?.password ?? '')
  const confirmPassword = String(body?.confirmPassword ?? '')

  if (!firstName) throw new HttpError(400, 'First name is required.')
  if (!lastName) throw new HttpError(400, 'Last name is required.')
  assertPassword(password)
  if (password !== confirmPassword) throw new HttpError(400, 'The two passwords do not match.')

  return { firstName, lastName, password }
}

/**
 * §17 — the administrator's own contact details, all three mandatory.
 *
 * The website is checked for shape rather than reachability: a fetch on sign-up
 * would block registration behind somebody else's uptime, and a typo is caught
 * far more cheaply when a human reviews the pending company.
 */
function readAdminContact(body) {
  const email = String(body?.email ?? '').trim()
  const phone = String(body?.phone ?? '').trim()
  let website = String(body?.website ?? '').trim()

  if (!email.includes('@') || email.length < 5) {
    throw new HttpError(400, 'Enter the email address for this account.')
  }
  /*
   * Nine digits, matching phoneKey and the candidate form.
   *
   * Seven left a number that normalizeDestination cannot key. Every such number
   * used to normalise to the same empty string and now to the same null, and
   * the three "has this contact changed" comparisons treat two nulls as equal —
   * so an account could move from one unkeyable number to another without a
   * code ever being sent. Refusing them at the door is what makes that
   * comparison unreachable rather than merely unlikely.
   */
  if (phone.replace(/\D/g, '').length < 9) {
    throw new HttpError(400, 'Enter a phone number for this account.')
  }
  if (!website) throw new HttpError(400, 'Enter your company website.')

  // Typed without a scheme far more often than with one, and a bare host is a
  // perfectly clear answer to "website" — so it is completed rather than
  // refused.
  if (!/^https?:\/\//i.test(website)) website = `https://${website}`
  try {
    const url = new URL(website)
    if (!url.hostname.includes('.')) throw new Error('no dot')
  } catch {
    throw new HttpError(400, 'That website address does not look right.')
  }

  return { email, phone, website }
}

/**
 * Creates the company and its administrator together.
 *
 * There is no self-service way to join a company, so the company's first
 * account cannot be left for someone to claim later — it is made here, signed
 * in immediately, and every further account is created by it from the Team
 * screen. Multipart, because the administrator may set a photo while signing up.
 */
app.post('/api/company/register', limits.register, photoUpload, async (req, res, next) => {
  try {
    const name = String(req.body?.companyName ?? '').trim()
    if (name.length < 2) throw new HttpError(400, 'Enter your company name.')

    assertConsent(req.body)

    const { firstName, lastName, password } = readNewAccount(req.body)
    const { email, phone, website } = readAdminContact(req.body)
    // The administrator proves both contact details, exactly as a candidate
    // does — and here they are also what a human reads when deciding whether to
    // approve the company, so an unverified one would be worth very little.
    assertContactsVerified(req.body, { email, phone })

    /*
     * §15 removed the sign-up secret, so this route no longer refuses anybody.
     * The company is created 'pending': the administrator is signed in and can
     * finish setting up, but /api/hr is closed to them — no search, no profile,
     * no reveal — until the company is approved.
     */
    const company = createCompany(name)

    /*
     * Recorded for the organization as well as for candidates.
     *
     * There was no consent column on companies at all, so the administrator who
     * accepted the Terms on the organization's behalf left no trace of having
     * done so — which is the one party whose acceptance is contractual rather
     * than merely informational.
     */
    db.prepare(`UPDATE companies SET consent_at = ?, consent_version = ? WHERE id = ?`)
      .run(new Date().toISOString(), CONSENT_VERSION, company.id)
    /*
     * Pricing §6 — the complimentary balances, once per organization. Never
     * repeated when a seat is added, which is what §21 asks be guaranteed.
     *
     * Both products, because the pricing page promises both to every new
     * account and a promise kept for one of them is a promise broken. Each is
     * guarded by its own timestamp column, so neither can be granted twice and
     * a failure of one cannot cost the other.
     */
    grantComplimentaryReveals(company.id)
    grantComplimentaryTriage(company.id)
    const recruiter = await createRecruiter({
      companyId: company.id, firstName, lastName, password,
      email, phone, website,
      photoName: req.file?.filename ?? null,
      isOrgAdmin: true,
    })

    /*
     * Now that there is somebody to give it to.
     *
     * The complimentary grants above land before this row exists, so at the
     * moment they were made the organization had capacity and no seats — and a
     * share of a balance between nobody is nothing. This is the first point at
     * which an equal split has a denominator.
     */
    resettleSeats(company.id)

    /*
     * Told that the account exists and cannot be used yet, and put in the review
     * queue.
     *
     * This route is the only way a NEW company is created — a colleague joining
     * an organization that already exists comes through the members route, which
     * has no review to wait for. So "recruiter from a new, unapproved company"
     * and "this route" are the same thing, and the 2a email cannot reach a
     * teammate by accident.
     */
    track('recruiter_signed_up', { actorType: 'recruiter', actorId: recruiter.id })
    if (recruiter.email) {
      sendRecruiterUnderReview({ to: recruiter.email, name: recruiter.firstName }).catch(() => {})
    }
    notifySlack('New recruiter signup — pending review', [
      `${[recruiter.firstName, recruiter.lastName].filter(Boolean).join(' ')} · ${company.name}`,
      recruiter.email ?? '(no email)',
      stamp(),
    ])

    /*
     * The demo search, handed to the account it created.
     *
     * Claimed here rather than after the first sign-in because this is the only
     * moment the two are connected: the browser holding the token is the one
     * registering, and registration deliberately does not sign anybody in, so
     * there is no later request that knows both facts.
     *
     * Failure is silent by design. A stale or already-claimed token means the
     * recruiter loses a search they can re-run, and turning that into a failed
     * registration would be a far worse trade.
     */
    const demoToken = trimOrNull(req.body?.demoSearchToken)
    if (demoToken) {
      claimPublicSearch({ token: demoToken, recruiterId: recruiter.id, companyId: company.id })
    }

    console.log(`  [signup] ${name} <${email}> ${website} — awaiting approval`)

    /*
     * Registering does not sign anyone in, and does not hand over the company
     * key.
     *
     * The key is the credential every recruiter at this company signs in with,
     * so giving it out at registration means handing the credential to an
     * account nobody has checked yet — the review would be a formality
     * happening behind a door that was already open. It is released by whoever
     * approves the company, to the address and number that were verified during
     * sign-up.
     *
     * The account itself exists and is complete. What it lacks is a way in.
     */
    res.status(201).json({
      status: 'in-review',
      company: { id: company.id, name: company.name },
      // Echoed back so the confirmation page can say where the reply will go,
      // and so a typo in either is visible while it is still fixable.
      contact: { email, phone },
    })
  } catch (error) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
    next(error)
  }
})

/**
 * The administrator creating a colleague's account. This is the only way a
 * second account comes into existence: nobody can register themselves, so an
 * account always has someone accountable for it.
 *
 * The password is chosen by the administrator and handed over — there is no
 * email delivery wired up, so an invite link would have nowhere to go.
 */
app.post('/api/recruiter', recruiterOnly, orgAdminOnly, photoUpload, async (req, res, next) => {
  try {
    const company = req.company

    // 402 rather than 403 — the block is a payment gate, not a permission
    // problem, and the client shows a different message for it.
    /*
     * Pricing §11.4 — seat capacity exhaustion, which is a different state from
     * running out of reveals and must not borrow its wording. Blocking the
     * invitation is the whole behaviour: no pending member is created that
     * cannot be activated, and nobody already seated is touched.
     */
    if (walletSeatsExhausted(company.id)) {
      const seats = seatEntitlement(company.id)
      const held = seats.purchased
        ? `${seats.included} included, ${seats.purchased} purchased`
        : `${seats.included} included`
      throw new HttpError(
        402,
        `${company.name} is using all ${seats.total} of its recruiter seats (${held}). `
        + 'Add seats from the Seats tab on Pricing before creating another account.',
      )
    }

    const firstName = capitalizeName(req.body?.firstName ?? '')
    const lastName = capitalizeName(req.body?.lastName ?? '')
    if (!firstName) throw new HttpError(400, 'First name is required.')
    if (!lastName) throw new HttpError(400, 'Last name is required.')

    /*
     * Contact details, if the form asked for them.
     *
     * Optional, so an administrator setting somebody up in a hurry is not
     * blocked on details they do not have yet — the person can fill them in
     * from their own profile. Given, they are proved the same way as anywhere
     * else: a code to the address itself, not to whoever is typing it.
     *
     * Each is judged on its own, unlike the profile routes, because there is
     * nothing to be consistent with yet. A new account may arrive with an email
     * and no phone; refusing that would be inventing a rule this form has never
     * had.
     */
    const email = String(req.body?.email ?? '').trim()
    const phone = String(req.body?.phone ?? '').trim()

    for (const [channel, destination] of [['email', email], ['phone', phone]]) {
      if (!destination) continue
      if (!proofCovers({ proof: req.body?.[`${channel}Proof`], channel, destination, secret: SESSION_SECRET })) {
        throw new HttpError(400, `Please verify the ${channel === 'email' ? 'email address' : 'phone number'}.`)
      }
    }

    // No password is supplied: the account starts on its username plus 123,
    // which the administrator can always work out and a reset returns it to.
    const recruiter = await createRecruiter({
      companyId: company.id, firstName, lastName,
      photoName: req.file?.filename ?? null,
      isOrgAdmin: false,
      email: email || null,
      phone: phone || null,
      /* Not asked for on this form, and not blank either: the website belongs
         to the company, so a new seat starts on whatever the rest of the team
         is already saying. See companyWebsite. */
      website: companyWebsite(company.id),
    })

    /* One more seat means a smaller share each, where the split is on — and an
       allowance for the colleague who has just arrived, who would otherwise
       hold a seat they cannot spend anything from. */
    resettleSeats(company.id)

    /*
     * No seat is assigned here. §14.4 makes entitlement a count the
     * organization owns and occupancy the number of accounts that exist, so
     * creating an account fills a seat by definition and deleting one frees it
     * with no bookkeeping to keep in step.
     */
    res.status(201).json({
      // The administrator has to pass these on, so they are returned together.
      created: {
        id: recruiter.id,
        name: `${firstName} ${lastName}`,
        username: recruiter.username,
        // Returned once, at creation, because this is the only moment the
        // plaintext exists — it is hashed on the way into the database.
        password: recruiter.initialPassword,
        // getCompany returns the raw row, so the column name is join_key here —
        // company.joinKey only exists on what createCompany returns.
        joinKey: company.join_key,
      },
      colleagues: listRecruiters(company.id, { withContact: true }),
      seats: seatEntitlement(company.id),
    })
  } catch (error) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
    next(error)
  }
})

// ---------------------------------------------------------------- billing ---

/**
 * Seats and money are the org admin's business only. Resolves the caller to
 * their company so every billing route below operates on the org they actually
 * belong to, never on an id from the request.
 */
function orgAdminOnly(req, _res, next) {
  const recruiter = getRecruiter(req.session.id)
  if (!recruiter) return next(new HttpError(401, 'Account no longer exists.'))

  if (!recruiter.is_org_admin) {
    return next(new HttpError(403, 'Only the company administrator can manage seats and billing.'))
  }

  const company = getCompany(recruiter.company_id)
  if (!company) return next(new HttpError(404, 'Company not found.'))

  req.recruiter = recruiter
  req.company = company
  next()
}

app.get('/api/company/billing', recruiterOnly, orgAdminOnly, (req, res) => {
  res.json({
    ...walletOverview(getCompany(req.company.id)),
    // The screen has to say "recorded, not charged" while no processor is live.
    simulated: billingSimulated,
    catalogue: pricingCatalogue(),
  })
})

/**
 * The pack catalogue, unauthenticated.
 *
 * §4.1 puts both tabs in front of visitors who have not signed in, because how
 * many seats a team needs is a normal thing to work out before signing up.
 */
app.get('/api/pricing', (_req, res) => {
  res.json({
    ...pricingCatalogue(),
    /* The public page sells the same three products the billing panel does and
       has to be able to carry the same caveat: while no processor is connected
       a purchase is recorded and nothing is charged, and the one screen saying
       "Charged once" without that beside it is the page somebody buys from. */
    simulated: billingSimulated,
  })
})

/**
 * Pricing §14 — buying seat capacity, once.
 *
 * Replaces the recurring per-seat subscription. The price is quoted server-side
 * from the stored tier table against the organization's own purchased total
 * (§14.3): a quantity is accepted from the client, a price never is.
 */
/**
 * Setting the organization's seat subscription.
 *
 * A PUT, and it takes the total the organization wants to be on — not how many
 * to add. That is the whole difference between this and what it replaced: a
 * subscription is a state you move to, so 3 → 1 is as expressible as 1 → 3, and
 * repeating the same request twice leaves the same subscription rather than
 * charging twice.
 *
 * Zero is allowed and means cancelling: back to the administrator alone, which
 * costs nothing. That is why the count is validated against 0 rather than 1.
 */
app.put('/api/company/seat-plan', recruiterOnly, orgAdminOnly, async (req, res, next) => {
  try {
    const seats = Number(req.body?.seats)
    if (!Number.isInteger(seats) || seats < 0) {
      throw new HttpError(400, 'Choose how many additional seats to subscribe to.')
    }
    if (seats > SEAT_SELF_SERVE_MAX) {
      throw new HttpError(
        400,
        `Self-serve covers up to ${SEAT_SELF_SERVE_MAX} additional seats. `
        + 'Contact sales for a larger team.',
      )
    }

    // Quoted inside the request, from the company as it is right now: a client
    // that had the page open while somebody else changed the plan must not be
    // able to bill against the tier it remembers.
    const quote = quoteSeatPlan({ company: getCompany(req.company.id), seats })

    const summaryNow = seatEntitlement(req.company.id)
    if (summaryNow.pending === seats) {
      throw new HttpError(400, 'That reduction is already scheduled.')
    }
    if (quote.seats === quote.current && summaryNow.pending === null) {
      throw new HttpError(400, 'That is already your seat subscription.')
    }

    /*
     * Only an increase is charged for here.
     *
     * Going up starts the higher rate, and the provider seam is where a real
     * subscription would be raised. Going down is not a refund — the
     * organization simply pays less from the next cycle — so there is nothing
     * to charge and nothing to fail.
     */
    let payment = { status: 'paid', reference: null }
    if (quote.change > 0) {
      payment = await chargeAndReport({
        req,
        amount: quote.change,
        currency: quote.currency,
        description: `Cursus seat subscription — ${seats} additional seat${seats === 1 ? '' : 's'} per month`,
        productType: 'Seats',
        refusal: 'The payment was not completed, so the subscription is unchanged.',
      })
    }

    let summary
    try {
      summary = setSeatPlan({
        companyId: req.company.id,
        seats,
        provider: billingProvider.name,
        providerRef: payment.reference,
        actorId: req.recruiter.id,
      })
    } catch (error) {
      // The only refusal it raises is "somebody is sitting in that seat", which
      // is the administrator's to resolve rather than a server fault.
      throw new HttpError(400, error.message)
    }

    track('seat_plan_changed', { actorType: 'recruiter', actorId: req.recruiter.id })
    /* Only when the subscription grows. A reduction is churn rather than
       revenue, and reporting it as "New purchase — Seats" would read as the
       opposite of what happened. */
    if (seats > 0) {
      notifySlack('New purchase — Seats', [
        `${req.company.name} · ${recruiterName(req.recruiter)}`,
        `${seats} Seat(s) · ${quote.formatted.monthly}`,
        stamp(),
      ])
    }

    res.json({
      ...walletOverview(getCompany(req.company.id)),
      plan: {
        seats,
        monthly: quote.formatted.monthly,
        reference: payment.reference,
        /* A reduction is scheduled rather than done, so the answer says when
           it happens — the client has nothing else to tell the administrator
           with, and "cancelled" without a date reads as "gone now". */
        scheduled: quote.reducing,
        effectiveFrom: quote.effectiveFrom,
      },
      seatSummary: summary,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * What a given subscription would cost, before anything changes.
 *
 * The same function the PUT prices against, so what an administrator is shown
 * and what they are charged cannot disagree.
 */
app.get('/api/company/seat-plan/quote', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    const seats = Number(req.query?.seats)
    if (!Number.isInteger(seats) || seats < 0) {
      throw new HttpError(400, 'Choose how many additional seats to subscribe to.')
    }
    res.json(quoteSeatPlan({ company: getCompany(req.company.id), seats }))
  } catch (error) {
    next(error)
  }
})

/**
 * §3 — buying reveals.
 *
 * The pack key names a row in the configuration; its price is read from there
 * and never from the request, so a client cannot name its own total.
 */
app.post('/api/company/reveals/purchase', recruiterOnly, orgAdminOnly, async (req, res, next) => {
  try {
    const pack = findRevealPack(String(req.body?.pack ?? ''))
    if (!pack) throw new HttpError(400, 'Choose one of the available Reveal Packs.')

    const payment = await chargeAndReport({
      req,
      amount: pack.total,
      currency: CURRENCY,
      description: `Cursus Reveal Pack — ${pack.reveals} reveals`,
      productType: 'Reveals',
      refusal: 'The payment was not completed, so no reveals were added.',
    })

    const balance = creditReveals({
      companyId: req.company.id,
      quantity: pack.reveals,
      event: 'purchase',
      amount: pack.total,
      packKey: pack.key,
      provider: billingProvider.name,
      providerRef: payment.reference,
      actorId: req.recruiter.id,
    })

    track('reveals_purchased', { actorType: 'recruiter', actorId: req.recruiter.id })
    notifySlack('New purchase — Reveals', [
      `${req.company.name} · ${recruiterName(req.recruiter)}`,
      `${pack.reveals} Reveals · ${formatAmount(pack.total)}`,
      stamp(),
    ])

    res.status(201).json({
      ...walletOverview(getCompany(req.company.id)),
      purchased: { reveals: pack.reveals, amount: formatAmount(pack.total), reference: payment.reference },
      balance,
    })
  } catch (error) {
    next(error)
  }
})


/**
 * Buying Triage CV capacity.
 *
 * Deliberately a sibling of the reveal purchase rather than a branch inside it:
 * they credit different columns and a shared route would be one `if` away from
 * adding reveals to a Triage purchase. The two products meet in the ledger and
 * nowhere else.
 */
app.post('/api/company/triage/purchase', recruiterOnly, orgAdminOnly, async (req, res, next) => {
  try {
    const pack = findTriagePack(String(req.body?.pack ?? ''))
    if (!pack) throw new HttpError(400, 'Choose one of the available Triage packs.')

    const payment = await chargeAndReport({
      req,
      amount: pack.total,
      currency: CURRENCY,
      description: `Cursus Triage — ${pack.cvs} CVs of processing capacity`,
      productType: 'Triage',
      refusal: 'The payment was not completed, so no Triage capacity was added.',
    })

    const balance = creditTriages({
      companyId: req.company.id,
      quantity: pack.cvs,
      event: 'purchase',
      amount: pack.total,
      packKey: pack.key,
      provider: billingProvider.name,
      providerRef: payment.reference,
      actorId: req.recruiter.id,
    })

    track('triage_purchased', {
      actorType: 'recruiter', actorId: req.recruiter.id, quantity: pack.cvs,
    })
    notifySlack('New purchase — Triage', [
      `${req.company.name} · ${recruiterName(req.recruiter)}`,
      `${pack.cvs} CVs · ${formatAmount(pack.total)}`,
      stamp(),
    ])

    res.status(201).json({
      ...walletOverview(getCompany(req.company.id)),
      purchased: {
        cvs: pack.cvs,
        amount: formatAmount(pack.total),
        reference: payment.reference,
      },
      triageBalance: balance,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * §12 — automatic replenishment, reveals only and never preselected.
 *
 * Sending no pack turns it off. `setAutoReplenish` refuses anything that is not
 * a Reveal Pack rather than trusting this route to have checked.
 */
app.patch('/api/company/auto-replenish', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    const packKey = req.body?.pack ? String(req.body.pack) : null
    res.json(setAutoReplenish({ companyId: req.company.id, packKey }))
  } catch (error) {
    next(new HttpError(400, error.message))
  }
})

/**
 * §7.2 — how the organization's reveals are shared out across its seats.
 *
 * A division of one balance, not a set of sub-wallets: the organization still
 * owns every reveal, and an allowance only bounds how many one person may draw
 * of it. Null for a seat returns it to the shared pool.
 *
 * The whole map arrives at once because redistribution is the normal case, and
 * applied seat by seat it would transiently exceed the balance — so a valid end
 * state would be rejected on the way to itself.
 */
/*
 * §9 — the same control for Triage capacity.
 *
 * Deliberately a sibling of the reveal allocation routes rather than a shared
 * one with a product parameter: the two currencies buy different things, and a
 * single endpoint taking a "product" field is one typo away from an admin
 * setting reveal allowances while believing they set Triage ones.
 *
 * Admin-only, through the same orgAdminOnly gate. A recruiter cannot raise
 * their own ceiling — that is the entire point of a ceiling.
 */
app.get('/api/company/triage-allocations', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    res.json(triageAllocations(req.company.id))
  } catch (error) {
    next(error)
  }
})

app.put('/api/company/triage-allocations', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    const raw = req.body?.allocations
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'Send an allowance for each account.')
    }

    const allocations = {}
    for (const [id, value] of Object.entries(raw)) {
      if (value === null || value === undefined || value === '') {
        /* Blank means no ceiling — the seat draws from the shared pool. That is
           the default, and it has to stay expressible or an admin could never
           undo a limit they set by mistake. */
        allocations[Number(id)] = null
        continue
      }
      const amount = Number(value)
      if (!Number.isInteger(amount) || amount < 0) {
        throw new HttpError(400, 'An allowance is a whole number of CVs, or empty for no limit.')
      }
      allocations[Number(id)] = amount
    }

    track('triage_allowances_set', { actorType: 'recruiter', actorId: req.recruiter.id })
    res.json(setTriageAllocations({ companyId: req.company.id, allocations }))
  } catch (error) {
    next(error)
  }
})

/*
 * Whether a product's capacity is shared out automatically.
 *
 * One route, one product per call — never both at once. An admin turning Triage
 * splitting off has said nothing about reveals, and a route that took a single
 * flag for the pair would make that impossible to express.
 *
 * The answer carries the allowance tables back, because turning the switch on
 * rewrites every allowance and the screen would otherwise be showing the old
 * ones until something else refetched.
 */
app.put('/api/company/split-equally', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    const product = String(req.body?.product ?? '')
    if (product !== 'reveal' && product !== 'triage') {
      throw new HttpError(400, 'Say which capacity: reveal or triage.')
    }
    if (typeof req.body?.enabled !== 'boolean') {
      throw new HttpError(400, 'Say whether to split it equally.')
    }

    setSplitEqually({ companyId: req.company.id, product, enabled: req.body.enabled })

    res.json({
      splitEqually: {
        reveal: splitsEqually(req.company.id, 'reveal'),
        triage: splitsEqually(req.company.id, 'triage'),
      },
      reveal: revealAllocations(req.company.id),
      triage: triageAllocations(req.company.id),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/company/reveal-allocations', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    res.json(revealAllocations(req.company.id))
  } catch (error) {
    next(error)
  }
})

app.put('/api/company/reveal-allocations', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    const raw = req.body?.allocations
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, 'Send an allocation for each account.')
    }

    const allocations = {}
    for (const [id, value] of Object.entries(raw)) {
      if (value === null || value === undefined || value === '') {
        allocations[Number(id)] = null
        continue
      }
      const amount = Number(value)
      if (!Number.isInteger(amount) || amount < 0) {
        throw new HttpError(400, 'An allowance is a whole number, or empty for no limit.')
      }
      allocations[Number(id)] = amount
    }

    res.json(setRevealAllocations({ companyId: req.company.id, allocations }))
  } catch (error) {
    // setRevealAllocations throws plain Errors for the two states an admin can
    // actually cause — over-allocating, and naming somebody else's account.
    next(error instanceof HttpError ? error : new HttpError(400, error.message))
  }
})


/**
 * A recruiter editing their own profile: name and contact details, one save.
 *
 * Separate from PATCH /api/recruiter/:id, which is how an *administrator*
 * edits somebody else and is gated on that. This is the same person acting on
 * their own account, so it needs no admin right — and it must not accept a
 * target id, or it would be that route with the gate taken off.
 *
 * Declared above that route on purpose. Express matches in order, and "me" is
 * a perfectly good :id — with this below, every save here was quietly handled
 * by the administrator's route instead, which took the name and ignored the
 * contact details entirely. It answered 200 while changing half of what was
 * asked for.
 *
 * The username is deliberately untouched by a change of name. It is the
 * credential the account signs in with; deriving it from the name at creation
 * is a convenience, and quietly rewriting it later would log somebody out of
 * their own account for correcting a typo in their surname.
 */
app.patch('/api/recruiter/me', recruiterOnly, async (req, res, next) => {
  try {
    const recruiter = getRecruiter(req.session.id)
    if (!recruiter) throw new HttpError(401, 'Account no longer exists.')

    const firstName = capitalizeName(req.body?.firstName ?? '')
    const lastName = capitalizeName(req.body?.lastName ?? '')
    if (!firstName) throw new HttpError(400, 'First name is required.')
    if (!lastName) throw new HttpError(400, 'Last name is required.')

    const { email, phone, website } = readAdminContact(req.body)

    /*
     * A changed email or phone has to be proved again, exactly as on the
     * contact route. A verified address that can be swapped for an unverified
     * one afterwards was never verified, and this is the account that reaches
     * candidate contact details.
     */
    for (const [channel, destination] of [['email', email], ['phone', phone]]) {
      const current = channel === 'email' ? recruiter.email : recruiter.phone
      if (normalizeDestination(channel, destination) === normalizeDestination(channel, current)) continue
      if (!proofCovers({ proof: req.body?.[`${channel}Proof`], channel, destination, secret: SESSION_SECRET })) {
        throw new HttpError(400, `Please verify your new ${channel === 'email' ? 'email address' : 'phone number'}.`)
      }
    }

    updateRecruiter(recruiter.id, {
      firstName,
      lastName,
      photoName: recruiter.photo_name,
      contact: { email, phone, website },
    })

    /*
     * One website for the company, set by whoever administers it.
     *
     * Email and phone are personal and stay on the row they were typed into.
     * The website is not — so an administrator editing theirs is editing the
     * company's, and leaving colleagues on the old address would mean the team
     * quietly disagreed about where it works.
     */
    if (recruiter.is_org_admin && website !== recruiter.website) {
      setCompanyWebsite(recruiter.company_id, website)
    }

    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

/**
 * Editing a recruiter's name or photo. Multipart for the same reason
 * registration is.
 *
 * Profiles are managed by the company administrator: they may edit their own
 * account and any colleague in the same company, and nobody else may edit at
 * all. ":id" accepts "me" so the admin's own profile screen does not have to
 * know its own row id.
 *
 * The username is deliberately left alone: it was derived from the name at
 * sign-up, but it is also half of the sign-in credential, so regenerating it
 * here would lock the account out of its own sign-in.
 */
app.patch('/api/recruiter/:id', recruiterOnly, orgAdminOnly, photoUpload, async (req, res, next) => {
  try {
    const recruiter = targetRecruiter(req)

    const firstName = capitalizeName(req.body?.firstName ?? '')
    const lastName = capitalizeName(req.body?.lastName ?? '')
    if (!firstName) throw new HttpError(400, 'First name is required.')
    if (!lastName) throw new HttpError(400, 'Last name is required.')

    const removePhoto = String(req.body?.removePhoto) === 'true'
    const photoName = req.file ? req.file.filename
      : removePhoto ? null
        : recruiter.photo_name

    /*
     * Contact details, when the caller sends them.
     *
     * Optional, because an account an administrator created starts with none
     * and a rename must not be refused for a website nobody has entered yet.
     * Sending any one of the three brings all three under the usual rule, since
     * that is what readAdminContact validates as a set.
     *
     * A changed email or phone still has to be proved with a code sent to the
     * new destination — the same requirement the account holder faces on their
     * own profile. That is not a formality even here: an administrator can
     * already reset this password to a known value, so they can already reach
     * the account, and the proof is what keeps a mistyped address from silently
     * becoming the one the account answers to.
     */
    const touchesContact = ['email', 'phone', 'website'].some((key) => key in (req.body ?? {}))
    let contact = null

    if (touchesContact) {
      const { email, phone, website } = readAdminContact(req.body)

      for (const [channel, destination] of [['email', email], ['phone', phone]]) {
        const current = channel === 'email' ? recruiter.email : recruiter.phone
        if (normalizeDestination(channel, destination) === normalizeDestination(channel, current)) continue
        if (!proofCovers({ proof: req.body?.[`${channel}Proof`], channel, destination, secret: SESSION_SECRET })) {
          throw new HttpError(400, `Please verify the new ${channel === 'email' ? 'email address' : 'phone number'}.`)
        }
      }

      /*
       * The website that came back is ignored in favour of the company's.
       *
       * This form shows it and does not offer to change it — it is not this
       * person's to change — but a route that trusted the field would let one
       * be set by anything that could post to it. Read from the company, so
       * what is stored is what the company says whatever arrived here.
       */
      contact = { email, phone, website: companyWebsite(recruiter.company_id) ?? website }
    }

    updateRecruiter(recruiter.id, { firstName, lastName, photoName, contact })

    // Unlink only after the row stops referencing the old file, so a failure
    // here leaves a stray file rather than a broken avatar.
    if ((req.file || removePhoto) && recruiter.photo_name) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, recruiter.photo_name)).catch(() => {})
    }

    const updated = getRecruiter(recruiter.id)
    res.json({
      recruiter: {
        id: updated.id,
        firstName: updated.first_name,
        lastName: updated.last_name,
        username: updated.username,
        company: updated.company_name,
        joinKey: updated.join_key,
        hasPhoto: Boolean(updated.photo_name),
        photoVersion: photoVersion(updated.photo_name),
        isOrgAdmin: Boolean(updated.is_org_admin),
      },
      // Saves the Team list a second round trip after an edit.
      colleagues: listRecruiters(updated.company_id, { withContact: true }),
    })
  } catch (error) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
    next(error)
  }
})


/**
 * Resolves ":id" (or "me") to a recruiter in the caller's own company. A missing
 * account and one in another company both 404 — an admin has no business
 * learning which ids exist elsewhere.
 */
function targetRecruiter(req) {
  const id = req.params.id === 'me' ? req.recruiter.id : Number(req.params.id)
  const recruiter = getRecruiter(id)

  if (!recruiter || recruiter.company_id !== req.recruiter.company_id) {
    throw new HttpError(404, 'No such account in your company.')
  }
  return recruiter
}

app.get('/api/recruiter/:id/deletion-preview', recruiterOnly, orgAdminOnly, (req, res, next) => {
  try {
    const target = targetRecruiter(req)
    res.json({
      recruiter: {
        id: target.id,
        name: recruiterDisplayName(target),
        username: target.username,
      },
      ...recruiterDeletionPreview(target.id),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Deleting a colleague's account. The username has to be typed back, matching
 * how a candidate deletes their own account — the cost of a misclick here is
 * someone else's folders and conversations.
 */
app.delete('/api/recruiter/:id', recruiterOnly, orgAdminOnly, async (req, res, next) => {
  try {
    const target = targetRecruiter(req)

    // Deleting yourself would leave the company with no administrator, and so
    // no way to buy seats, manage the team, or delete anyone else.
    if (target.id === req.recruiter.id) {
      throw new HttpError(
        400,
        'You cannot delete your own administrator account. Ask another administrator, '
        + 'or delete the company instead.',
      )
    }

    if (String(req.body?.confirm ?? '').trim() !== target.username) {
      throw new HttpError(400, `Type ${target.username} exactly to confirm.`)
    }

    const removed = {
      name: recruiterName(target),
      email: target.email ?? '(no email)',
    }

    const photo = deleteRecruiterCompletely(target.id)
    /* And a seat fewer means a larger one. */
    resettleSeats(req.company.id)

    track('recruiter_account_deleted', { actorType: 'recruiter', actorId: req.recruiter.id })
    notifySlack('Recruiter account deleted', [
      `${removed.name} · ${req.company.name}`,
      removed.email,
      stamp(),
    ])
    if (photo) await fs.promises.unlink(path.join(UPLOAD_DIR, photo)).catch(() => {})

    res.json({
      deleted: { id: target.id, username: target.username },
      colleagues: listRecruiters(req.recruiter.company_id, { withContact: true }),
      seats: seatEntitlement(req.recruiter.company_id),
    })
  } catch (error) {
    next(error)
  }
})

// ------------------------------------------------------------- passwords ---

/**
 * Stored passwords are scrypt hashes with a random salt, so there is no route
 * that reveals one — not for the administrator either. The two things that are
 * actually needed are covered instead: an administrator can set a colleague's
 * password, and the account holder can change their own.
 */
app.patch('/api/recruiter/me/password', recruiterOnly, async (req, res, next) => {
  try {
    const recruiter = getRecruiter(req.session.id)
    if (!recruiter) throw new HttpError(401, 'Account no longer exists.')

    const current = String(req.body?.currentPassword ?? '')
    const next_ = String(req.body?.newPassword ?? '')
    const confirm = String(req.body?.confirmPassword ?? '')

    // The current password is required even though the session already proves
    // identity: it is what stops a walk-up on an unlocked screen.
    if (!await verifyPassword(current, recruiter.password_hash)) {
      throw new HttpError(400, 'That is not your current password.')
    }
    // §17's rules govern here too. A password strength rule that only applies
    // on the day an account is created is not a rule — the first change would
    // undo it.
    assertPassword(next_)
    if (next_ !== confirm) throw new HttpError(400, 'The two passwords do not match.')

    await setRecruiterPassword(recruiter.id, next_)
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

/**
 * A recruiter maintaining their own contact details.
 *
 * These are asked for at sign-up (§17) and were then fixed forever, which meant
 * the one place a company's details are read — the approval review — could only
 * ever show what was true on the day they registered.
 *
 * Changing an address re-proves it. A verified email that can be swapped for an
 * unverified one afterwards was never really verified, and this is the account
 * that reaches candidate profiles. The website needs no proof: it is a claim
 * about a company, checked by the human who approves it, not a way in.
 */
app.patch('/api/recruiter/me/contact', recruiterOnly, async (req, res, next) => {
  try {
    const recruiter = getRecruiter(req.session.id)
    if (!recruiter) throw new HttpError(401, 'Account no longer exists.')

    const { email, phone, website } = readAdminContact(req.body)

    const changed = {
      email: normalizeDestination('email', email) !== normalizeDestination('email', recruiter.email),
      phone: normalizeDestination('phone', phone) !== normalizeDestination('phone', recruiter.phone),
    }

    for (const [channel, destination] of [['email', email], ['phone', phone]]) {
      if (!changed[channel]) continue
      if (!proofCovers({ proof: req.body?.[`${channel}Proof`], channel, destination, secret: SESSION_SECRET })) {
        throw new HttpError(400, `Please verify your new ${channel === 'email' ? 'email address' : 'phone number'}.`)
      }
    }

    updateRecruiter(recruiter.id, {
      firstName: recruiter.first_name,
      lastName: recruiter.last_name,
      photoName: recruiter.photo_name,
      contact: { email, phone, website },
    })

    res.json({ ok: true, contact: { email, phone, website } })
  } catch (error) {
    next(error)
  }
})

/** Any recruiter may change their own photo, whatever else is admin-only. */
app.patch('/api/recruiter/me/photo', recruiterOnly, photoUpload, async (req, res, next) => {
  try {
    const recruiter = getRecruiter(req.session.id)
    if (!recruiter) throw new HttpError(401, 'Account no longer exists.')

    const removePhoto = String(req.body?.removePhoto) === 'true'
    if (!req.file && !removePhoto) throw new HttpError(400, 'Choose a photo, or ask to remove it.')

    updateRecruiter(recruiter.id, {
      firstName: recruiter.first_name,
      lastName: recruiter.last_name,
      photoName: req.file ? req.file.filename : null,
    })

    if (recruiter.photo_name) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, recruiter.photo_name)).catch(() => {})
    }

    const updated = getRecruiter(recruiter.id)
    res.json({
      hasPhoto: Boolean(updated.photo_name),
      photoVersion: photoVersion(updated.photo_name),
    })
  } catch (error) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
    next(error)
  }
})

/**
 * An administrator resetting a colleague's password back to the name-derived
 * default. Reset is the only option: an administrator choosing a password would
 * know a value the account holder is likely to keep using, whereas the default
 * is already public knowledge and exists to be replaced. The account holder
 * sets their own from My profile.
 *
 * The new value is returned once, because the administrator has to relay it.
 */
app.patch('/api/recruiter/:id/password', recruiterOnly, orgAdminOnly, async (req, res, next) => {
  try {
    const target = targetRecruiter(req)

    // Refused rather than ignored, so a caller sending one is never left
    // believing a password they chose was applied.
    if (req.body?.password !== undefined) {
      throw new HttpError(400, 'A password cannot be chosen here. This route only resets to the default.')
    }

    const password = defaultPasswordFor(target.username)
    await setRecruiterPassword(target.id, password)

    res.json({ username: target.username, password })
  } catch (error) {
    next(error)
  }
})

/** A recruiter's own photo. Used in the panel header and the team list. */
app.get('/api/recruiter/:id/photo', recruiterOnly, (req, res) => {
  const viewer = getRecruiter(req.session.id)
  const target = getRecruiter(Number(req.params.id))

  // Only visible to colleagues in the same company.
  if (!viewer || !target || viewer.company_id !== target.company_id) {
    return res.status(404).json({ error: 'No photo on file.' })
  }

  const photoPath = resolveUpload(target.photo_name)
  if (!photoPath) return res.status(404).json({ error: 'No photo on file.' })

  sendUploadedFile(res, photoPath)
})

app.post('/api/recruiter/login', limits.login, async (req, res, next) => {
  try {
    const recruiter = await authenticateRecruiter({
      joinKey: req.body?.joinKey,
      username: req.body?.username,
      password: req.body?.password,
    })
    if (!recruiter) throw new HttpError(401, 'Company key, username or password is incorrect.')

    res.json({
      token: startSession(res, req, 'recruiter', recruiter.id),
      recruiter: {
        id: recruiter.id,
        firstName: recruiter.first_name,
        lastName: recruiter.last_name,
        username: recruiter.username,
        company: recruiter.company_name,
        hasPhoto: Boolean(recruiter.photo_name),
      },
    })
  } catch (error) {
    next(error)
  }
})

/*
 * "I have forgotten my password."
 *
 * Two different answers, because there are two different kinds of recruiter
 * account. An organization administrator registered themselves and proved the
 * email address on the account, so a reset can be mailed to it. Every other
 * account was created by that administrator, who chose the password and is the
 * person accountable for the seat — mailing a reset to an address they entered
 * on somebody else's behalf would route account recovery around the only person
 * who is supposed to control it.
 *
 * The answer is deliberately the same shape whether or not the account exists.
 * A different reply for a real username would turn this into a way of testing
 * which people work at a company whose key you happen to know.
 */
app.post('/api/recruiter/forgot-password', limits.login, async (req, res, next) => {
  try {
    const recruiter = findRecruiterForReset({
      joinKey: String(req.body?.joinKey ?? '').trim(),
      username: String(req.body?.username ?? '').trim(),
    })

    if (recruiter?.is_org_admin && recruiter.email) {
      const { token, expiresAt } = issuePasswordReset({
        recruiterId: recruiter.id, secret: SESSION_SECRET,
      })
      const company = getCompany(recruiter.company_id)

      await sendPasswordReset({
        to: recruiter.email,
        name: recruiterDisplayName(recruiter),
        companyName: company?.name ?? 'your company',
        link: `${APP_URL}/hr?reset=${token}`,
        expiresInMinutes: PASSWORD_RESET_MINUTES,
      })

      track('recruiter_password_reset_requested', { actorType: 'recruiter', actorId: recruiter.id })

      return res.json({
        sent: true,
        // The masked address, so somebody who has several can tell which
        // mailbox to open without the reply naming it in full.
        hint: maskEmail(recruiter.email),
        expiresAt,
        ...(OTP_ECHO ? { devToken: token } : {}),
      })
    }

    /*
     * An administrator with no address on file.
     *
     * Accounts made before email became mandatory at registration have none,
     * and there is no channel to send a link down. Telling them to ask their
     * administrator would be absurd — they are the administrator — so this says
     * what is actually true and what actually fixes it. Distinguishing this
     * state costs nothing extra: the reply already tells an observer whether a
     * username is an administrator, which is the trade every reset flow makes
     * in order to say where the link went.
     */
    if (recruiter?.is_org_admin) {
      return res.json({
        sent: false,
        noAddress: true,
      })
    }

    /* Not an administrator: the person who made the account can set a new
       password on it, and routing recovery around them would defeat the
       arrangement. Also the answer for a username that does not exist. */
    return res.json({
      sent: false,
      askAdministrator: true,
    })
  } catch (error) {
    next(error)
  }
})

/** Spend the token from that link and set the new password. */
app.post('/api/recruiter/reset-password', limits.login, async (req, res, next) => {
  try {
    const password = String(req.body?.password ?? '')
    assertPassword(password)

    /*
     * Checked here as well as in the form.
     *
     * The confirmation exists to catch a typo in a masked field, which is a
     * client's job — but this route is reachable without the form, and a reset
     * that silently accepted a mismatch would leave the two disagreeing about
     * what the rule is. The same check guards PATCH /me/password.
     *
     * Only when it is sent: an API client setting a password deliberately has
     * nothing to confirm to itself.
     */
    if ('confirmPassword' in (req.body ?? {}) && String(req.body.confirmPassword) !== password) {
      throw new HttpError(400, 'The two passwords do not match.')
    }

    const recruiter = await redeemPasswordReset({
      token: String(req.body?.token ?? ''),
      password,
      secret: SESSION_SECRET,
    })

    if (!recruiter) {
      throw new HttpError(400, 'That reset link has expired or has already been used. '
        + 'Request a new one from the sign-in page.')
    }

    track('recruiter_password_reset_completed', { actorType: 'recruiter', actorId: recruiter.id })

    /* Deliberately no session. Setting a password is not signing in, and the
       recruiter still needs the company key to get through the door — which is
       the thing an attacker holding only a mailbox would not have. */
    res.json({ reset: true, username: recruiter.username })
  } catch (error) {
    next(error)
  }
})

app.get('/api/recruiter/me', recruiterOnly, (req, res) => {
  const recruiter = getRecruiter(req.session.id)
  if (!recruiter) return res.status(401).json({ error: 'Account no longer exists.' })

  res.json({
    recruiter: {
      id: recruiter.id,
      firstName: recruiter.first_name,
      lastName: recruiter.last_name,
      username: recruiter.username,
      company: recruiter.company_name,
      joinKey: recruiter.join_key,
      hasPhoto: Boolean(recruiter.photo_name),
      photoVersion: photoVersion(recruiter.photo_name),
      isOrgAdmin: Boolean(recruiter.is_org_admin),
      // Asked for at sign-up, so they belong on the profile that sign-up
      // created rather than being write-once fields nobody can correct.
      email: recruiter.email ?? '',
      phone: recruiter.phone ?? '',
      website: recruiter.website ?? '',
    },
    // §15 — so the workspace can say why it is empty rather than showing a
    // wall of failed requests to someone who has done nothing wrong.
    approval: getCompany(recruiter.company_id)?.approval_status ?? 'approved',
    /*
     * The demo search this company registered from, if there was one.
     *
     * The whole point of claiming it is that the recruiter does not have to
     * paste the job description again — so the workspace needs to know it is
     * there. The candidate id is safe to send here and nowhere near the public
     * side: this response is behind recruiterOnly and the company has already
     * been approved by the time anyone can read it.
     */
    resumeSearch: (() => {
      const claimed = claimedSearchFor(recruiter.company_id)
      if (!claimed) return null
      return {
        jobId: claimed.job_id,
        sessionId: claimed.session_id,
        candidateId: claimed.intent_candidate_id,
        jobDescription: claimed.raw_jd ?? null,
      }
    })(),
    /* Contact details only for the administrator, who manages these accounts
       and edits them on the Team screen. See listRecruiters. */
    colleagues: listRecruiters(recruiter.company_id, {
      withContact: Boolean(recruiter.is_org_admin),
    }),
    // Everyone sees the seat count, so a recruiter can tell a colleague why
    // their sign-up was refused. Only the admin sees prices and history.
    seats: seatEntitlement(recruiter.company_id),
    /*
     * Pricing §8 and §16 — the organization balance is visible to every seat,
     * because a recruiter about to reveal needs to know whether they can. What
     * stays admin-only is buying, the ledger and the billing screen.
     */
    wallet: {
      balance: revealBalance(recruiter.company_id),
      /*
       * What the usage meters need, for every seat rather than only for admins.
       *
       * The reveal meter is on My profile, which everybody can reach — billing
       * is admin-only, and a recruiter had no way to see how far through the
       * team's allowance they were. Seats are still admin-only and are read
       * from the billing payload, not from here.
       */
      used: companyRevealsUsed(recruiter.company_id),
      everHeld: companyRevealsUsed(recruiter.company_id) + revealBalance(recruiter.company_id),
      seats: seatEntitlement(recruiter.company_id),
      // §7.2 — this seat's own share, if the admin divided the balance, and
      // how much of it is left. Null means it draws freely from the pool.
      allocation: recruiter.reveal_allocation ?? null,
      allocationLeft: recruiter.reveal_allocation === null
        ? null
        : allocationRemaining(recruiter.id),
      seatUsed: seatUsage(recruiter.id),
      /*
       * What the Capacity view draws: how much of the CURRENT capacity has
       * gone, per product. Everyone sees it — it is the organization balance
       * they can already read, said as a fraction of what was last bought.
       */
      capacity: {
        reveal: capacitySince(recruiter.company_id, 'reveal'),
        triage: capacitySince(recruiter.company_id, 'triage'),
      },
      /*
       * And the two things only an admin has business with: who holds a seat
       * and what it costs, and whether each product divides itself. Absent
       * rather than empty for everybody else, so a non-admin screen cannot
       * accidentally render a colleague's billing dates.
       */
      ...(recruiter.is_org_admin ? {
        seatList: seatList(recruiter.company_id),
        splitEqually: {
          reveal: splitsEqually(recruiter.company_id, 'reveal'),
          triage: splitsEqually(recruiter.company_id, 'triage'),
        },
      } : {}),
      /*
       * The Triage wallet, on the same payload as the reveal one.
       *
       * Every seat sees it, not only admins: the count is what decides whether
       * starting a Triage is even possible, and a recruiter who cannot see it
       * would build a whole draft before finding out. Buying stays admin-only,
       * as it is for reveals and seats.
       */
      triage: {
        balance: triageBalance(recruiter.company_id),
        used: triageCvsUsed(recruiter.company_id),
        /* How many Triage workspaces exist, drafts included — what the rail
           counts beside the word "Triage". A different question from the
           balance above it, and the rail used to answer it with the balance. */
        workspaces: triageWorkspaces(recruiter.company_id),
        maxFiles: TRIAGE.maxFiles,
        /* This seat's own ceiling, if the administrator set one. Null means it
           draws from the shared pool — which is what every seat does until
           somebody decides otherwise. */
        allowance: recruiter.triage_allowance ?? null,
        allowanceLeft: recruiter.triage_allowance === null
          || recruiter.triage_allowance === undefined
          ? null
          : Math.max(0, recruiter.triage_allowance - (recruiter.triage_used ?? 0)),
      },
    },
  })
})

// ---------------------------------------------------- recruiter workspace ---

/**
 * §15 — the gate that replaced the sign-up secret.
 *
 * Mounted on the whole /api/hr prefix rather than added route by route. Every
 * path that reaches a candidate lives under it — search, match, profiles,
 * files, photos, folders, threads — so a route added later is covered by
 * default instead of by remembering. /api/recruiter/* is deliberately outside
 * it: that is a company setting itself up, which a pending company may do.
 *
 * `recruiterOnly` runs here as well as on each route below, because the check
 * needs a session to read. It is the same cookie verification twice, which
 * costs nothing and is the reason no route can be missed.
 */
app.use('/api/hr', recruiterOnly, (req, _res, next) => {
  const recruiter = getRecruiter(req.session.id)
  if (!recruiter) return next(new HttpError(401, 'Account no longer exists.'))

  const company = getCompany(recruiter.company_id)

  /*
   * Fail closed: anything that is not an approval is a refusal.
   *
   * This tested `=== 'pending'`, which meant every other value — a decline, a
   * typo, a state added later — granted full access to candidate profiles. The
   * safe default for a gate is to open for exactly one value and shut for the
   * rest, so a new status can never turn into an accidental permission.
   */
  if (company && company.approval_status !== 'approved') {
    return next(new HttpError(
      403,
      company.approval_status === 'declined'
        ? `${company.name} has not been approved to use Cursus. If you believe this is a `
          + 'mistake, reply to the address you registered with and we will take another look.'
        : `${company.name} has not been approved yet. We check every new company before it can `
          + 'see candidate profiles. We will email you as soon as yours is cleared.',
    ))
  }
  next()
})

/**
 * How many people are on file. A number, and nothing else.
 *
 * This used to answer with listCandidates() — every row of the candidates
 * table, unmasked: names, surnames, emails, phone numbers, CV filenames. The
 * whole point of this product's privacy model is that a recruiter buys one
 * identity at a time through consumeReveal, and this route handed over the lot
 * to anyone with a session, on a screen that read `.length` off it and threw
 * the rest away.
 *
 * If a list is ever wanted here, it has to go through the same gate the
 * single-candidate route uses — candidateForRecruiter with the company's
 * revealed set — rather than come straight out of the table.
 */
app.get('/api/hr/candidates', recruiterOnly, (_req, res) => {
  res.json({ total: countCandidates() })
})

app.get('/api/hr/candidates/:id', recruiterOnly, refuseIfBlocked(), (req, res) => {
  const candidate = getCandidate(Number(req.params.id))
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' })

  // Opening a profile is what counts as a view — listing or ranking does not.
  // Spec §4.6: this is the free `card_expand` half of the funnel; the billable
  // `document_download` event is written by the file route.
  recordViewEvent({
    candidateId: candidate.id,
    recruiter: getRecruiter(req.session.id),
    eventType: 'card_expand',
  })

  const companyId = companyIdFor(req.session.id)
  const revealed = hasRevealed(companyId, candidate.id)

  res.json({
    candidate: recruiterCandidateView(candidate, revealed),
    revealed,
    // Who at this company unlocked them. Shown so a recruiter can see the cost
    // was already paid by a colleague rather than wondering why it was free.
    revealedBy: revealed ? revealedBy(companyId, candidate.id) : null,
    activity: activityStatus(candidate),
    /* Where they have worked, as fixed labels. Free of the reveal gate on
       purpose: an industry is a fact about the work, not about the person. */
    industries: industriesFor(candidate.id),
    /* And what this team calls them, so a profile opened from anywhere shows
       the same strip the row does. */
    tags: listTags({ companyId, candidateId: candidate.id }),
    // Every slot they filled, so the dialog can offer the cover letter and the
    // extra documents rather than the CV alone.
    documents: recruiterDocumentList(candidate, { revealed }),
    thread: listThread(candidate.id, req.session.id),
    threadStatus: threadStatus(candidate.id, req.session.id),
  })
})

/**
 * The candidate's uploads, labelled for the recruiter. Falls back to the legacy
 * CV columns for anyone who applied before the documents table existed, so an
 * older profile still shows its CV.
 */
/**
 * The full candidate view for the dialog, masked or revealed.
 *
 * On top of the masked fields it carries the professional summary — the
 * candidate's own words where they wrote some, otherwise the one drafted from
 * their CV. Free either way: a summary is how a recruiter decides whether to
 * spend a reveal at all, so putting it behind the reveal would defeat the
 * purpose of having one.
 */
function recruiterCandidateView(candidate, revealed) {
  const profile = effectiveProfile(candidate.id)
  /*
   * One field, and it is the sanitised one.
   *
   * This used to fall back to the CV-drafted summary inside the extraction when
   * `notes` was empty — two sources, one of which nothing had ever screened for
   * employer names, reaching recruiters before a reveal. The draft is now
   * copied into `notes` by ensureSummary, through the sanitiser, so there is a
   * single persisted value; reading anything else here would be reading the
   * copy that was not cleaned.
   */
  const written = trimOrNull(candidate.notes)

  return {
    ...candidateForRecruiter(candidate, { revealed }),
    summary: written,
    // Read alongside the summary, and equally unidentifying.
    extracted_title: profile.current_title ?? null,
    seniority: profile.seniority ?? null,
  }
}

function recruiterDocumentList(candidate, { revealed = false } = {}) {
  const rows = listDocuments(candidate.id)
  // Legacy slots included, or a file uploaded under the old form would be
  // listed with no name at all.
  const labels = Object.fromEntries(
    [...DOCUMENT_SLOTS, ...LEGACY_DOCUMENT_SLOTS].map((s) => [s.key, s.label]),
  )

  const legacy = rows.length === 0 && candidate.stored_name
    ? [{
      slot: 'cv',
      file_name: candidate.file_name,
      file_size: candidate.file_size ?? null,
      mime_type: null,
    }]
    : rows

  return legacy
    // Slot order, not insertion order: CV first, then cover letter, then extras.
    .sort((a, b) => DOCUMENT_SLOT_KEYS.indexOf(a.slot) - DOCUMENT_SLOT_KEYS.indexOf(b.slot))
    .map((row) => ({
      slot: row.slot,
      label: labels[row.slot] ?? row.slot,
      file_size: row.file_size,
      previewable: row.mime_type === 'application/pdf'
        || String(row.file_name ?? '').toLowerCase().endsWith('.pdf'),
      // A filename identifies someone as squarely as a surname does —
      // "Matan Cutler CV.pdf" is not pseudonymous. Withheld until the reveal.
      file_name: revealed ? row.file_name : null,
    }))
}

/**
 * §12 — the automatic top-up, actually buying something.
 *
 * The billing panel offers "Top up automatically when the balance reaches
 * zero", an admin can choose a pack, the choice is stored and read back, and
 * for a while that was the whole of it: nothing anywhere ever charged for a
 * pack or credited one, so the only thing the setting changed was the text in
 * the dropdown. An unkept promise about money is worse than no promise.
 *
 * Here rather than inside consumeReveal because charging is asynchronous and
 * consumeReveal is a synchronous SQLite transaction — which is exactly what
 * makes it safe to race. This runs before that transaction, never inside it.
 *
 * Returns true if the balance was topped up. Every failure is a false: a
 * declined card at this moment should read to the recruiter as "out of
 * reveals", which is true, and not as an error about somebody else's payment
 * method in the middle of their search.
 */
async function autoReplenish(companyId, actorId) {
  const company = getCompany(companyId)
  const pack = findRevealPack(String(company?.auto_replenish_pack ?? ''))
  if (!pack) return false

  try {
    const payment = await billingProvider.charge({
      companyId,
      amount: pack.total,
      currency: CURRENCY,
      description: `Cursus Reveal Pack — ${pack.reveals} reveals (automatic top-up)`,
    })
    if (payment.status !== 'paid') return false

    creditReveals({
      companyId,
      quantity: pack.reveals,
      // Its own event, so the ledger distinguishes what an admin chose to buy
      // from what the setting bought on their behalf. The schema reserved this
      // event name for it and nothing had ever written one. §12 asks for the
      // distinction and the billing history is where anyone would look for it.
      event: 'auto_purchase',
      amount: pack.total,
      packKey: pack.key,
      provider: billingProvider.name,
      providerRef: payment.reference,
      actorId,
      note: `${pack.reveals} reveals topped up automatically`,
    })

    // The dead column comes alive: the panel can say when it last fired.
    db.prepare(`UPDATE companies SET auto_replenish_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), companyId)

    track('reveals_auto_replenished', { actorType: 'recruiter', actorId })
    return true
  } catch {
    return false
  }
}

/**
 * The reveal, as a deliberate act.
 *
 * The one moment the platform bills on, and the only way to a candidate's
 * surname, contact details, documents and photograph. Everything short of it —
 * browsing, expanding a card, reading your team's notes, messaging — is free
 * and stays pseudonymous.
 *
 * Idempotent: revealing someone already revealed returns their details and
 * charges nothing further.
 */
app.post('/api/hr/candidates/:id/reveal', recruiterOnly, refuseIfBlocked(), async (req, res, next) => {
  try {
    const candidate = getCandidate(Number(req.params.id))
    if (!candidate) throw new HttpError(404, 'Candidate not found.')

    const activity = activityStatus(candidate)
    if (!activity.visibleToRecruiters) {
      throw new HttpError(409, 'This candidate is no longer open to opportunities.')
    }

    const recruiter = getRecruiter(req.session.id)
    const companyId = recruiter?.company_id ?? null

    /*
     * Pricing §9 — this is where the money moves.
     *
     * `consumeReveal` owns the whole decision: whether the organization already
     * holds this candidate, whether the wallet has a reveal to spend, whether
     * this seat is inside any cap the admin set, and the atomic deduction. It
     * is the backend, not the frontend, that is the source of truth, and the
     * ordering inside that transaction is what makes two concurrent attempts
     * cost exactly one (§17.1).
     */
    let charge = consumeReveal({
      companyId,
      candidateId: candidate.id,
      recruiterId: req.session.id,
      allocation: recruiter?.reveal_allocation ?? null,
    })

    /*
     * Empty wallet, and a standing instruction to refill it. Tried once: if the
     * top-up fails, or buys a pack that somebody else immediately spends, the
     * recruiter is told the organization is out of reveals rather than sitting
     * through a second charge attempt. A seat that has spent its own allocation
     * is not a wallet problem and must not trigger a purchase.
     */
    if (!charge.ok && charge.reason === 'no_balance'
        && await autoReplenish(companyId, req.session.id)) {
      charge = consumeReveal({
        companyId,
        candidateId: candidate.id,
        recruiterId: req.session.id,
        allocation: recruiter?.reveal_allocation ?? null,
      })
    }

    if (!charge.ok) {
      /*
       * §11.2 and §11.3 are different states and must not share a message. One
       * is the organization out of reveals — which the admin is told about and
       * can fix by buying — and the other is one seat at a cap its own admin
       * set, while the organization still has balance.
       */
      if (charge.reason === 'allocation_spent') {
        throw new HttpError(
          402,
          `You have used all ${charge.allocation} reveals your administrator allocated to you. `
          + 'Your organization still has some; ask them for a larger share.',
        )
      }

      throw new HttpError(
        402,
        recruiter?.is_org_admin
          ? 'Your organization has used all available reveals. Purchase another Reveal Pack '
            + 'to continue revealing candidates.'
          : 'Your organization is out of reveals. Ask your account administrator to buy '
            + 'another Reveal Pack.',
      )
    }

    // The per-recruiter row stays: it records who in the company opened them,
    // which the reveal ledger does not answer on its own.
    const alreadyHeld = hasRevealed(companyId, candidate.id)
    const first = alreadyHeld
      ? false
      : recordReveal({ recruiterId: req.session.id, candidateId: candidate.id, companyId })

    // Only logged the first time: the funnel counts people revealed, not
    // dialogs reopened, and not colleagues opening what the company already has.
    if (first) {
      recordViewEvent({ candidateId: candidate.id, recruiter, eventType: 'document_download' })
      track('candidate_revealed', { actorType: 'recruiter', actorId: req.session.id })
      activatedOnce('recruiter_first_reveal', recruiter, req.company)

      /*
       * The candidate is told, every time, by whichever company just paid.
       *
       * Inside `first` rather than beside it, which is what makes this exactly
       * once per charged reveal: a colleague opening the same profile costs
       * nothing and is not a second disclosure, so it is not a second email.
       * A refused or failed reveal never reaches this line at all.
       *
       * Not awaited. A mail failure must not turn a reveal the organization
       * has already been charged for into a 500, and the recruiter is waiting
       * on the unmasked profile rather than on our outbox.
       */
      if (candidate.email) {
        sendRevealNotice({
          to: candidate.email,
          name: candidate.first_name ?? candidate.name,
          companyName: req.company?.name,
        }).catch((error) => {
          console.warn(`  reveal notice failed for candidate ${candidate.id}: ${error.message}`)
        })
      }
    }

    res.json({
      revealed: true,
      first,
      // §16 — the balance travels with every reveal, so the header can update
      // without a second request and the recruiter always knows what is left.
      balance: charge.balance,
      charged: charge.charged,
      // Present whenever a colleague got there first, so the UI can say so.
      revealedBy: revealedBy(companyId, candidate.id),
      candidate: recruiterCandidateView(candidate, true),
      documents: recruiterDocumentList(candidate, { revealed: true }),
      activity,
      thread: listThread(candidate.id, req.session.id),
      threadStatus: threadStatus(candidate.id, req.session.id),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Your team's notes about one candidate.
 *
 * Free of the reveal gate: a note is your own team's writing, not the
 * candidate's data, and being able to read "Dana spoke to them in June" before
 * deciding whether to spend a reveal is exactly when it is worth most.
 */
app.get('/api/hr/candidates/:id/comments', recruiterOnly, refuseIfBlocked(), (req, res, next) => {
  try {
    const candidateId = Number(req.params.id)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    res.json({ comments: listComments({ companyId: companyIdFor(req.session.id), candidateId }) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/hr/candidates/:id/comments', recruiterOnly, refuseIfBlocked(), (req, res, next) => {
  try {
    const candidateId = Number(req.params.id)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    /* Long enough for a paragraph about a phone call, short enough that this is
       never mistaken for a document store. */
    const body = String(req.body?.body ?? '').trim().slice(0, 2000)
    if (!body) throw new HttpError(400, 'Write something before posting it.')

    const comments = addComment({
      companyId: companyIdFor(req.session.id),
      candidateId,
      recruiterId: req.session.id,
      body,
    })

    res.status(201).json({ comments })
  } catch (error) {
    next(error)
  }
})

/**
 * What your team calls this candidate.
 *
 * Alongside the comments and under the same rules: shared with the company,
 * never with the candidate, readable before a reveal. Free of the gate for the
 * same reason — "phone screened by Dana" is worth knowing before you spend one.
 */
app.get('/api/hr/candidates/:id/tags', recruiterOnly, refuseIfBlocked(), (req, res, next) => {
  try {
    const candidateId = Number(req.params.id)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    res.json({
      tags: listTags({ companyId: companyIdFor(req.session.id), candidateId }),
      max: MAX_TAGS,
      colours: TAG_COLOURS,
    })
  } catch (error) {
    next(error)
  }
})

app.put('/api/hr/candidates/:id/tags', recruiterOnly, refuseIfBlocked(), (req, res, next) => {
  try {
    const candidateId = Number(req.params.id)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    const wanted = Array.isArray(req.body?.tags) ? req.body.tags : []
    if (wanted.length > MAX_TAGS) {
      throw new HttpError(400, `${MAX_TAGS} tags is the maximum.`)
    }

    res.json({
      tags: setTags({ companyId: companyIdFor(req.session.id), candidateId, tags: wanted }),
      max: MAX_TAGS,
      colours: TAG_COLOURS,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Serves any one of the candidate's five slots. `?slot=` defaults to the CV so
 * older links keep working.
 *
 * Spec §7 — behind the reveal, and not a way around it. The reveal is the
 * deliberate, billed act, POST .../reveal: it draws down the organization's
 * balance and unlocks the candidate's surname, contact details and filenames
 * for the whole company, permanently. Everything short of that is free and
 * stays pseudonymous — browsing, expanding a card, reading your team's notes,
 * messaging — and so is nothing here. This route serves what has already been
 * paid for and checks that on its own account, exactly as the photo route does.
 *
 * Candidates who applied before the documents table existed have their CV on the
 * candidate row instead, so that is the fallback for the cv slot only.
 */
/**
 * Ask an Orange candidate whether they are still looking, without paying to
 * unlock them.
 *
 * Free by construction, not by permission: nothing on this path calls into the
 * wallet, and the response carries no field the recruiter could not already see
 * on the masked card. What they get back is whether the question is now
 * outstanding — not the candidate's address, and not the answer, which arrives
 * later by email and in their own Availability Checks list.
 *
 * Orange only. A Green candidate was here this month and needs no reconfirming;
 * a hidden one is not in discovery to be asked about. Both are refused with the
 * state that caused it, so the client can say which.
 */
app.post('/api/hr/candidates/:id/availability-check', recruiterOnly, refuseIfBlocked(), async (req, res, next) => {
  try {
    const candidate = getCandidate(Number(req.params.id))
    if (!candidate) throw new HttpError(404, 'Candidate not found.')

    const checkable = checkableState(candidate)
    if (!checkable.ok) {
      throw new HttpError(409, checkable.reason === 'green'
        ? 'This candidate has been active in the last 30 days, so there is nothing to confirm.'
        : 'This candidate is not currently visible to recruiters.')
    }

    const companyId = companyIdFor(req.session.id)
    const outcome = requestAvailabilityCheck({
      recruiterId: req.session.id,
      companyId,
      candidateId: candidate.id,
    })

    /*
     * One email however many recruiters asked.
     *
     * `ask` is false when the candidate already has an unanswered question in
     * front of them — from this recruiter, another recruiter, or the freshness
     * sequence. The new request is still registered and will still be resolved
     * by whatever answer arrives; it simply does not generate a second copy of
     * the same question.
     */
    if (outcome.created && outcome.ask && candidate.email) {
      try {
        await sendAvailabilityCheckEmail({
          to: candidate.email,
          name: candidate.first_name ?? candidate.name,
          token: availabilityToken(candidate.id),
          companyName: req.company?.name,
        })
      } catch (error) {
        console.warn(`  availability email failed for candidate ${candidate.id}: ${error.message}`)
      }
    }

    track('availability_check_requested', {
      actorType: 'recruiter', actorId: req.session.id,
    })

    res.status(outcome.created ? 201 : 200).json({
      pending: true,
      alreadyPending: !outcome.created,
      /* So the card can say how long the recruiter is waiting for, without a
         second request. */
      expiresAt: outcome.check?.expires_at ?? null,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Everyone waiting on this candidate's answer, told what it was.
 *
 * Called from both places a candidate can answer — the emailed link and the
 * control inside their own account — because the answer is the same fact
 * however it was given, and a recruiter who asked should not have to care which
 * one the candidate happened to use.
 *
 * Notifications are fired and not awaited: the candidate is waiting on a page
 * that says their status is updated, and that is true whether or not our outbox
 * is healthy.
 */
function notifyAvailabilityWatchers(candidate, answer) {
  const waiting = resolveAvailabilityChecks(candidate.id, answer)
  const candidateName = candidate.name
    ?? [candidate.first_name, candidate.last_name].filter(Boolean).join(' ')

  for (const check of waiting) {
    const recruiter = getRecruiter(check.recruiter_id)
    if (!recruiter?.email) continue

    const send = answer === 'yes'
      ? sendAvailabilityConfirmedEmail({
        to: recruiter.email,
        name: recruiter.first_name,
        candidateName,
        candidateId: candidate.id,
      })
      : sendAvailabilityDeclinedEmail({
        to: recruiter.email,
        name: recruiter.first_name,
        candidateName,
      })

    send.catch((error) => {
      console.warn(`  availability result failed for recruiter ${check.recruiter_id}: ${error.message}`)
    })
  }

  return waiting.length
}

app.get('/api/hr/candidates/:id/file', recruiterOnly, refuseIfBlocked(), (req, res) => {
  const candidate = getCandidate(Number(req.params.id))
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' })

  const slot = String(req.query.slot ?? 'cv')
  if (!DOCUMENT_SLOT_KEYS.includes(slot)) {
    return res.status(400).json({ error: 'Unknown document.' })
  }

  const document = getDocument(candidate.id, slot)
  const storedName = document?.stored_name ?? (slot === 'cv' ? candidate.stored_name : null)
  const fileName = document?.file_name ?? (slot === 'cv' ? candidate.file_name : null)

  const filePath = resolveUpload(storedName)
  if (!filePath) return res.status(404).json({ error: 'No file in that slot.' })

  /*
   * A document is behind the reveal, not a way around it.
   *
   * This route used to call recordReveal() unconditionally — the same row
   * hasRevealed() and revealedCandidateIds() read — so anyone with a session
   * could unlock a candidate permanently, for nothing, by asking for their CV.
   * consumeReveal was never involved: no balance came down, no allowance was
   * drawn, no ledger row was written. With sequential ids it was the whole
   * database for the price of a loop.
   *
   * The gate is the one the photo route already uses a few lines below. Buying
   * the reveal stays the deliberate act it is priced as — POST .../reveal — and
   * this route only ever serves what the organization has already paid for.
   */
  const companyId = companyIdFor(req.session.id)
  if (!revealedCandidateIds(companyId).has(candidate.id)) {
    return res.status(402).json({ error: 'Reveal this candidate before opening their documents.' })
  }

  /* Still logged: §4.6 counts a document opened as the billable half of the
     funnel, and that is true whether or not this request is what paid for it. */
  recordViewEvent({
    candidateId: candidate.id,
    recruiter: getRecruiter(req.session.id),
    eventType: 'document_download',
  })

  // `?inline=1` lets the browser's own viewer render it instead of saving it.
  // res.download always forces an attachment, so it cannot be used here. Only a
  // PDF is worth offering inline — a browser cannot render a DOCX, and claiming
  // it can produces a blank frame rather than an error.
  /*
   * Whether it may be shown inline is decided by the bytes, not by the stored
   * mime_type or the filename — both of which came from the uploader. Only a
   * real PDF is ever rendered; everything else is an attachment, so a file that
   * merely claims to be a PDF cannot be handed to the browser as one.
   */
  const isReallyPdf = sniffFile(filePath)?.type === 'application/pdf'

  if (String(req.query.inline) === '1' && isReallyPdf) {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Rendered, so it needs the sandbox: no scripts, no origin, no session.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    )
    return res.sendFile(filePath)
  }

  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.download(filePath, fileName)
})

/**
 * A candidate's photograph, for a recruiter who has revealed them.
 *
 * The gate is here and not only in the payload that names this URL. It used to
 * be absent altogether: the route served any candidate's face to any signed-in
 * recruiter who put an id in the path, whether or not anyone had paid to see
 * it, and whether or not the interface ever offered them the link. Withholding
 * a field while leaving the file addressable is not withholding it — ids are
 * sequential, and the whole photo library was two lines of script away.
 */
app.get('/api/hr/candidates/:id/photo', recruiterOnly, refuseIfBlocked(), (req, res) => {
  const candidate = getCandidate(Number(req.params.id))
  if (!candidate) return res.status(404).json({ error: 'Candidate not found.' })

  if (!revealedCandidateIds(companyIdFor(req.session.id)).has(candidate.id)) {
    return res.status(403).json({ error: 'Reveal this candidate to see their photo.' })
  }

  const photoPath = resolveUpload(candidate.photo_name)
  if (!photoPath) return res.status(404).json({ error: 'No photo on file.' })

  sendUploadedFile(res, photoPath)
})

/*
 * There is deliberately no recruiter-side candidate deletion.
 *
 * DELETE /api/hr/candidates/:id used to live here. Any signed-in recruiter could
 * name any candidate by id and erase them from the platform — their profile,
 * their documents, their message history, everyone else's notes about them —
 * with no ownership test, no company scoping and no record of who did it. It had
 * no caller in the product; the only thing that ever used it was a test
 * exercising the erasure cascade, which now goes through the candidate's own
 * route as a person actually would.
 *
 * It also made employer blocking pointless in the most direct way available: a
 * recruiter who found themselves hidden from someone could delete the person
 * and the evidence of the block along with them, since the cascade removes the
 * candidate's blocked_companies rows too.
 *
 * Erasing an account is the account holder's decision. DELETE /api/candidate/me
 * is where it belongs, and it is where it now exclusively is.
 */

app.post('/api/hr/parse-jd', recruiterOnly, (req, res) => {
  res.json(parseJobDescription(String(req.body?.jobDescription ?? '')))
})

/**
 * Reads a job description out of an uploaded PDF or DOCX and hands back the
 * text, which the recruiter then sees and can edit before searching.
 *
 * Returning text rather than searching directly is deliberate: extraction from
 * a PDF is imperfect, and a recruiter should see what the model will actually
 * read before spending a search on it.
 *
 * The file is deleted either way. Nothing in the product needs to keep it.
 */
/*
 * The same extraction, for the public demo's paperclip.
 *
 * A separate route rather than loosening the authenticated one: this is the
 * only file upload a stranger can make, so it carries the demo's rate limit
 * rather than a recruiter's, and it stays a route somebody can reason about on
 * its own. It reads a file and hands back its text — it touches no candidate,
 * stores nothing, and the upload is unlinked either way.
 */
app.post('/api/public/demo/jd-text', limits.demo, jdUpload, async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Attach a PDF or DOCX file.')

    const text = await extractText(req.file.path, req.file.originalname)
    if (!text || text.trim().length < 40) {
      throw new HttpError(
        422,
        'Almost no text could be read from that file. If it is a scanned PDF, paste the '
        + 'description instead.',
      )
    }

    res.json({ text: text.trim(), fileName: req.file.originalname })
  } catch (error) {
    next(error)
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
  }
})

app.post('/api/hr/jd-text', recruiterOnly, jdUpload, async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'Attach a PDF or DOCX file.')

    const text = await extractText(req.file.path, req.file.originalname)
    if (!text || text.trim().length < 40) {
      throw new HttpError(
        422,
        'Almost no text could be read from that file. If it is a scanned PDF, paste the '
        + 'description instead.',
      )
    }

    res.json({ text: text.trim(), fileName: req.file.originalname })
  } catch (error) {
    next(error)
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {})
  }
})

/**
 * How many candidates Claude reads per search. Analysis is one call each, so
 * this bounds latency and spend; the rest keep their deterministic score and are
 * labelled as such. Raise it for small candidate pools.
 */
const AI_RANK_LIMIT = Number(process.env.AI_RANK_LIMIT ?? 25)

/**
 * Orders the filtered pool by how close each profile sits to the role, so the
 * expensive reads are spent on the right people.
 *
 * Falls back to the incoming keyword order whenever embeddings are unavailable,
 * the query cannot be embedded, or nothing has been embedded yet. A retrieval
 * layer that fails should cost recall, never results.
 */
async function shortlistFor(criteria, rows) {
  if (!embeddingsConfigured() || rows.length === 0) {
    return { rows, method: 'keyword' }
  }

  try {
    const vectors = allEmbeddings()
    if (vectors.size === 0) return { rows, method: 'keyword' }

    const queryVector = await embedQuery(
      [criteria.title, criteria.jobDescription, criteria.instruction].filter(Boolean).join('\n\n'),
    )

    const byId = new Map(rows.map((row) => [row.candidate.id, row]))
    const ranked = rankBySimilarity([...byId.keys()], queryVector, vectors)

    return {
      rows: ranked.map((entry) => {
        const row = byId.get(entry.id)
        // Kept for the audit trail; never sent to the browser.
        row.similarity = entry.similarity
        return row
      }),
      method: 'semantic',
      embedded: ranked.filter((entry) => entry.similarity !== null).length,
    }
  } catch (error) {
    console.warn(`  semantic shortlisting fell back to keywords: ${error.message}`)
    return { rows, method: 'keyword' }
  }
}

app.post('/api/hr/match', recruiterOnly, async (req, res, next) => {
  try {
    const body = req.body ?? {}

    const criteria = {
      jobDescription: String(body.jobDescription ?? ''),
      title: String(body.title ?? ''),
      requiredSkills: toSkillList(body.requiredSkills),
      preferredSkills: toSkillList(body.preferredSkills),
      // One optional steer from the recruiter, given once with the search.
      // Capped because it goes into every candidate's prompt.
      instruction: String(body.instruction ?? '').trim().slice(0, 2000),
    }
    criteria.keywords = keywordsFrom(criteria.jobDescription)

    const filters = {
      requireAllSkills: Boolean(body.filters?.requireAllSkills),
      minScore: parseNumber(body.filters?.minScore),
      location: trimOrNull(body.filters?.location),
      availability: trimOrNull(body.filters?.availability),
      search: trimOrNull(body.filters?.search),
    }

    const folders = folderIndex(req.session.id)
    const unread = recruiterUnreadByCandidate(req.session.id)
    const slotsByCandidate = documentSlotsByCandidate()
    // Company-wide: what one colleague unlocked is unlocked for the team, so
    // nobody is charged twice for the same person.
    const revealedIds = revealedCandidateIds(companyIdFor(req.session.id))

    const all = listCandidatesWithText()
    const results = []

    /* §11.6 — the people who named this employer and asked not to be seen by
       them. The staged pipeline applies the same set in hardFilter; this is the
       other search path and needs it just as much. */
    const blocked = candidatesBlockingRecruiter(req.session.id)

    for (const candidate of all) {
      if (blocked.has(candidate.id)) continue

      // A candidate who said no is masked from search entirely until they
      // reactivate. Never answering is not the same thing and stays visible.
      const activity = activityStatus(candidate)
      if (!activity.visibleToRecruiters) continue

      const result = scoreCandidate(candidate, criteria)
      if (!passesFilters(candidate, result, filters)) continue

      results.push({
        // Spec §4.1 / §7 — pseudonymous until this recruiter reveals them.
        candidate: candidateForRecruiter(candidate, {
          revealed: revealedIds.has(candidate.id),
        }),
        activity,
        // Which slots they filled — drives the "has a cover letter" style filters.
        documents: slotsByCandidate[candidate.id] ?? [],
        folder: folders[candidate.id] ?? null,
        unread: unread[candidate.id] ?? 0,
        cvText: candidate.cv_text,
        // Only for tie-breaking on the server; never sent.
        sortName: candidate.name ?? '',
        scorer: 'deterministic',
        ...result,
        // Stage 1: absolute fit against the JD's criteria. Kept internally for
        // the audit trail; the recruiter sees the normalised score.
        rawScore: result.score,
      })
    }

    results.sort((a, b) => b.rawScore - a.rawScore || a.sortName.localeCompare(b.sortName))

    /**
     * Who gets read in full.
     *
     * Hard facts have already been filtered exactly, above. What remains is a
     * question of meaning, so the shortlist is chosen by semantic distance
     * where embeddings are available: a candidate who describes the same work
     * in different words still surfaces, and one whose CV merely contains the
     * job description's vocabulary does not displace them.
     *
     * Without embeddings this falls back to the keyword order, which is what
     * the platform did before — worse at recall, never wrong enough to break.
     */
    const retrieval = await shortlistFor(criteria, results)
    const shortlist = retrieval.rows.slice(0, AI_RANK_LIMIT)
    const analyses = await analyseMatches({
      jobDescription: criteria.jobDescription,
      criteria,
      candidates: shortlist.map((row) => ({
        candidate: { ...row.candidate, cv_text: row.cvText },
        profile: effectiveProfile(row.candidate.id),
      })),
    })

    for (const row of results) {
      const analysis = analyses.get(row.candidate.id)
      if (analysis) {
        // Claude's judged fit replaces the keyword score as the raw stage-1
        // number. Still absolute: how well this person meets the requirements.
        row.rawScore = analysis.score
        row.scorer = 'claude'
        row.analysis = {
          fit: analysis.fit,
          confidence: analysis.confidence,
          reasoning: analysis.reasoning,
          strengths: analysis.strengths,
          gaps: analysis.gaps,
          transferable: analysis.transferable,
          evidence: analysis.evidence,
          probes: analysis.probes,
        }
      }
      delete row.cvText
    }

    // Stage 2: the displayed score, relative to the pool that was searched.
    const scored = normalizeAgainstPool(results)
      .sort((a, b) => b.score - a.score
        || b.rawScore - a.rawScore
        || a.sortName.localeCompare(b.sortName))

    // Spec §4.7 — every score is written down, raw and displayed, with which
    // scorer produced it, so a ranking can be explained months later.
    if (scored.length > 0) {
      recordScores(scored.map((row) => ({
        candidateId: row.candidate.id,
        recruiterId: req.session.id,
        criteria,
        score: row.score,
        breakdown: {
          rawScore: row.rawScore,
          displayedScore: row.score,
          poolSize: scored.length,
          retrieval: retrieval.method,
          similarity: row.similarity ?? null,
          components: row.breakdown ?? null,
          analysis: row.analysis ?? null,
        },
        scorer: row.scorer,
        modelVersion: row.scorer === 'claude' ? MODEL : null,
      })))
    }

    /**
     * What the recruiter is allowed to see. The raw score, the component
     * weights and the normalisation mechanics stay on the server: they are the
     * ranking logic, and a JSON response is a published document.
     *
     * What is sent is everything needed to justify the number — matches,
     * misses, evidence, skills, freshness — and nothing that reconstructs it.
     */
    const visible = scored.map((row) => ({
      candidate: row.candidate,
      score: row.score,
      activity: row.activity,
      documents: row.documents,
      folder: row.folder,
      unread: row.unread,
      analysis: row.analysis ?? null,
      matchedRequired: row.matchedRequired,
      missingRequired: row.missingRequired,
      matchedPreferred: row.matchedPreferred,
      missingPreferred: row.missingPreferred,
      meetsAllRequired: row.meetsAllRequired,
    }))

    res.json({
      total: all.length,
      shown: visible.length,
      criteria,
      scoring: {
        engine: analyses.size > 0 ? 'claude' : 'deterministic',
        analysed: analyses.size,
        limit: AI_RANK_LIMIT,
        aiAvailable: aiConfigured(),
        poolSize: visible.length,
        // Whether candidates were shortlisted by meaning or by wording. Not the
        // mechanics — just which of the two is in play.
        retrieval: retrieval.method,
        // The explanation a recruiter is entitled to: what the number means,
        // not how it is computed.
        explanation: 'Scores reflect how well each profile meets the requirements in this job '
          + 'description, and how strong they are relative to the other candidates found for '
          + 'this search. Several candidates can share a score.',
      },
      results: visible,
    })
  } catch (error) {
    next(error)
  }
})

// ------------------------------------------------- staged matching (v1.0) ---

/**
 * Shapes one analysed candidate for the recruiter.
 *
 * The absolute fit, the retrieval components and the normalisation mechanics
 * stay server-side. What crosses the wire is the displayed score plus the
 * evidence behind it — enough to defend the ranking to a hiring manager,
 * nothing that reconstructs it (§17).
 */
function matchRow({ candidate, score, analysis, context }) {
  const revealed = context.revealedIds.has(candidate.id)

  return {
    candidate: candidateForRecruiter(candidate, { revealed }),
    // The flag the list needs: already unlocked for this team, and by whom.
    revealed,
    revealedBy: revealed ? (context.revealedBy?.get(candidate.id) ?? null) : null,
    score,
    activity: activityStatus(candidate),
    documents: context.slots[candidate.id] ?? [],
    folder: context.folders[candidate.id] ?? null,
    /* What this team calls them. On the row itself, because the strip is drawn
       before anybody opens anything. */
    tags: context.tags?.get(candidate.id) ?? [],
    unread: context.unread[candidate.id] ?? 0,
    analysis: analysis
      ? {
        reasoning: analysis.explanation,
        fit: analysis.criteria?.fit ?? null,
        confidence: analysis.criteria?.confidence ?? null,
        strengths: analysis.criteria?.strengths ?? [],
        gaps: analysis.criteria?.gaps ?? [],
        transferable: analysis.criteria?.transferable ?? [],
        evidence: analysis.criteria?.evidence ?? [],
        probes: analysis.criteria?.probes ?? [],
        criteria: analysis.criteria?.items ?? [],
        source: analysis.source,
      }
      : null,
  }
}

/**
 * Turns a pipeline outcome into the response body.
 *
 * @param chatId  the saved search this run belongs to, as the caller has it.
 *
 * Not read off the job: a job is keyed by the hash of its description and is
 * shared by every search of the same text, so its chat_id is whichever search
 * happened to create it first — and null for one created before any chat
 * existed. The caller is the only party that knows which saved search this
 * particular run is for.
 */
function searchResponse(outcome, recruiterId, chatId = null) {
  const companyId = companyIdFor(recruiterId)

  const context = {
    folders: folderIndex(recruiterId),
    unread: recruiterUnreadByCandidate(recruiterId),
    // Only the page being rendered, not the whole documents table.
    slots: documentSlotsByCandidate(outcome.visibleIds),
    // Company-wide: anyone a colleague revealed is already unlocked for the
    // whole team, so results show them unmasked rather than charging twice.
    revealedIds: revealedCandidateIds(companyId),
    revealedBy: revealIndex(companyId),
    tags: tagIndex(companyId),
  }

  // Already filtered for current eligibility by the pipeline — a candidate who
  // deactivated since this search was created is not in here.
  const byId = new Map(outcome.universe.map((row) => [row.candidateId, row]))

  /* One query for the page, in place of a getCandidate() per row — each of
     which returned the candidate's entire CV text to draw a card that shows
     none of it. */
  const people = candidatesByIds(outcome.visibleIds)

  const results = outcome.visibleIds
    .map((id) => {
      const candidate = people.get(id)
      if (!candidate) return null
      return matchRow({
        candidate,
        score: outcome.scores.get(id) ?? 0,
        analysis: byId.get(id) ?? null,
        context,
      })
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score
      || String(a.candidate.display_name ?? '').localeCompare(String(b.candidate.display_name ?? '')))

  return {
    sessionId: outcome.session.id,
    jobId: outcome.job.id,
    jdVersion: outcome.job.jd_version,
    title: outcome.job.title,
    batchIndex: outcome.batchIndex,
    exhausted: outcome.exhausted,
    resumed: outcome.resumed,
    canShowMore: !outcome.exhausted,
    jobProfile: {
      interpretation: outcome.matchProfile.interpretation,
      source: outcome.matchProfile.source,
      concepts: outcome.matchProfile.concepts,
      hardConstraints: outcome.matchProfile.hardConstraints,
      mustHaves: outcome.matchProfile.mustHaves,
      preferred: outcome.matchProfile.preferred,
      logistics: outcome.matchProfile.logistics,
    },
    scoring: {
      analysedThisRequest: outcome.analysed,
      reusedFromCache: outcome.reused,
      analysedUniverse: outcome.universe.length,
      poolSize: outcome.stats.poolSize,
      batchSize: outcome.stats.batchSize,
      model: outcome.analysisModel,
      // §10.2 — said plainly, because a score that moves on Show More looks
      // like instability unless the recruiter is told why it moved.
      explanation: 'Every score is relative to the candidates analysed for this job so far, '
        + 'so asking for more people re-ranks the whole set and an earlier score can move. '
        + 'Several candidates can share a score. '
        + 'To bring in anyone who has joined or become active since you last ran this search, '
        + 'press Refresh on the search itself.',
    },
    results,
    /* Ruled out of this search, by this recruiter. Sent with the results rather
       than fetched separately so the list is never drawn once with the
       dismissed still in it and then again without them. */
    dismissed: dismissedCandidateIds(chatId),
  }
}

/**
 * §16 — one job description in, a ranked shortlist out.
 *
 * Replaces nothing: /api/hr/match still serves the existing single-shot search.
 * This is the staged path, and the difference a recruiter notices is that
 * asking for more people is cheap and the scores stay comparable.
 */
app.post('/api/hr/search', recruiterOnly, async (req, res, next) => {
  try {
    const jobDescription = String(req.body?.jobDescription ?? '').trim()
    if (!jobDescription) throw new HttpError(400, 'Paste or upload a job description to search.')

    /*
     * Resolved once, and checked.
     *
     * It arrives from the body and was passed straight through to runSearch and
     * to dismissedCandidateIds — so a recruiter naming somebody else's saved
     * search had their turns appended to it and read back that stranger's
     * dismissals. The two routes below this one take the same id and get the
     * same treatment.
     */
    const chatId = parseNumber(req.body?.chatId) ?? null
    if (chatId !== null && !getSearchChat(req.session.id, chatId)) {
      throw new HttpError(404, 'Search not found.')
    }

    const outcome = await runSearch({
      recruiterId: req.session.id,
      /* Resolved from the recruiter's row. The session token carries role, id
         and sid and has never carried a company — so this read was always
         undefined, and every job row written since has a NULL company_id. */
      companyId: companyIdFor(req.session.id),
      chatId,
      jobDescription,
      instruction: String(req.body?.instruction ?? '').trim().slice(0, 2000) || null,
      title: trimOrNull(req.body?.title),
      // Run the pool again rather than resuming the stored ranking — see the
      // note on runSearch. Costs only the candidates nobody has read yet.
      refresh: req.body?.refresh === true,
    })

    track('search_run', {
      actorType: 'recruiter', actorId: req.session.id,
      jobId: outcome.job.id, analysed: outcome.analysed, reused: outcome.reused,
    })

    /* Every search is tracked; only the first reaches Slack. */
    activatedOnce('recruiter_first_search', getRecruiter(req.session.id), req.company)

    res.json(searchResponse(outcome, req.session.id, chatId))
  } catch (error) {
    next(error)
  }
})

/** §11 — the next batch, analysed once and only once. */
app.post('/api/hr/search/:sessionId/more', recruiterOnly, async (req, res, next) => {
  try {
    const outcome = await showMore({
      sessionId: Number(req.params.sessionId),
      recruiterId: req.session.id,
    })

    if (outcome.error === 'not_found') throw new HttpError(404, 'That search is no longer available.')
    if (outcome.error === 'forbidden') throw new HttpError(403, 'That search belongs to another recruiter.')

    const chatId = parseNumber(req.body?.chatId) ?? null
    if (chatId !== null && !getSearchChat(req.session.id, chatId)) {
      throw new HttpError(404, 'Search not found.')
    }

    res.json(searchResponse(outcome, req.session.id, chatId))
  } catch (error) {
    next(error)
  }
})

/**
 * Save a candidate to this search's folder, creating the folder if needed.
 *
 * The client used to have to know the folder id, which meant Save quietly did
 * nothing whenever the search had no folder — or had one that was since
 * deleted. Deciding where a saved candidate goes is the server's job: it owns
 * the link between a search and its folder, so it is the only place that can
 * repair it.
 *
 * Free, and deliberately so. Saving is how a recruiter keeps track of someone
 * they are still deciding about; charging for that would push them to reveal
 * people just to avoid losing them.
 */
/** A short list of short strings, or nothing. Whatever the client sent. */
function strings(value, cap = 40) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .slice(0, cap)
    .map((entry) => entry.slice(0, 120))
}

app.post('/api/hr/search/:sessionId/save', recruiterOnly, (req, res, next) => {
  try {
    const session = getSession(Number(req.params.sessionId))
    if (!session) throw new HttpError(404, 'That search is no longer available.')
    if (session.recruiterId !== req.session.id) {
      throw new HttpError(403, 'That search belongs to another recruiter.')
    }

    const candidateId = Number(req.body?.candidateId)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')
    refuseBlockedId(req, candidateId)

    const job = getJob(session.jobId)
    const chat = job?.chat_id ? getSearchChat(req.session.id, job.chat_id) : null

    // The folder the search already owns, but only if it still exists — a
    // recruiter who deleted it should get a new one, not an error.
    let folderId = chat?.folder_id && getFolder(req.session.id, chat.folder_id)
      ? chat.folder_id
      : null

    if (!folderId) {
      const name = chat?.title
        ?? job?.title
        ?? String(job?.raw_jd ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
        ?? 'Saved candidates'

      folderId = createFolder(req.session.id, name || 'Saved candidates')
      if (chat) setChatFolder(chat.id, folderId)
    }

    /*
     * The row the recruiter was looking at when they pressed Save.
     *
     * It has to come from the client, and that is worth justifying. The
     * displayed score is not stored anywhere: it is normalised against the pool
     * that was searched, computed per request, and the pool moves — so asking
     * the server for it again would produce a different number from the one on
     * screen, which is the one that made somebody save this person.
     *
     * What that buys is a record of a judgement, not a live figure, and the
     * dialog says so. What it costs is a value the client chose, so it is
     * bounded here: a number in range, a reading of a sane size, and only for a
     * candidate this session actually retrieved. The blast radius of a lie is
     * one row in the liar's own folder.
     */
    const shown = req.body?.snapshot
    let scored = null

    if (shown && typeof shown === 'object'
      && Number.isFinite(Number(shown.score))
      && session.retrievedIds.includes(candidateId)) {
      const reading = {
        reasoning: typeof shown.reasoning === 'string' ? shown.reasoning.slice(0, 2000) : null,
        matchedRequired: strings(shown.matchedRequired),
        missingRequired: strings(shown.missingRequired),
        matchedPreferred: strings(shown.matchedPreferred),
        missingPreferred: strings(shown.missingPreferred),
      }

      scored = {
        score: Math.max(0, Math.min(100, Math.round(Number(shown.score)))),
        /*
         * Named, so the number still means something once the search has been
         * renamed or deleted. The same fallback chain the folder itself is
         * named from — a search that was never given a title is still the
         * first line of its job description, and that is what an admin will
         * recognise months later.
         */
        forJob: chat?.title
          ?? job?.title
          ?? (String(job?.raw_jd ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null),
        at: new Date().toISOString(),
        analysis: reading,
      }
    }

    placeCandidate({ recruiterId: req.session.id, folderId, candidateId, position: null, scored })

    const folders = listFolders(req.session.id)
    res.json({
      folders,
      folder: folders.find((entry) => entry.id === folderId) ?? null,
    })
  } catch (error) {
    next(error)
  }
})

/** The configured funnel sizes, so the UI never hard-codes them (§17). */
app.get('/api/hr/search/config', recruiterOnly, (_req, res) => {
  res.json({
    poolSize: MATCHING.retrievalPoolSize,
    batchSize: MATCHING.deepAnalysisBatch,
    tagCap: MATCHING.preferenceTagCap,
  })
})

// --------------------------------------------------------- saved searches ---

app.get('/api/hr/chats', recruiterOnly, (req, res) => {
  res.json({ chats: listSearchChats(req.session.id) })
})

app.get('/api/hr/chats/:id', recruiterOnly, (req, res) => {
  const chat = getSearchChat(req.session.id, Number(req.params.id))
  if (!chat) return res.status(404).json({ error: 'Search not found.' })
  res.json({ chat })
})

/**
 * Records a search. Omitting chatId starts a new one; passing it appends a
 * turn, so refining a query stays in the same conversation.
 */
/**
 * Records a search. One chat is one job description, submitted once, so this
 * only ever creates — re-running a saved search does not come back here and
 * does not append another turn.
 */
app.post('/api/hr/chats', recruiterOnly, (req, res, next) => {
  try {
    const query = String(req.body?.query ?? '').trim()
    if (!query) throw new HttpError(400, 'A search needs a query.')

    const criteria = req.body?.criteria ?? {}
    const chatId = createSearchChat(req.session.id, {
      title: criteria.title,
      query,
    })

    // Every search gets a folder of the same name, so saving a candidate from
    // the results needs no decision. The name is read back from the chat rather
    // than recomputed — a repeated search is disambiguated there, and the two
    // must not drift apart.
    const chat = getSearchChat(req.session.id, chatId)
    const folderId = createFolder(req.session.id, chat.title)
    setChatFolder(chatId, folderId)

    appendTurn(chatId, {
      role: 'user',
      content: query,
      // The steer is part of what was asked, so reopening restores it.
      results: { instruction: String(req.body?.instruction ?? '').trim() || null },
    })
    appendTurn(chatId, {
      role: 'assistant',
      content: JSON.stringify(req.body?.criteria ?? {}),
      results: { shown: parseNumber(req.body?.shown), total: parseNumber(req.body?.total) },
    })

    res.status(201).json({
      chatId,
      folderId,
      folders: listFolders(req.session.id),
      chats: listSearchChats(req.session.id),
    })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/hr/chats/:id', recruiterOnly, (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim()
    if (!title) throw new HttpError(400, 'A search needs a name.')

    const chatId = Number(req.params.id)
    if (!renameSearchChat(req.session.id, chatId, title)) {
      throw new HttpError(404, 'Search not found.')
    }

    // The folder carries the search's name, so a rename moves both. Letting
    // them diverge is how a shortlist ends up filed under a role nobody
    // recognises.
    const chat = getSearchChat(req.session.id, chatId)
    if (chat?.folder_id) renameFolder(req.session.id, chat.folder_id, chat.title)

    res.json({ chats: listSearchChats(req.session.id), folders: listFolders(req.session.id) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/hr/chats/:id', recruiterOnly, (req, res, next) => {
  try {
    if (!deleteSearchChat(req.session.id, Number(req.params.id))) {
      throw new HttpError(404, 'Search not found.')
    }
    res.json({ chats: listSearchChats(req.session.id) })
  } catch (error) {
    next(error)
  }
})

/**
 * Not relevant — for this search, and only for this search.
 *
 * Scoped to the chat on purpose: a candidate who is wrong for a design role is
 * not wrong for the next backend role, and a company-wide hide would shrink the
 * pool for colleagues who never made that judgement. Ownership comes from the
 * chat, which is read against the caller's own recruiter id.
 *
 * Reversible by DELETE on the same path, because a judgement can change.
 */
app.post('/api/hr/chats/:id/dismissed', recruiterOnly, (req, res, next) => {
  try {
    const chatId = Number(req.params.id)
    if (!getSearchChat(req.session.id, chatId)) throw new HttpError(404, 'Search not found.')

    const candidateId = Number(req.body?.candidateId)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    dismissCandidate(chatId, candidateId)
    res.json({ dismissed: dismissedCandidateIds(chatId) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/hr/chats/:id/dismissed/:candidateId', recruiterOnly, (req, res, next) => {
  try {
    const chatId = Number(req.params.id)
    if (!getSearchChat(req.session.id, chatId)) throw new HttpError(404, 'Search not found.')

    restoreCandidate(chatId, Number(req.params.candidateId))
    res.json({ dismissed: dismissedCandidateIds(chatId) })
  } catch (error) {
    next(error)
  }
})

// ------------------------------------------------------------- folders ---


/* ======================================================== CURSUS TRIAGE ===
 *
 * The recruiter's own applicant pile, sorted.
 *
 * Every route below is mounted under /api/hr, so it inherits the approval gate
 * above and the single-session check on recruiterOnly. Ownership is checked
 * again per route through mustOwn(), which resolves an id only within the
 * caller's own company — Section 11 requires that a guessed id reaches nothing,
 * and a gate that only knows "is a recruiter" cannot provide it.
 *
 * Note what these routes never touch: the candidates table. An applicant here
 * is a document a recruiter received, not a person who joined Cursus.
 */

/**
 * The two capacity limits for one recruiter about to launch one Triage.
 *
 * One helper rather than a check per route: the organization pool and the
 * seat's allowance are both consulted everywhere readiness is reported, and a
 * route that consulted only one would show a recruiter a green button that the
 * launch then refuses.
 */
function capacityFor(companyId, recruiterId, triage) {
  return triageCapacityCheck({
    companyId, recruiterId, cvs: chargeableCvs(triage),
  })
}

/** The organization's Triages, and what it can still start. */
app.get('/api/hr/triages', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    res.json({
      triages: listTriages(companyId),
      /* The organization's remaining CV capacity. Reported as `balance`; there
         is no such thing as a number of Triages remaining. */
      balance: triageBalance(companyId),
      used: triageCvsUsed(companyId),
      allowance: triageAllowanceRemaining(req.session.id) === Infinity
        ? null
        : triageAllowanceRemaining(req.session.id),
      maxFiles: TRIAGE.maxFiles,
      tranche: TRIAGE.tranche,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * The New Triage screen, before there is a Triage.
 *
 * Under /api/hr/triages/ rather than /api/hr/triage/new on purpose: the latter
 * would sit in front of /api/hr/triage/:id and every future route added under
 * it, and "new" would quietly become a reserved id.
 *
 * Reads nothing and writes nothing — it exists so the builder can render the
 * balance, the file cap and the launch problems for a Triage that has not been
 * created, which is what lets creation wait for the first keystroke.
 */
app.get('/api/hr/triages/new', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const triage = blankTriage()

    res.json({
      triage,
      files: [],
      failures: [],
      states: pipelineStates(null),
      balance: triageBalance(companyId),
      working: false,
      readiness: launchReadiness({
        triage, capacity: capacityFor(companyId, req.session.id, triage),
      }),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * A new draft. Free, and deliberately so.
 *
 * The addendum is explicit: opening New Triage or creating a draft must not
 * consume a credit. The commercial object begins at confirmed launch, which is
 * why this route charges nothing and the launch route is the only one that
 * touches the wallet.
 */
app.post('/api/hr/triage', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const triage = createDraft({
      companyId, recruiterId: req.session.id, title: req.body?.title ?? null,
    })

    track('triage_created', { actorType: 'recruiter', actorId: req.session.id, triageId: triage.id })
    res.status(201).json({ triage, files: [], balance: triageBalance(companyId) })
  } catch (error) {
    next(error)
  }
})

/**
 * One Triage, in whatever state it is in.
 *
 * A draft returns its upload manifest; a launched one returns its progress and
 * the files that could not be read. Both come from here rather than from two
 * routes, because the client renders one screen whose contents depend on the
 * status, and splitting it would mean the screen could show a draft's file list
 * beside a running job's progress.
 */
app.get('/api/hr/triage/:id', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    res.json({
      triage,
      files: triage.status === 'draft' ? draftFiles(triage.id) : [],
      failures: triage.status === 'draft' ? [] : failedFiles(triage.id),
      states: pipelineStates(triage.id),
      balance: triageBalance(companyId),
      working: queueDepth(triage.id) > 0,
      readiness: launchReadiness({ triage, capacity: capacityFor(companyId, req.session.id, triage) }),
    })
  } catch (error) {
    next(error)
  }
})

/** The JD and the title, while it is still a draft. */
app.patch('/api/hr/triage/:id', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    /*
     * Frozen once paid for. Editing the JD after launch would invalidate every
     * score already produced against the old one, and there is no honest way to
     * show a mixture of the two in one list — so the answer is a new Triage,
     * which is also the honest commercial answer.
     */
    if (triage.launched) {
      throw new HttpError(409, 'This Triage has already started. Create a new one to use a different job description.')
    }

    if (req.body?.jd !== undefined) {
      setJobDescription({ triageId: triage.id, jd: req.body.jd, title: req.body?.title })
    } else if (req.body?.title !== undefined) {
      setTitle({ triageId: triage.id, title: req.body.title })
    }

    const updated = getTriage({ companyId, id: triage.id })
    res.json({
      triage: updated,
      files: draftFiles(triage.id),
      readiness: launchReadiness({ triage: updated, capacity: capacityFor(companyId, req.session.id, updated) }),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * A chunk of CVs.
 *
 * Answers with a per-file verdict rather than a count, because the three
 * outcomes — stored, duplicate, rejected — need different words in front of the
 * recruiter and a total cannot carry them. Duplicates are named against the
 * file they duplicate, which is the only form of that message somebody can act
 * on: "cv (3).pdf is the same file as cv.pdf".
 */
app.post('/api/hr/triage/:id/files', recruiterOnly, triageUpload, async (req, res, next) => {
  const uploaded = Array.isArray(req.files) ? req.files : []

  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')
    if (triage.launched) throw new HttpError(409, 'This Triage has already started.')
    /* Files multer took but the content check threw out. Reported alongside
       the rest rather than lost, so "300 selected, 297 uploaded" is explainable
       rather than mysterious. */
    const preRejected = (req.rejectedUploads ?? []).map((entry) => ({
      name: entry.name, status: 'rejected', reason: entry.reason,
    }))

    if (uploaded.length === 0 && preRejected.length === 0) {
      throw new HttpError(400, 'Choose the CV files to upload.')
    }

    /*
     * Section 9 — the ceilings, checked before anything expensive happens.
     *
     * Both are enforced against the running total rather than against this
     * request, so a pile cannot be walked past the cap one chunk at a time.
     */
    const held = triage.counts.total
    const room = Math.max(0, triage.fileCap - held)
    const accepted = uploaded.slice(0, room)
    const overflow = uploaded.slice(room)

    const bytesHeld = draftBytes(triage.id)
    const results = [...preRejected]

    /*
     * Nothing is awaited until every row is written.
     *
     * This loop used to `await fs.promises.unlink(...)` on each rejected file,
     * and every one of those yields the event loop halfway through the batch.
     * A second tab launching the Triage in that window would charge for the
     * rows written so far, claim the ledger and start processing — and then
     * this handler would resume and add the remaining files to a Triage that
     * was already running. Those CVs would be processed free, and worse, the
     * parse batch had already chosen its rows, so they would sit at 'pending'
     * for ever and the workspace would never report itself complete.
     *
     * So the unlinks are collected and done afterwards. The inserts now happen
     * in one synchronous run, which nothing else can interleave with.
     */
    const discardable = []

    for (const file of accepted) {
      if (bytesHeld + (file.size ?? 0) > TRIAGE.maxTotalBytes) {
        results.push({ name: file.originalname, status: 'rejected', reason: 'This Triage has reached its total size limit.' })
        discardable.push(file.path)
        continue
      }
      if ((file.size ?? 0) === 0) {
        results.push({ name: file.originalname, status: 'rejected', reason: 'The file is empty.' })
        discardable.push(file.path)
        continue
      }

      const outcome = addFile({ triageId: triage.id, file })
      results.push(outcome.duplicate
        ? {
          name: file.originalname, status: 'duplicate',
          reason: outcome.originalName
            ? `The same file is already uploaded as ${outcome.originalName}.`
            : 'The same file is already uploaded.',
        }
        : { name: file.originalname, status: 'added', id: outcome.id })
    }

    for (const file of overflow) {
      results.push({
        name: file.originalname, status: 'rejected',
        reason: `One Triage takes up to ${triage.fileCap} CVs at a time.`,
      })
      discardable.push(file.path)
    }

    await Promise.all(discardable.map((p) => fs.promises.unlink(p).catch(() => {})))

    /* Launched while this ran? Say so, rather than reporting an upload that
       arrived after the charge as though it had counted. */
    const afterwards = getTriage({ companyId, id: triage.id })
    if (afterwards?.launched && !triage.launched) {
      throw new HttpError(409, 'This Triage started while the files were uploading. '
        + 'Create a new one for the rest.')
    }

    const updated = getTriage({ companyId, id: triage.id })
    track('triage_files_uploaded', {
      actorType: 'recruiter', actorId: req.session.id,
      triageId: triage.id, added: results.filter((r) => r.status === 'added').length,
    })

    res.status(201).json({
      triage: updated,
      results,
      files: draftFiles(triage.id),
      readiness: launchReadiness({ triage: updated, capacity: capacityFor(companyId, req.session.id, updated) }),
    })
  } catch (error) {
    // Anything still on disk from a rejected request is not ours to keep.
    for (const file of uploaded) await fs.promises.unlink(file.path).catch(() => {})
    next(error)
  }
})

/** Removes a file from a draft. Section 2.3 — before launching, not after. */
app.delete('/api/hr/triage/:id/files/:fileId', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')
    if (triage.launched) throw new HttpError(409, 'This Triage has already started.')

    removeFile({ triageId: triage.id, applicantId: Number(req.params.fileId) })

    const updated = getTriage({ companyId, id: triage.id })
    res.json({
      triage: updated,
      files: draftFiles(triage.id),
      readiness: launchReadiness({ triage: updated, capacity: capacityFor(companyId, req.session.id, updated) }),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Launch: the one moment a credit is spent.
 *
 * The order matters and is not arbitrary. The credit is taken first, because a
 * job that starts without being paid for is a job we cannot bill; and if
 * anything after that throws, the credit is handed straight back, because
 * Section 10 says a payment that succeeds while job creation fails must never
 * silently lose it.
 *
 * Idempotent all the way down: consumeTriageCredit claims the triages row, so a
 * double-click, a retry or a second tab finds the Triage already paid for and
 * charges nothing. startProcessing is idempotent for the same reason — the
 * parse batch it enqueues has a fixed key.
 */
app.post('/api/hr/triage/:id/launch', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    if (triage.launched) {
      // Already running. Answering 200 rather than an error is the point: a
      // retried request should land where the first one did.
      return res.json({
        triage, balance: triageBalance(companyId), charged: false, cvs: triage.chargedCvs,
        states: pipelineStates(triage.id),
      })
    }

    const capacity = capacityFor(companyId, req.session.id, triage)
    const readiness = launchReadiness({ triage, capacity })
    if (!readiness.ready) {
      /*
       * 402 means "pay for this"; 403 means "you are not allowed this much".
       * They are different problems with different fixes, and answering 402 to
       * a recruiter whose organization has plenty of capacity would send them
       * to a checkout that cannot help them.
       */
      const short = readiness.problems.some((p) => p.code === 'no_capacity')
      const capped = readiness.problems.some((p) => p.code === 'over_allowance')
      throw new HttpError(
        short ? 402 : capped ? 403 : 400,
        readiness.problems.map((p) => p.message).join(' '),
      )
    }

    const charge = consumeTriageCvs({
      companyId, triageId: triage.id, recruiterId: req.session.id, cvs: readiness.cvs,
    })
    if (!charge.ok) {
      /* Lost a race with a concurrent launch that spent the capacity first.
         The readiness check above passed, so this is genuinely a race and not
         a state the recruiter could have seen. */
      throw new HttpError(
        charge.reason === 'over_allowance' ? 403 : 402,
        charge.reason === 'over_allowance'
          ? 'Your Triage allowance no longer covers this. Ask your administrator to raise it.'
          : 'Your organization no longer has enough Triage capacity for this. Buy more to start it.',
      )
    }

    try {
      startProcessing(triage.id)
    } catch (startError) {
      /*
       * `totalCvs`, not `cvs`.
       *
       * refundTriageCvs takes a TARGET TOTAL — how many of the charged CVs
       * should stand refunded once it returns — which is what makes it safe to
       * call twice. It was being handed `cvs:`, a name it does not destructure,
       * so totalCvs was undefined, the guard at the top returned {refunded: 0}
       * and this whole branch was a no-op: the company stayed debited, the
       * seat's usage stayed inflated, and the Triage stayed marked as paid for
       * while nothing ran.
       */
      refundTriageCvs({
        companyId, triageId: triage.id, totalCvs: charge.cvs,
        note: 'CVs returned: the Triage could not be started',
      })

      /* And it is a draft again. `launched` is derived from ledger_id
         (triage.js), so leaving it set would show a refunded Triage as running
         with no queue behind it. */
      db.prepare(`UPDATE triages SET ledger_id = NULL WHERE id = ?`).run(triage.id)

      throw startError
    }

    db.prepare(`UPDATE triages SET launched_at = ? WHERE id = ? AND launched_at IS NULL`)
      .run(new Date().toISOString(), triage.id)

    track('triage_launched', {
      actorType: 'recruiter', actorId: req.session.id,
      triageId: triage.id, cvs: charge.cvs,
    })

    activatedOnce('recruiter_first_triage', getRecruiter(req.session.id), req.company, [
      `CVs submitted: ${charge.cvs}`,
    ])

    res.status(201).json({
      triage: getTriage({ companyId, id: triage.id }),
      balance: charge.balance,
      charged: charge.charged,
      cvs: charge.cvs,
      states: pipelineStates(triage.id),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * A page of scored applicants.
 *
 * `advance` on the query string is how the client says "I have reached the end
 * of this page". It queues the next tranche as a side effect of the read, which
 * is what makes the buffer roll without a second round trip — and it is safe to
 * repeat because requestNextTranche derives the range from the stored frontier
 * rather than from the request.
 */
app.get('/api/hr/triage/:id/results', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    const offset = Math.max(0, parseNumber(req.query.offset) ?? 0)
    const page = results({ triageId: triage.id, offset, limit: TRIAGE.pageSize })

    let queued = null
    if (req.query.advance === '1') queued = requestNextTranche(triage.id)

    res.json({
      ...page,
      triage: getTriage({ companyId, id: triage.id }),
      states: pipelineStates(triage.id),
      working: queueDepth(triage.id) > 0,
      queued,
      /* Said once, here, for the same reason Search says it: a score that moves
         when more people are analysed looks like instability unless the
         recruiter is told the scale moved rather than the candidate. */
      scoring: {
        explanation: 'Scores are relative to every applicant analysed for this role so far. '
          + 'Analysing more of the pile re-ranks the whole set, so an earlier score can move. '
          + 'Applicants not yet analysed have no score; that is not a low one.',
      },
    })
  } catch (error) {
    next(error)
  }
})

/** Explicitly asks for the next tranche, for a client that would rather not
    hide the request inside a read. Same idempotent path. */
app.post('/api/hr/triage/:id/advance', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    res.json({
      queued: requestNextTranche(triage.id),
      triage: getTriage({ companyId, id: triage.id }),
      working: queueDepth(triage.id) > 0,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * The original CV, as uploaded.
 *
 * Section 4 requires it to stay reachable from the result, and no reveal is
 * charged: the recruiter already had this document — it arrived in their inbox.
 * Served through the same hardened path as every other stored upload, so it
 * cannot execute and cannot be reached from another organization.
 */
app.get('/api/hr/triage/:id/applicants/:applicantId/file', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    const applicant = applicantFile({
      triageId: triage.id, applicantId: Number(req.params.applicantId),
    })
    if (!applicant) throw new HttpError(404, 'That CV is not part of this Triage.')

    const filePath = resolveUpload(applicant.stored_name)
    if (!filePath) throw new HttpError(404, 'That file is no longer stored.')

    markReviewed({ triageId: triage.id, applicantId: applicant.id })
    track('triage_cv_opened', {
      actorType: 'recruiter', actorId: req.session.id, triageId: triage.id,
    })

    sendUploadedFile(res, filePath, { fileName: applicant.file_name })
  } catch (error) {
    next(error)
  }
})

/** Marks an applicant read, so the list can show where the recruiter got to. */
app.post('/api/hr/triage/:id/applicants/:applicantId/reviewed', recruiterOnly, (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    markReviewed({ triageId: triage.id, applicantId: Number(req.params.applicantId) })
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

/** Deletes a Triage and the CVs in it. The ledger row stays — see deleteTriage. */
app.delete('/api/hr/triage/:id', recruiterOnly, async (req, res, next) => {
  try {
    const companyId = companyIdFor(req.session.id)
    const { triage, error } = mustOwn({ companyId, id: req.params.id })
    if (error) throw new HttpError(404, 'That Triage does not exist.')

    const files = deleteTriage({ companyId, id: triage.id })
    await Promise.all(
      (files ?? []).map((stored) => fs.promises.unlink(path.join(UPLOAD_DIR, stored)).catch(() => {})),
    )

    track('triage_deleted', { actorType: 'recruiter', actorId: req.session.id, triageId: triage.id })
    res.json({ deleted: true, triages: listTriages(companyId) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/hr/folders', recruiterOnly, (req, res) => {
  // The status vocabulary rides along with the folders rather than being
  // retyped in the client, so adding a stage is a one-file change and the
  // picker cannot offer something the server would reject.
  res.json({ folders: listFolders(req.session.id), statuses: FOLDER_STATUSES })
})

/**
 * A folder, as a spreadsheet.
 *
 * The columns are the card's, in the card's order, because the export is meant
 * to be the same information somewhere else — a recruiter who sends this to a
 * hiring manager should be sending what they were looking at.
 *
 * Masking is not reimplemented here. The rows come from listFolders, which has
 * already decided what this company may see: an unrevealed candidate arrives
 * with a first name and no contact details, and the export writes what it was
 * given. A second set of rules would be a second thing to get wrong, and the
 * one that leaks is always the copy.
 */
app.get('/api/hr/folders/:id/export', recruiterOnly, (req, res, next) => {
  try {
    const folderId = Number(req.params.id)
    const folder = getFolder(req.session.id, folderId)
    if (!folder) throw new HttpError(404, 'Folder not found.')

    const items = (listFolders(req.session.id).find((entry) => entry.id === folderId)?.items) ?? []

    const rows = [[
      'Name', 'Revealed', 'Email', 'Phone', 'Location', 'Availability', 'Capacity',
      'Open to relocation', 'Professional summary', 'Score', 'Scored against',
      'Status', 'Tags', 'Documents', 'Added',
    ]]

    for (const item of items) {
      /*
       * Contact details are fetched here rather than carried on every folder
       * payload. The rows a folder screen draws do not show an email address,
       * so putting one in that response would widen what the endpoint discloses
       * for the sake of a column — and the reveal is what pays for it. Read
       * once, for the people whose organization has already paid.
       */
      const contact = item.revealed ? getCandidate(item.candidate_id) : null

      rows.push([
        item.display_name ?? '',
        item.revealed ? 'Yes' : 'No',
        /* Said rather than left blank: an empty cell reads as "we do not have
           it", and the difference between not knowing and not having paid is
           the whole product. */
        item.revealed ? (contact?.email ?? '') : 'Hidden until revealed',
        item.revealed ? (contact?.phone ?? '') : 'Hidden until revealed',
        item.location ?? '',
        item.availability ?? '',
        item.capacity ?? '',
        item.open_to_relocation === null ? '' : (item.open_to_relocation ? 'Yes' : 'No'),
        item.summary ?? '',
        /* A number, so the column sorts as one. Blank when they were filed with
           no search behind them. */
        Number.isFinite(item.score) ? item.score : '',
        item.scoredFor ?? '',
        item.status?.label ?? '',
        (item.tags ?? []).map((tag) => tag.label ?? tag.name ?? tag).join(', '),
        (item.documents ?? []).join(', '),
        item.added_at ? new Date(item.added_at).toISOString().slice(0, 10) : '',
      ])
    }

    const file = workbook(rows, { sheetName: folder.name })

    /* Quoted, and with the non-ASCII form given separately: a folder can be
       called anything, and a bare filename with a comma or a Hebrew letter in
       it truncates or mangles in the browser that receives it. */
    const safe = String(folder.name).replace(/["\\]/g, '').slice(0, 60) || 'folder'
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safe.replace(/[^ -~]/g, '_')}.xlsx"; `
      + `filename*=UTF-8''${encodeURIComponent(safe)}.xlsx`,
    )
    res.send(file)
  } catch (error) {
    next(error)
  }
})

app.post('/api/hr/folders', recruiterOnly, (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!name) throw new HttpError(400, 'Give the folder a name.')

    const id = createFolder(req.session.id, name.slice(0, 60))
    res.status(201).json({ id, folders: listFolders(req.session.id) })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/hr/folders/:id', recruiterOnly, (req, res, next) => {
  try {
    const folderId = Number(req.params.id)
    if (!getFolder(req.session.id, folderId)) throw new HttpError(404, 'Folder not found.')

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim()
      if (!name) throw new HttpError(400, 'A folder needs a name.')
      renameFolder(req.session.id, folderId, name.slice(0, 60))
    }

    if (req.body?.beforePosition !== undefined || req.body?.afterPosition !== undefined) {
      moveFolder(req.session.id, folderId,
        positionBetween(parseNumber(req.body.beforePosition), parseNumber(req.body.afterPosition)))
    }

    res.json({ folders: listFolders(req.session.id) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/hr/folders/:id', recruiterOnly, (req, res, next) => {
  try {
    if (!deleteFolder(req.session.id, Number(req.params.id))) {
      throw new HttpError(404, 'Folder not found.')
    }
    res.json({ folders: listFolders(req.session.id) })
  } catch (error) {
    next(error)
  }
})

/** Add a candidate to a folder, or drag them from one folder to another. */
app.post('/api/hr/folders/:id/items', recruiterOnly, (req, res, next) => {
  try {
    const folderId = Number(req.params.id)
    const candidateId = Number(req.body?.candidateId)

    if (!getFolder(req.session.id, folderId)) throw new HttpError(404, 'Folder not found.')
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')
    refuseBlockedId(req, candidateId)

    const position = (req.body?.beforePosition !== undefined || req.body?.afterPosition !== undefined)
      ? positionBetween(parseNumber(req.body.beforePosition), parseNumber(req.body.afterPosition))
      : null

    placeCandidate({ recruiterId: req.session.id, folderId, candidateId, position })
    res.json({ folders: listFolders(req.session.id) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/hr/folders/items/:candidateId', recruiterOnly, (req, res) => {
  removeFromFolders(req.session.id, Number(req.params.candidateId))
  res.json({ folders: listFolders(req.session.id) })
})

/**
 * Pin where a saved candidate stands, or hand them back to the automatic
 * pipeline with an empty status.
 *
 * Keyed by candidate rather than by folder item: a candidate sits in at most
 * one of this recruiter's folders, and their standing belongs to the person,
 * not to the drawer they happen to be filed in — moving them between folders
 * should not reset it.
 */
app.patch('/api/hr/folders/items/:candidateId/status', recruiterOnly, (req, res, next) => {
  try {
    const status = req.body?.status ?? null
    if (!isFolderStatus(status)) throw new HttpError(400, 'Unknown status.')

    const changed = setFolderStatus({
      recruiterId: req.session.id,
      candidateId: Number(req.params.candidateId),
      status,
    })
    if (!changed) throw new HttpError(404, 'That candidate is not in any of your folders.')

    res.json({ folders: listFolders(req.session.id) })
  } catch (error) {
    next(error)
  }
})

// -------------------------------------------------------- recruiter chat ---

app.get('/api/hr/threads', recruiterOnly, (req, res) => {
  res.json({ threads: recruiterThreads(req.session.id) })
})

app.get('/api/hr/threads/:candidateId', recruiterOnly, refuseIfBlocked('candidateId'), (req, res) => {
  const candidateId = Number(req.params.candidateId)
  if (!getCandidate(candidateId)) return res.status(404).json({ error: 'Candidate not found.' })

  markThreadRead({ candidateId, recruiterId: req.session.id, reader: 'recruiter' })
  res.json({
    messages: listThread(candidateId, req.session.id),
    status: threadStatus(candidateId, req.session.id),
  })
})

app.post('/api/hr/threads/:candidateId', recruiterOnly, refuseIfBlocked('candidateId'), (req, res, next) => {
  try {
    const candidateId = Number(req.params.candidateId)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    /*
     * Messaging is on the far side of the reveal.
     *
     * A conversation carries the recruiter's name and company to the candidate
     * and puts a reply address in front of them, which is the same access a
     * reveal grants in the other direction. Allowing it while the profile is
     * still masked would make the message box a way around paying — and would
     * open a channel to somebody the recruiter cannot even see the name of.
     */
    // Resolved here rather than read off req: req.recruiter is set by
    // orgAdminOnly, which does not run on this route, and a null company id
    // would silently match nothing and refuse everybody.
    const sender = getRecruiter(req.session.id)
    if (!hasRevealed(sender?.company_id ?? null, candidateId)) {
      throw new HttpError(
        402,
        'Reveal this candidate before writing to them. Messaging shares your name and company '
        + 'with them, so it is on the same side of the reveal as their contact details.',
      )
    }

    // A closed conversation is closed for both sides — the recruiter reopens it
    // deliberately rather than by writing into it.
    if (threadStatus(candidateId, req.session.id) === 'closed') {
      throw new HttpError(409, 'This conversation is closed. Reopen it to send a message.')
    }

    const body = String(req.body?.body ?? '').trim()
    if (!body) throw new HttpError(400, 'Write a message first.')

    sendMessage({ candidateId, recruiterId: req.session.id, sender: 'recruiter', body })

    // Told after the message is safely stored, and not awaited: a mail provider
    // being slow or down must not cost the recruiter their message.
    const candidate = getCandidate(candidateId)
    const recruiter = getRecruiter(req.session.id)
    if (candidate?.email) {
      void sendMessageEmail({
        to: candidate.email,
        candidateName: candidate.first_name ?? candidate.name,
        recruiterName: recruiter?.first_name,
        companyName: recruiter?.company_name,
        recruiterId: req.session.id,
      }).catch((error) => {
        console.warn(`  message email failed for candidate ${candidateId}: ${error.message}`)
      })
    }

    res.status(201).json({
      messages: listThread(candidateId, req.session.id),
      status: threadStatus(candidateId, req.session.id),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Spec §9 — only the recruiter can close, and closing is what stops the
 * candidate replying. Nothing is deleted: the history stays readable to both.
 */
app.post('/api/hr/threads/:candidateId/close', recruiterOnly, refuseIfBlocked('candidateId'), (req, res, next) => {
  try {
    const candidateId = Number(req.params.candidateId)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    if (listThread(candidateId, req.session.id).length === 0) {
      throw new HttpError(404, 'There is no conversation to close.')
    }

    closeThread({ candidateId, recruiterId: req.session.id })
    res.json({ status: threadStatus(candidateId, req.session.id) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/hr/threads/:candidateId/reopen', recruiterOnly, refuseIfBlocked('candidateId'), (req, res, next) => {
  try {
    const candidateId = Number(req.params.candidateId)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    reopenThread({ candidateId, recruiterId: req.session.id })
    res.json({ status: threadStatus(candidateId, req.session.id) })
  } catch (error) {
    next(error)
  }
})

/**
 * Mark a conversation unread again, or clear it from this recruiter's inbox.
 *
 * The mirror of the candidate's pair. Clearing hides it for whoever asked and
 * nobody else — the candidate keeps their copy, and anything sent afterwards
 * brings it back. Closing a conversation is the separate, mutual act: that one
 * stops the candidate replying and is deliberately not what this does.
 */
app.post('/api/hr/threads/:candidateId/unread', recruiterOnly, refuseIfBlocked('candidateId'), (req, res, next) => {
  try {
    const candidateId = Number(req.params.candidateId)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    if (!markThreadUnread({ candidateId, recruiterId: req.session.id, reader: 'recruiter' })) {
      throw new HttpError(404, 'No conversation to mark unread.')
    }

    res.json({ threads: recruiterThreads(req.session.id) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/hr/threads/:candidateId', recruiterOnly, (req, res, next) => {
  try {
    const candidateId = Number(req.params.candidateId)
    if (!getCandidate(candidateId)) throw new HttpError(404, 'Candidate not found.')

    hideConversation({ candidateId, recruiterId: req.session.id, party: 'recruiter' })
    res.json({ threads: recruiterThreads(req.session.id) })
  } catch (error) {
    next(error)
  }
})

// -------------------------------------------------------- static + errors ---

const clientDist = path.join(here, '..', '..', 'client', 'dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
}

app.use((error, req, res, _next) => {
  // Multer writes files to disk as it parses, so a rejection partway through a
  // multi-file upload can leave the earlier ones orphaned. Clear them out.
  for (const file of Object.values(req.files ?? {}).flat()) {
    fs.promises.unlink(file.path).catch(() => {})
  }

  /*
   * Too many files, said as a rule rather than as a parser complaint.
   *
   * multer answers LIMIT_UNEXPECTED_FILE for a part beyond its count limit —
   * literally "Unexpected field", which tells somebody who attached thirty CVs
   * nothing about the twenty-five they were allowed. The demo is the route this
   * happens on, so its ceiling is the one named.
   */
  if (error instanceof multer.MulterError
      && (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT')
      && error.field === 'cvs') {
    /*
     * Two routes take a field called 'cvs' — the demo, capped at
     * PUBLIC_DEMO.triageMaxFiles, and the authenticated Triage uploader, capped
     * far higher at TRIAGE_UPLOAD_CHUNK. Matching on the field name alone told
     * a paying recruiter who dropped in a big folder that they may attach 25
     * and should "create an account", which they have.
     */
    const isDemo = req.path.startsWith('/api/public/demo/')
    const ceiling = isDemo ? PUBLIC_DEMO.triageMaxFiles : TRIAGE_UPLOAD_CHUNK
    return res.status(400).json({
      error: `That is more CVs than this accepts at once. Attach up to ${ceiling}`
        + (isDemo ? ' and create an account to sort a bigger pile.' : ' at a time.'),
    })
  }

  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    /* Read from the constant multer is configured with, so the sentence and
       the rule can never drift apart again — this said 10 MB while the limit
       was 5, which turns a clear refusal into an apparent bug. */
    return res.status(413).json({
      error: `That file is larger than the ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB limit.`,
    })
  }

  const status = error.status ?? 400
  if (status >= 500) console.error(error)

  res.status(status).json({ error: error.message || 'Something went wrong.' })
})

/**
 * Every file in the uploads directory is server-generated and recorded against
 * a row somewhere, so anything unreferenced is garbage — left behind by a
 * request that was aborted mid-upload, or by a crash between writing the file
 * and committing the row. Neither path can be caught by a request handler, so
 * they are swept at startup instead.
 *
 * Both owners have to be asked. Triage CVs live in the same directory but in a
 * different table, and a sweep that only knew about candidates would delete
 * every applicant CV in the product on the next restart — silently, and with no
 * way back. Any new table that stores an upload belongs in this union.
 */
function sweepOrphanUploads() {
  const referenced = referencedUploadNames()
  for (const name of triageUploadNames()) referenced.add(name)
  let removed = 0

  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (referenced.has(name)) continue
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, name))
      removed += 1
    } catch {
      // A file we cannot delete is not worth failing startup over.
    }
  }

  return removed
}

/**
 * No cron here on purpose — one long-lived process with a daily timer is the
 * smallest thing that works, and the sweep is idempotent, so a restart
 * mid-cycle repeats work rather than skipping it.
 */
const CHECKIN_SWEEP_MS = 24 * 60 * 60 * 1000

app.listen(PORT, async () => {
  const swept = sweepOrphanUploads()

  console.log(`  Cursus API listening on http://localhost:${PORT}`)
  console.log(`  ${countCandidates()} candidate(s), ${countCompanies()} company account(s)`)
  if (swept > 0) console.log(`  swept ${swept} orphaned upload(s)`)

  /*
   * §3.2 — candidates who predate the matching architecture have no
   * intelligence rows, which would make them invisible to taxonomy retrieval
   * while still appearing in the old search. Built from facts already on disk,
   * so this costs no model calls; only candidates actually missing a row are
   * touched, making a restart idempotent.
   */
  const backfilled = backfillIntelligence()
  if (backfilled > 0) console.log(`  built profile intelligence for ${backfilled} candidate(s)`)

  /*
   * Triage work outlives the process that started it.
   *
   * A batch left 'running' when the server stopped has no worker behind it, so
   * it is reclaimed and re-queued here. Without this a Triage interrupted by a
   * deploy would sit at "processing" forever with nothing driving it, which is
   * the failure mode a database-backed queue exists to prevent.
   */
  const resumed = resumeQueue()
  if (resumed.waiting > 0) {
    console.log(`  triage: ${resumed.waiting} batch(es) waiting${resumed.reclaimed ? `, ${resumed.reclaimed} reclaimed` : ''}`)
  }

  // Pricing §18.6 — organizations that predate the wallet. Idempotent, so it
  // runs on every boot and does nothing at all once it has caught up.
  const migrated = migrateExistingOrganizations()
  if (migrated.granted > 0) {
    console.log(`  granted complimentary reveals to ${migrated.granted} organization(s)`)
  }
  if (migrated.triaged > 0) {
    console.log(`  granted complimentary Triage capacity to ${migrated.triaged} organization(s)`)
  }

  await runCheckinSweep().catch((error) => {
    console.warn(`  check-in sweep failed: ${error.message}`)
  })

  /*
   * The demonstration's leftovers ride the same daily timer.
   *
   * Unlike the login codes and contact enquiries, there is no request path this
   * could hang off: the demo routes are the ones creating these rows, and
   * sweeping on them would mean a visitor's own request paying to clear up
   * after visitors before them. The daily pass is where work with no natural
   * request belongs, and it is already here.
   */
  /*
   * §21 — summaries written before anything screened them for employer names.
   *
   * At boot rather than on a timer: it is a one-off repair of rows that predate
   * the rule, it is idempotent, and every write path keeps new rows clean by
   * itself. Reported when it does something, silent when it does not.
   */
  /*
   * Two accounts on one identity, if any exist.
   *
   * Named rather than merged: the routes stop new ones forming, and an existing
   * pair is a decision about whose CV and whose paid-for reveals survive. Said
   * loudly, because the way this failure presents to the person affected is
   * "my profile is gone".
   */
  const clashes = duplicateIdentities()
  for (const [what, found] of [['email address', clashes.byEmail], ['phone number', clashes.byPhone]]) {
    for (const { value, ids } of found) {
      console.warn(`  WARNING: ${ids.length} candidate accounts share the ${what} ${value} `
        + `(ids ${ids.join(', ')}) — signing in reaches only the newest`)
    }
  }

  const repaired = repairSummaries()
  if (repaired.cleaned > 0) {
    console.log(`  took employer names out of ${repaired.cleaned} professional summary(ies)`)
  }
  if (repaired.missing > 0) {
    console.log(`  ${repaired.missing} candidate(s) have a CV and no summary; `
      + 'each is drafted the next time their profile is saved')
  }

  const demoSwept = sweepAnonymousDemoArtefacts()
  const demoTotal = Object.values(demoSwept).reduce((sum, n) => sum + n, 0)
  if (demoTotal > 0) console.log(`  swept ${demoTotal} anonymous demonstration row(s)`)

  // unref so the timer never holds the process open on its own.
  setInterval(() => {
    runCheckinSweep().catch((error) => {
      console.warn(`  check-in sweep failed: ${error.message}`)
    })
    /* On the same timer, because it is the same kind of job: something that
       has to be looked at daily and sends at most one message when it is. */
    runSeatExpirySweep().catch((error) => {
      console.warn(`  seat expiry sweep failed: ${error.message}`)
    })
    sweepAnonymousDemoArtefacts()
  }, CHECKIN_SWEEP_MS).unref()
})

// ----------------------------------------------------------------- helpers ---

function trimOrNull(value) {
  const trimmed = String(value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Upper-cases the first letter only. Deliberately leaves the rest alone so
 * "McDonald", "van der Berg" and "O'Brien" survive intact — title-casing the
 * whole string would mangle more names than it fixes.
 */
function capitalizeName(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/** Accepts the several shapes a checkbox or radio can arrive in. */
function parseBoolean(value) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim().toLowerCase()
  if (['true', 'yes', '1', 'on'].includes(text)) return true
  if (['false', 'no', '0', 'off'].includes(text)) return false
  return null
}

/** Newline- or comma-separated free text into a trimmed list. */
function splitList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function toSkillList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)

  const seen = new Set()
  for (const item of raw) {
    const skill = canonicalize(item)
    if (skill) seen.add(skill)
  }
  return [...seen]
}
