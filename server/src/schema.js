/**
 * Data model, per Product Spec v2 §4 ("lock before writing code").
 *
 * Where v2 and the v7 brief differ, v2 wins. The four deltas that shape this
 * file: company-key auth (§3.2), download-as-sole-reveal (§7), pre-download
 * pseudonymity and masking (§6.4/§6.5), and internal messaging (§9).
 *
 * Three of these tables cannot be reconstructed after the fact — the view log,
 * the reveal log, and the scoring audit log. They are written from the moment
 * the feature ships or the history is gone permanently.
 */
export const SCHEMA = `
  /* ---------------------------------------------------------- documents ---
     A row per slot rather than a column set per slot, so a re-upload is an
     upsert and the CV's plaintext has an obvious home.
     These files are the product's paid asset — never served without a reveal.

     §7 renamed the slots: the three anonymous "additional" rows became named
     types with their own ceilings. additional_2 and additional_3 stay in the
     CHECK because rows uploaded under the old form still exist — they can be
     read and removed, they are simply never offered again. */
  CREATE TABLE IF NOT EXISTS documents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id   INTEGER NOT NULL,
    slot           TEXT NOT NULL CHECK (slot IN
                     ('cv', 'cover_letter',
                      'certification_1', 'certification_2',
                      'recommendation_1', 'recommendation_2', 'recommendation_3',
                      'additional', 'additional_2', 'additional_3')),
    file_name      TEXT NOT NULL,
    stored_name    TEXT NOT NULL,
    file_size      INTEGER,
    mime_type      TEXT,
    extracted_text TEXT,
    uploaded_at    TEXT NOT NULL,
    UNIQUE (candidate_id, slot)
  );

  /* ---------------------------------------------------- extracted fields ---
     AI output kept apart from candidate edits so the system always knows which
     is which, and so the correction rate is measurable (§5.3, §18).

     There was a mask_confidence TEXT column here, for a §6.5 design in which
     the extractor produced masked derivatives of the summary, title and
     employment history and rated its own confidence in each. Nothing ever wrote
     it and nothing ever read it — and because this table predates the column
     being added to this string, CREATE TABLE IF NOT EXISTS meant it was never
     created in any database either. Removing it changes nothing at runtime and
     stops the schema describing a feature that does not exist.

     The design it belonged to was superseded rather than abandoned: recruiters
     no longer see a masked rendering of these fields, they do not see the
     fields at all until a Reveal. Withholding replaced masking, and there is
     nothing left to rate the confidence of. */
  CREATE TABLE IF NOT EXISTS extracted_profiles (
    candidate_id  INTEGER PRIMARY KEY,
    fields        TEXT NOT NULL,
    source        TEXT NOT NULL,
    model_version TEXT,
    extracted_at  TEXT NOT NULL
  );

  /* One row per field the candidate corrected. The diff against
     extracted_profiles is the extraction-quality signal (§18). */
  CREATE TABLE IF NOT EXISTS profile_overrides (
    candidate_id INTEGER NOT NULL,
    field        TEXT NOT NULL,
    value        TEXT,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (candidate_id, field)
  );

  /* ------------------------------------------------- employer blocking ---
     Normalised at write time so the query-time match against a recruiter's org
     name is a plain equality test. Enforced on every search path (§11.6). */
  CREATE TABLE IF NOT EXISTS blocked_companies (
    candidate_id INTEGER NOT NULL,
    raw_name     TEXT NOT NULL,
    normalized   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (candidate_id, normalized)
  );

  CREATE INDEX IF NOT EXISTS idx_blocked_normalized ON blocked_companies(normalized);

  /* ------------------------------------------------------- view log ---
     §4.6. Many rows per (recruiter, candidate) are expected. card_expand is
     FREE; document_download is the billable one. Keeping both in one log is
     what makes the expand -> download funnel measurable (§18).
     org_name and recruiter_name are denormalised so the history survives the
     recruiter or company being deleted. */
  CREATE TABLE IF NOT EXISTS view_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id   INTEGER NOT NULL,
    recruiter_id   INTEGER,
    company_id     INTEGER,
    org_name       TEXT NOT NULL,
    recruiter_name TEXT,
    event_type     TEXT NOT NULL CHECK (event_type IN ('card_expand', 'document_download')),
    created_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_view_events_candidate ON view_events(candidate_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_view_events_recruiter ON view_events(recruiter_id, created_at DESC);

  /* --------------------------------------------------------- reveals ---
     §4.5 / §7. THE billing meter. Exactly one row per (recruiter, candidate),
     ever — the first download creates it and unlocks that candidate for that
     recruiter permanently. Re-downloads never create a second row.
     Reveals are per-recruiter, not per-org (§7 rule 2), deliberately.
     reveal_trigger exists for forward compatibility; v1 has one value. */
  CREATE TABLE IF NOT EXISTS reveals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Nullable: the reveal belongs to the company, which paid for it, and has
    -- to outlive the individual who spent it. See the rebuild in db.js.
    recruiter_id   INTEGER,
    company_id     INTEGER NOT NULL,
    candidate_id   INTEGER NOT NULL,
    reveal_trigger TEXT NOT NULL DEFAULT 'document_download'
                     CHECK (reveal_trigger IN ('document_download')),
    created_at     TEXT NOT NULL,
    UNIQUE (recruiter_id, candidate_id)
  );

  CREATE INDEX IF NOT EXISTS idx_reveals_company ON reveals(company_id, created_at);

  /* ---------------------------------------------------- seat purchases ---
     Append-only ledger of recruiter seats bought by an org. One row per
     purchase of a single seat, so seat_limit is always reconstructable as
     1 + COUNT(paid rows). The price is stored in minor units (agorot) as an
     INTEGER: money in a REAL column silently loses precision.
     provider/provider_ref exist so a Stripe charge id can be recorded without
     a migration once real payments are wired. */
  CREATE TABLE IF NOT EXISTS seat_purchases (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id     INTEGER NOT NULL,
    purchased_by   INTEGER,
    seat_number    INTEGER NOT NULL,
    unit_amount    INTEGER NOT NULL,
    currency       TEXT NOT NULL,
    interval       TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('paid', 'refunded', 'failed')),
    provider       TEXT NOT NULL,
    provider_ref   TEXT,
    created_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_seat_purchases_company
    ON seat_purchases(company_id, created_at DESC);

  /* ------------------------------------------------- message threads ---
     §4.8 / §9. Recruiter-initiated only, recruiter-closed only, reveal-gated.
     At most one OPEN thread per (recruiter, candidate) — enforced in code
     rather than by a unique index, because a closed thread may coexist with a
     later reopened one over the pair's lifetime. */
  CREATE TABLE IF NOT EXISTS message_threads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id    INTEGER NOT NULL,
    company_id      INTEGER NOT NULL,
    candidate_id    INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at      TEXT NOT NULL,
    closed_at       TEXT,
    last_message_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_threads_recruiter ON message_threads(recruiter_id, last_message_at DESC);
  CREATE INDEX IF NOT EXISTS idx_threads_candidate ON message_threads(candidate_id, last_message_at DESC);

  /*
   * A conversation one side has cleared from their own inbox.
   *
   * "Delete conversation" hides it rather than destroying the messages, and it
   * hides it for the party who asked and nobody else. Two reasons. A recruiter
   * paid to reach this candidate and the exchange is their record of what was
   * said; letting either side delete the other's copy would make the whole
   * thread deniable. And the messages are evidence for a dispute about conduct,
   * which is precisely when one party most wants them gone.
   *
   * A timestamp rather than a flag, so a later message brings the conversation
   * back — the same behaviour every mail client has: clearing a thread is about
   * the thread as it stands, not a standing instruction to ignore that person.
   */
  CREATE TABLE IF NOT EXISTS conversation_hidden (
    candidate_id INTEGER NOT NULL,
    recruiter_id INTEGER NOT NULL,
    party        TEXT NOT NULL CHECK (party IN ('candidate', 'recruiter')),
    hidden_at    TEXT NOT NULL,
    PRIMARY KEY (candidate_id, recruiter_id, party)
  );

  /* "Mark as unread", for the party who asked.

     Unread was derived from the other side's messages alone: the mark was
     stored by clearing read_at on their newest one. That works whenever they
     have written, and does nothing at all when they have not — so a recruiter
     who had messaged someone and was waiting for a reply, which is the most
     ordinary state a recruiter thread can be in, could not flag it. The
     endpoint answered 404 and the row stayed as it was.

     A row here is a standing mark, independent of who has written. Reading the
     thread removes it, the same event that clears read_at, so the two cannot
     disagree about whether a conversation has been seen. */
  CREATE TABLE IF NOT EXISTS conversation_unread (
    candidate_id INTEGER NOT NULL,
    recruiter_id INTEGER NOT NULL,
    party        TEXT NOT NULL CHECK (party IN ('candidate', 'recruiter')),
    marked_at    TEXT NOT NULL,
    PRIMARY KEY (candidate_id, recruiter_id, party)
  );

  /* ------------------------------------------- candidate label edits ---
     What the candidate changed about how they are categorised.

     The labels themselves live in candidate_taxonomy_labels and are rewritten
     under a new profile_version every time the CV is re-read — so an edit
     recorded only there would be silently undone by the next analysis. This
     table is the candidate's standing intent, replayed onto each new version.

     Recorded by concept id, not by the words on screen: a label has to be in
     the fixed vocabulary to affect retrieval at all, so an addition that does
     not resolve to a concept is refused rather than stored as a tag that looks
     like it does something. */
  CREATE TABLE IF NOT EXISTS candidate_label_overrides (
    candidate_id INTEGER NOT NULL,
    dimension    TEXT NOT NULL,
    concept_id   TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('add', 'remove')),
    created_at   TEXT NOT NULL,
    PRIMARY KEY (candidate_id, dimension, concept_id)
  );

  /* --------------------------------------------- password resets ---
     A recruiter who has forgotten their password.

     Only an organization administrator can hold one of these. Every other
     recruiter account was created by an administrator, who set the password
     and is the person accountable for the account — so for them the answer is
     to ask that administrator, not to have the product mail a reset to an
     address the administrator chose on their behalf.

     The token is stored hashed, exactly as sign-in codes are: the row is a
     credential, and a database read should not hand somebody a working reset
     link for every administrator on the system. Single use, and short-lived. */
  CREATE TABLE IF NOT EXISTS recruiter_password_resets (
    token_hash   TEXT PRIMARY KEY,
    recruiter_id INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    used_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_password_resets_recruiter
    ON recruiter_password_resets(recruiter_id, created_at DESC);

  /* ------------------------------------------------ public JD demo ---
     A search run by somebody with no account, from the recruiter landing
     page.

     The job and the retrieval session are the ordinary ones — the demo runs
     the real pipeline, not a parallel one, so what a stranger is shown is
     what the product would actually return. Both of those tables require a
     recruiter, so an anonymous search is written against the reserved id 0,
     which belongs to nobody: recruiter ids are AUTOINCREMENT and start at 1,
     so no real account can ever read one of these through the authenticated
     routes.

     The token is the only handle the browser gets. It is opaque and random
     rather than the job id, because a sequential id in a public response is
     an invitation to walk the range and read other people's searches.

     claimed_company_id is how the search crosses the sign-up boundary: when
     the recruiter who ran it registers, the job and session are re-pointed at
     their account and this records which company took it, so the same search
     cannot be claimed twice. */
  /*
   * Every anonymous demo run, for the durable half of the rate limit.
   *
   * public_searches below cannot serve this on its own: it has NOT NULL job_id
   * and session_id because a search really does create both, and a Triage run
   * creates neither — it persists nothing at all, which is the point of it. So
   * the throttle needs somewhere to count runs that leave no other trace, and
   * this is the smallest thing that can: a kind, a client handle and a time.
   *
   * The client handle is the same non-reversible fingerprint public_searches
   * stores, never an address.
   */
  CREATE TABLE IF NOT EXISTS public_demo_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    client_hash TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_public_demo_runs
    ON public_demo_runs(client_hash, created_at);

  CREATE TABLE IF NOT EXISTS public_searches (
    token              TEXT PRIMARY KEY,
    job_id             INTEGER NOT NULL,
    session_id         INTEGER NOT NULL,
    result_count       INTEGER NOT NULL DEFAULT 0,
    client_hash        TEXT,
    created_at         TEXT NOT NULL,
    /* Who they were trying to reveal when the sign-up gate appeared. Kept so
       the workspace can offer that candidate again rather than dropping them
       back into an undifferentiated list. */
    intent_candidate_id INTEGER,
    claimed_company_id INTEGER,
    claimed_at         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_public_searches_created
    ON public_searches(created_at DESC);

  /* --------------------------------------------------- scoring audit ---
     §4.7. Immutable. Required by every AEDT regime the spec lists and
     impossible to reconstruct later, so it is written from Phase 3 onward
     even though international expansion is deferred. */
  CREATE TABLE IF NOT EXISTS scoring_audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id  INTEGER NOT NULL,
    recruiter_id  INTEGER,
    criteria      TEXT NOT NULL,
    score         REAL NOT NULL,
    breakdown     TEXT,
    scorer        TEXT NOT NULL,
    model_version TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scoring_audit_candidate ON scoring_audit(candidate_id, created_at DESC);

  /* ------------------------------------------------ freshness check-in ---
     §5.5. One-click yes/no with no login, so the token IS the credential:
     single use, hashed at rest, and expiring. */
  CREATE TABLE IF NOT EXISTS freshness_checkins (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    sent_at      TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    answered_at  TEXT,
    answer       TEXT CHECK (answer IN ('yes', 'no'))
  );

  CREATE INDEX IF NOT EXISTS idx_checkins_candidate ON freshness_checkins(candidate_id, sent_at DESC);

  /* ----------------------------------------------- availability checks ---
     A recruiter asking Cursus to reconfirm an Orange candidate before
     spending a Reveal. Free, and it exposes nothing about the candidate: the
     row records who asked, not what they were told.

     Recruiter-specific by design, because the answer is delivered to a
     particular recruiter and lands in their own folder — but the QUESTION put
     to the candidate is global. Several recruiters asking in the same week
     produce several rows here and one email, and a single answer resolves all
     of them. See runAvailabilitySweep and resolveAvailabilityChecks.

     company_id is carried so a check outlives the recruiter who made it in the
     same way a Reveal does, and so the sweep can name the company in the email
     without joining back through a recruiter row that may since have gone. */
  CREATE TABLE IF NOT EXISTS availability_checks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    recruiter_id INTEGER NOT NULL,
    company_id   INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    /* 14 days from creation. Reached only by the sweep, which marks the row
       'expired' rather than deleting it, so the recruiter's own history of
       having asked survives the question going unanswered. */
    expires_at   TEXT NOT NULL,
    resolved_at  TEXT,
    outcome      TEXT CHECK (outcome IN ('yes', 'no', 'expired'))
  );

  CREATE INDEX IF NOT EXISTS idx_availability_recruiter
    ON availability_checks(recruiter_id, resolved_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_availability_candidate
    ON availability_checks(candidate_id, resolved_at);

  /* One outstanding check per recruiter per candidate, enforced here rather
     than by a read-then-write that two clicks can race through. Partial, so a
     resolved check never blocks asking again later. */
  CREATE UNIQUE INDEX IF NOT EXISTS idx_availability_one_pending
    ON availability_checks(recruiter_id, candidate_id) WHERE resolved_at IS NULL;

  /* ------------------------------------------------------- embeddings ---
     §11.2. Phase 3. Embedded from cv_plaintext + professional_summary
     (UNMASKED — embeddings are server-side and never returned to a recruiter).
     SQLite has no pgvector, so the vector is a Float32 blob and cosine
     similarity runs in process. */
  CREATE TABLE IF NOT EXISTS embeddings (
    candidate_id INTEGER PRIMARY KEY,
    vector       BLOB NOT NULL,
    dimensions   INTEGER NOT NULL,
    model        TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  /* ------------------------------------------------- recruiter search ---
     §6.3. The AI search conversation. Distinct from recruiter<->candidate
     messaging (§9) — different feature, different table. */
  CREATE TABLE IF NOT EXISTS search_chats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id INTEGER NOT NULL,
    title        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS search_chat_turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    results    TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chat_turns ON search_chat_turns(chat_id, created_at);

  /* ------------------------------------------------ not relevant, here ---
     Somebody a recruiter has looked at and ruled out FOR THIS SEARCH.

     Against the chat rather than the recruiter or the company: a backend
     engineer who is wrong for a design role is not wrong for the next backend
     role, and hiding them everywhere would quietly shrink the pool for
     colleagues who never made that judgement. Reopening the same saved search
     re-runs it, so this is what keeps the ones already dismissed from coming
     back each time.

     UNIQUE, so pressing it twice is the same as pressing it once — the button
     is on a list that re-renders under the pointer. */
  CREATE TABLE IF NOT EXISTS search_dismissals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      INTEGER NOT NULL,
    candidate_id INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (chat_id, candidate_id)
  );

  CREATE INDEX IF NOT EXISTS idx_dismissals_chat ON search_dismissals(chat_id);

  /* ------------------------------------------ what your team said about them ---
     A note against a candidate, written by a recruiter and read by their
     colleagues.

     By company, not by recruiter: the point of it is that the next person to
     open this profile knows somebody has already spoken to them. Deliberately
     NOT part of the candidate's record — they never see it, it is not on their
     profile, and it does not travel to another company. It is one team's
     working note about a conversation they are having.

     Kept even when a folder is emptied or a search is deleted: the note is
     about the person, not about where they were filed. */
  CREATE TABLE IF NOT EXISTS candidate_comments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   INTEGER NOT NULL,
    candidate_id INTEGER NOT NULL,
    recruiter_id INTEGER NOT NULL,
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_candidate
    ON candidate_comments(company_id, candidate_id, created_at);

  /* ------------------------------------------- what your team calls them ---
     A recruiter's own words on a candidate: "phone screened", "wants remote",
     "hold for Q4".

     Free text on purpose. The taxonomy labels on the candidate's own profile
     are a fixed vocabulary because they are matched against; these are not
     matched against anything — they are a note in the margin, and a margin with
     a dropdown is not a margin.

     By company, like the comments beside them, and never shown to the
     candidate. The position column keeps the order the recruiter put them in
     rather than the order they happen to sort in. */
  CREATE TABLE IF NOT EXISTS candidate_tags (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   INTEGER NOT NULL,
    candidate_id INTEGER NOT NULL,
    label        TEXT NOT NULL,
    colour       TEXT NOT NULL DEFAULT 'grey',
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_unique
    ON candidate_tags(company_id, candidate_id, label);

  /* --------------------------------------------------- outreach drafts ---
     §6.8. Phase 4. Reveal-gated: drafting for an unrevealed candidate would
     leak masked details. */
  CREATE TABLE IF NOT EXISTS outreach_drafts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id INTEGER NOT NULL,
    candidate_id INTEGER NOT NULL,
    subject      TEXT,
    body         TEXT NOT NULL,
    prompt       TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_drafts_candidate ON outreach_drafts(recruiter_id, candidate_id, created_at DESC);

  /* ------------------------------------------------------- analytics ---
     §18. PostHog is not wired up; these are the same events recorded locally
     so the funnel metrics exist from day one. */
  CREATE TABLE IF NOT EXISTS analytics_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    actor_type TEXT,
    actor_id   INTEGER,
    props      TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_name ON analytics_events(name, created_at DESC);

  /* ---------------------------------------------------------- contact ---
     Enquiries from the public contact page. Stored rather than only emailed
     so a message is never lost to a mail provider that is not wired up yet. */
  CREATE TABLE IF NOT EXISTS contact_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    /* §12 — what the enquiry is about, from the new dropdown. Nullable, so
       messages sent before the field existed stay valid rows. */
    reason     TEXT,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_contact_created ON contact_messages(created_at DESC);

  /* ------------------------------------------------ sign-up verification ---
     Both the email address and the phone number are proved at account creation,
     for candidates and for company administrators alike.

     Keyed by destination rather than by account, because at sign-up there is no
     account yet — which is exactly why login_codes cannot be reused here. The
     code is stored hashed, like every other credential in this database, and
     attempts are counted so six digits cannot be walked through. */
  CREATE TABLE IF NOT EXISTS signup_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel     TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
    /* Normalised: lowercased email, or the last nine digits of a phone. */
    destination TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT NOT NULL,
    consumed_at TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_signup_codes_lookup
    ON signup_codes(channel, destination, created_at DESC);

  /* ------------------------------------------------------ billing ledger ---
     Pricing §13 and §15. One append-only ledger for both products rather than
     two parallel systems: reveals and seats are told apart by the product
     column, and a purchase of either reconciles against one payment reference.

     The integer balance on companies is a cache of this table, not the record.
     Every change to a balance or an entitlement writes a row here, so support
     can explain any number and both can be rebuilt from scratch. */
  CREATE TABLE IF NOT EXISTS billing_ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   INTEGER NOT NULL,
    product      TEXT NOT NULL CHECK (product IN ('reveal', 'seat', 'triage')),
    /* What happened. 'grant' is the complimentary onboarding credit, 'consume'
       a candidate reveal, 'adjustment' a support correction. */
    event        TEXT NOT NULL CHECK (event IN
                   ('grant', 'purchase', 'auto_purchase', 'consume',
                    'refund', 'adjustment', 'promotion')),
    /* Signed change to the balance or entitlement: +50 reveals, −1 for a
       reveal, +2 seat entitlements. Zero for occupancy-only events. */
    delta        INTEGER NOT NULL,
    /* Money actually moved, in minor units. Null for grants and adjustments. */
    amount       INTEGER,
    currency     TEXT,
    provider     TEXT,
    provider_ref TEXT,
    /* Who acted, and what it was about — the candidate for a reveal, the pack
       key for a purchase. Both nullable; a grant has neither. */
    actor_id     INTEGER,
    candidate_id INTEGER,
    pack_key     TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_company
    ON billing_ledger(company_id, product, created_at DESC);

  /* §9 — the record that makes a reveal idempotent at organization level.
     The reveals table already stores one row per recruiter and candidate; this
     is the org-level fact that decides whether a reveal costs anything, and the
     UNIQUE constraint is what makes two concurrent attempts cost exactly one. */
  CREATE TABLE IF NOT EXISTS organization_reveals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   INTEGER NOT NULL,
    candidate_id INTEGER NOT NULL,
    revealed_by  INTEGER,
    created_at   TEXT NOT NULL,
    UNIQUE (company_id, candidate_id)
  );

  /* §7.2 — optional per-seat consumption caps, counted per control period.
     A cap is not a sub-wallet: the organization still owns the whole balance,
     and this only records how much one seat has drawn in the current period. */
  CREATE TABLE IF NOT EXISTS seat_usage_periods (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id INTEGER NOT NULL,
    period       TEXT NOT NULL,
    used         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (recruiter_id, period)
  );

  /* ================================================================ =====
     MATCHING ARCHITECTURE (Recruiter Matching & Filtering, v1.0)
     Entities follow §15. Names are ours; the shape is the spec's.
     ==================================================================== */

  /* §2, §5 — candidate intent. Stored apart from anything inferred about
     them, because a preference is a decision and an inference is a guess. */
  CREATE TABLE IF NOT EXISTS candidate_preference_tags (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    raw_tag      TEXT NOT NULL,
    concept_id   TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_pref_tag_unique
    ON candidate_preference_tags(candidate_id, raw_tag);

  /* §3.1 — facts with provenance. The evidence behind a claim, kept so a
     later conclusion can say why it believes what it believes (§13). */
  CREATE TABLE IF NOT EXISTS extracted_facts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id  INTEGER NOT NULL,
    profile_version INTEGER NOT NULL,
    fact_type     TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    raw_value     TEXT,
    source_slot   TEXT,
    evidence      TEXT,
    confidence    REAL,
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_facts_candidate
    ON extracted_facts(candidate_id, profile_version);

  /* §3.2 — one row per candidate per version: the reusable interpretation. */
  CREATE TABLE IF NOT EXISTS candidate_profile_intelligence (
    candidate_id       INTEGER NOT NULL,
    profile_version    INTEGER NOT NULL,
    taxonomy_version   TEXT NOT NULL,
    intelligence_version TEXT NOT NULL,
    extraction_version TEXT NOT NULL,
    summary            TEXT,
    seniority          TEXT,
    source             TEXT NOT NULL,
    generated_at       TEXT NOT NULL,
    PRIMARY KEY (candidate_id, profile_version)
  );

  /* §3.2, §4 — multi-label. Many rows per candidate, by design. */
  CREATE TABLE IF NOT EXISTS candidate_taxonomy_labels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    INTEGER NOT NULL,
    profile_version INTEGER NOT NULL,
    dimension       TEXT NOT NULL,
    concept_id      TEXT NOT NULL,
    raw_label       TEXT,
    confidence      REAL,
    evidence        TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_unique
    ON candidate_taxonomy_labels(candidate_id, profile_version, dimension, concept_id);

  /* §3.3 — several durations per person. 12y credit and 3y leadership are two
     facts, and collapsing them into one number loses the person. */
  CREATE TABLE IF NOT EXISTS candidate_experience_metrics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id    INTEGER NOT NULL,
    profile_version INTEGER NOT NULL,
    domain          TEXT NOT NULL,
    years           REAL,
    leadership_years REAL,
    confidence      REAL,
    evidence        TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_expmetric_unique
    ON candidate_experience_metrics(candidate_id, profile_version, domain);

  /* §8 — the JD as a durable object. Raw text kept forever alongside the
     interpretation, so a future model can reread it without loss (§17). */
  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id INTEGER NOT NULL,
    company_id   INTEGER,
    chat_id      INTEGER,
    title        TEXT,
    raw_jd       TEXT NOT NULL,
    instruction  TEXT,
    jd_version   INTEGER NOT NULL DEFAULT 1,
    jd_hash      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_recruiter ON jobs(recruiter_id, created_at DESC);

  /* §8 — the Job Match Profile. One row per (job, version). */
  CREATE TABLE IF NOT EXISTS job_match_profiles (
    job_id           INTEGER NOT NULL,
    jd_version       INTEGER NOT NULL,
    taxonomy_version TEXT NOT NULL,
    model_version    TEXT,
    source           TEXT NOT NULL,
    interpretation   TEXT,
    concepts         TEXT NOT NULL,
    hard_constraints TEXT NOT NULL,
    must_haves       TEXT NOT NULL,
    preferred        TEXT NOT NULL,
    contextual       TEXT NOT NULL,
    logistics        TEXT,
    embedding        BLOB,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (job_id, jd_version)
  );

  /* §11 — Show More state. Everything needed to continue a search without
     re-analysing or re-showing anyone. */
  CREATE TABLE IF NOT EXISTS retrieval_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER NOT NULL,
    jd_version    INTEGER NOT NULL,
    recruiter_id  INTEGER NOT NULL,
    retrieved_ids TEXT NOT NULL,
    cursor        INTEGER NOT NULL DEFAULT 0,
    pool_size     INTEGER NOT NULL,
    batch_size    INTEGER NOT NULL,
    retrieval_method TEXT,
    excluded      TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_job ON retrieval_sessions(job_id, recruiter_id);

  /* §11 — which candidates this session has already shown. Idempotency for a
     recruiter who clicks Show More twice. */
  CREATE TABLE IF NOT EXISTS displayed_match_state (
    session_id   INTEGER NOT NULL,
    candidate_id INTEGER NOT NULL,
    batch_index  INTEGER NOT NULL,
    displayed_at TEXT NOT NULL,
    PRIMARY KEY (session_id, candidate_id)
  );

  /* §12 — the deep-analysis cache. The primary key IS the cache key from the
     spec, so a stale combination cannot collide with a fresh one. */
  CREATE TABLE IF NOT EXISTS candidate_job_analyses (
    candidate_id     INTEGER NOT NULL,
    profile_version  INTEGER NOT NULL,
    job_id           INTEGER NOT NULL,
    jd_version       INTEGER NOT NULL,
    analysis_model   TEXT NOT NULL,
    scoring_version  TEXT NOT NULL,
    absolute_fit     REAL NOT NULL,
    criteria_results TEXT NOT NULL,
    explanation      TEXT,
    source           TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (candidate_id, profile_version, job_id, jd_version, analysis_model, scoring_version)
  );

  CREATE INDEX IF NOT EXISTS idx_analyses_job ON candidate_job_analyses(job_id, jd_version);

  /* ==================================================================== =====
     CURSUS TRIAGE
     The complementary half of the product. Search ranks people the recruiter
     does not have; Triage ranks the pile they were already sent.

     The tables below deliberately do NOT reuse candidates or jobs. An applicant
     here arrived because a recruiter uploaded their CV, which is not consent to
     join the marketplace, and the two must never be merged by an accidental
     join. Ownership, billing and consent all differ; only the scoring language
     is shared.
     ==================================================================== */

  /* One Triage: one job description, one batch of CVs, one credit.

     Owned by the company rather than by the recruiter who made it, because a
     seat is a person and a Triage is a piece of the organization's hiring. The
     recruiter is recorded as its author, for display.

     status walks forward only: draft -> processing -> ready -> completed, with
     failed reachable from any of them. ready means the first tranche can be
     read; completed means every applicant has been deeply analysed. */
  CREATE TABLE IF NOT EXISTS triages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id        INTEGER NOT NULL,
    recruiter_id      INTEGER,
    title             TEXT,
    raw_jd            TEXT NOT NULL DEFAULT '',
    jd_hash           TEXT,
    /* The parsed JD, stored once and reused for every applicant. Same shape as
       job_match_profiles; kept here so a Triage never depends on a jobs row. */
    match_profile     TEXT,
    profile_source    TEXT,
    status            TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'processing', 'ready', 'completed', 'failed')),
    /* Fixed at launch rather than read live, so raising the cap later cannot
       retroactively change what an already-paid Triage was allowed. */
    file_cap          INTEGER NOT NULL DEFAULT 500,
    /* Denormalised counters. Every one is derivable from triage_applicants;
       they exist so the dashboard can list twenty Triages without twenty
       aggregate scans. Written in the same transaction as the rows they count. */
    total_files       INTEGER NOT NULL DEFAULT 0,
    parsed_files      INTEGER NOT NULL DEFAULT 0,
    failed_files      INTEGER NOT NULL DEFAULT 0,
    analysed_files    INTEGER NOT NULL DEFAULT 0,
    /* How far the rolling buffer has reached, as a count of preliminary ranks
       queued for deep analysis: 50 after the initial pass, then 75, 100, ... */
    analysis_frontier INTEGER NOT NULL DEFAULT 0,
    prelim_done_at    TEXT,
    launched_at       TEXT,
    completed_at      TEXT,
    error             TEXT,
    /* The ledger row that paid for this Triage. Its presence is what makes
       launching idempotent: a second launch finds it and charges nothing.

       Under the CV model it still does exactly that job — the claim on this
       column is the constraint that makes the charge run once — but the amount
       charged is now recorded beside it, because "one Triage" is no longer a
       quantity anybody can reconstruct. */
    ledger_id         INTEGER,
    /* How many CVs this Triage was charged for at launch, and how many of those
       were handed back because the file turned out to be unreadable. Kept per
       Triage rather than derived from the ledger so the workspace can state its
       own cost without a scan of the organization's whole history. */
    charged_cvs       INTEGER NOT NULL DEFAULT 0,
    refunded_cvs      INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_triages_company ON triages(company_id, created_at DESC);

  /* One uploaded CV.

     parse_status and deep_status are separate because they fail separately: a
     PDF with no text layer never reaches analysis, and a model timeout on a
     perfectly readable CV must not be recorded as a bad file. Section 10 asks
     for both to be isolated per file, and one combined column cannot say that.

     prelim_score is INTERNAL. Section 3 is explicit that it must never be shown
     as the Cursus match score, so no route serialises it — it exists only to
     order the queue. */
  CREATE TABLE IF NOT EXISTS triage_applicants (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    triage_id      INTEGER NOT NULL,
    file_name      TEXT NOT NULL,
    stored_name    TEXT NOT NULL,
    file_size      INTEGER,
    mime_type      TEXT,
    /* SHA-256 of the bytes. Two identical CVs under different filenames are one
       applicant and one payment for parsing and for analysis. */
    content_hash   TEXT,
    duplicate_of   INTEGER,
    extracted_text TEXT,
    /* What the CV says about the person, as far as it can be read. Held apart
       from the marketplace's extracted_profiles for the reason at the top of
       this block: same shape, different consent. */
    parsed_fields  TEXT,
    display_name   TEXT,
    email          TEXT,
    phone          TEXT,
    location       TEXT,
    parse_status   TEXT NOT NULL DEFAULT 'pending'
                     CHECK (parse_status IN ('pending', 'parsed', 'unreadable', 'duplicate', 'failed')),
    parse_error    TEXT,
    prelim_score   REAL,
    prelim_rank    INTEGER,
    deep_status    TEXT NOT NULL DEFAULT 'pending'
                     CHECK (deep_status IN ('pending', 'queued', 'running', 'scored', 'failed')),
    deep_error     TEXT,
    /* The absolute fit, before normalisation. Normalisation happens across the
       analysed universe at read time, exactly as Search does it. */
    absolute_fit   REAL,
    criteria       TEXT,
    explanation    TEXT,
    analysis_model TEXT,
    scoring_version TEXT,
    analysis_source TEXT,
    analysed_at    TEXT,
    reviewed_at    TEXT,
    created_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_triage_applicants
    ON triage_applicants(triage_id, prelim_rank);
  CREATE INDEX IF NOT EXISTS idx_triage_applicants_deep
    ON triage_applicants(triage_id, deep_status);
  /* Duplicate detection, scoped to the Triage: the same CV in two different
     Triages is two applicants, because they are two separate pieces of work. */
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_applicant_hash
    ON triage_applicants(triage_id, content_hash) WHERE content_hash IS NOT NULL;

  /* A unit of queued work.

     The idempotency key is the whole reason this table exists rather than a
     status column alone. Section 3.3 requires that refreshing, opening a second
     tab or re-crossing a tranche boundary cannot process or charge the same
     range twice, and a UNIQUE key on (triage, kind, range) enforces that in the
     database rather than in a comment. */
  CREATE TABLE IF NOT EXISTS triage_batches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    triage_id   INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('parse', 'preliminary', 'initial', 'rolling')),
    from_rank   INTEGER,
    to_rank     INTEGER,
    status      TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    idem_key    TEXT NOT NULL,
    error       TEXT,
    created_at  TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_batch_idem ON triage_batches(idem_key);
  CREATE INDEX IF NOT EXISTS idx_triage_batch_queue ON triage_batches(status, id);

  /* Section 9 — what a Triage actually cost us, by stage.

     Recorded per batch rather than per Triage so the preliminary full-set pass
     can be compared against the deep-analysis tranches. That comparison is the
     only thing that can validate the price, and it cannot be reconstructed
     afterwards if it is not written as it happens. Never served to a recruiter. */
  CREATE TABLE IF NOT EXISTS triage_cost_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    triage_id   INTEGER NOT NULL,
    batch_id    INTEGER,
    stage       TEXT NOT NULL,
    model       TEXT,
    applicants  INTEGER NOT NULL DEFAULT 0,
    /* Wall-clock for the stage, and the tokens it burned where the provider
       reports them. Nulls are honest: a deterministic pass has no token count. */
    duration_ms INTEGER,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    retries     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_triage_cost ON triage_cost_events(triage_id, created_at);
`

/**
 * Columns added to tables that predate the spec. Applied with ALTER TABLE so a
 * database with real rows in it upgrades in place.
 */
export const ADDED_COLUMNS = {
  folders: [
    /*
     * Which company the folder belongs to.
     *
     * Folders used to be private to the recruiter who made them — "yours alone,
     * colleagues do not see them". That is the wrong default for a shared seat
     * model: two recruiters at the same company working the same role each kept
     * their own shortlist, neither could see the other's, and the reveal one of
     * them paid for was invisible to the other until they hit the same
     * candidate in a search.
     *
     * `recruiter_id` stays as who created it, for display. Access is by this
     * column, resolved from the caller's own company on every query — see
     * companyOf() in workspace.js — so a folder id from another company reaches
     * nothing rather than reaching across.
     */
    ['company_id', 'INTEGER'],
  ],
  folder_items: [
    /*
     * Where this candidate stands with this recruiter.
     *
     * Holds a decision the recruiter made, or NULL meaning "work it out from
     * what has actually happened". Most of the pipeline is derivable — whether
     * they have been revealed, whether a message went out, whether one came
     * back — and a stage derived from the facts cannot sit there saying "yet to
     * be contacted" over an unread reply. The column exists for the parts no
     * amount of data can tell you: whether the recruiter rates them, and
     * whether they have decided against them. See FOLDER_STATUSES.
     */
    ['status', 'TEXT'],
    /*
     * What they scored when they were filed, and against what.
     *
     * A score is a candidate measured against one job description, so a folder
     * has none of its own — open a saved candidate and the number that made you
     * save them is gone. Copied here at the moment of saving instead, with the
     * search it came from and the reading that produced it, so the row can
     * still explain itself when the search has been renamed or deleted.
     *
     * Denormalised on purpose. This is a record of a judgement made on a day,
     * not a live figure: re-running the search later against a changed pool
     * would give a different number, and quietly replacing it would rewrite
     * why somebody was shortlisted.
     */
    ['score', 'REAL'],
    ['scored_for', 'TEXT'],
    ['scored_at', 'TEXT'],
    ['analysis', 'TEXT'],
  ],
  candidates: [
    // §3.1 — phone is the identity anchor and the dedup control (§14).
    ['phone_verified', 'TEXT'],
    ['phone_verified_at', 'TEXT'],
    ['auth_provider', 'TEXT'],
    // §4.1 consent + freshness.
    ['consent_at', 'TEXT'],
    ['consent_version', 'TEXT'],
    ['last_confirmed_active', 'TEXT'],
    /*
     * When this candidate last signed in.
     *
     * Separate from last_confirmed_active, which only moves when somebody
     * answers the monthly email. Plenty of people never answer that and are
     * plainly still looking — they sign in, read their messages, edit their
     * profile. Treating those as equivalent signals of "still here" is the
     * whole point of holding both: either one alone would call an active
     * candidate stale.
     */
    ['last_seen_at', 'TEXT'],
    ['missed_checkins', 'INTEGER NOT NULL DEFAULT 0'],
    /*
     * Which reminder in the inactivity sequence has already gone out.
     *
     * Holds the day-number of the last one sent — 30, 37, 44, 51 or 58 — and 0
     * while the candidate is active. The sweep sends only when the stage the
     * clock has reached is higher than this, which is what stops five emails
     * landing at once: the sweep runs on every server boot as well as daily, so
     * "have I already sent this one" cannot be inferred from the date alone.
     *
     * Reset to 0 by anything that counts as activity, which is what makes the
     * sequence start again from the top rather than resume mid-way.
     */
    ['freshness_stage_sent', 'INTEGER NOT NULL DEFAULT 0'],
    ['hidden_from_search', 'INTEGER NOT NULL DEFAULT 0'],
    /*
     * When the profile was hidden because nobody confirmed it, as opposed to
     * because the candidate said no.
     *
     * Both end with hidden_from_search = 1 and they are not the same event. One
     * is a decision the candidate made and a recruiter should read as "asked not
     * to be approached"; the other is silence, which means only that we stopped
     * hearing back. Reporting the second as the first puts words in somebody's
     * mouth — and the notification rules turn on the difference too, since only
     * the automatic one is announced internally.
     */
    ['auto_hidden_at', 'TEXT'],
    // Set only by an explicit "no". Distinguishes a deliberate opt-out from
    // simply never having answered, which never hides anyone.
    ['deactivated_at', 'TEXT'],
    // §4.1 intake fields.
    ['open_to_relocation', 'INTEGER'],
    ['preferred_regions', 'TEXT'],
    ['capacity', 'TEXT'],
    ['notice_period', 'TEXT'],
    ['profile_completion', 'REAL'],
    /*
     * §5 — candidate intent. Defaults to 1 (open to everything) so every
     * existing candidate keeps exactly the reach they have today: a migration
     * that silently narrowed who could find them would be a change nobody
     * consented to.
     */
    ['open_to_all_opportunities', 'INTEGER NOT NULL DEFAULT 1'],
    /*
     * §6 — the cache key for everything expensive. Starts at 1 and only ever
     * rises, so a stale analysis can be recognised by comparison alone.
     */
    ['profile_version', 'INTEGER NOT NULL DEFAULT 1'],
    // §6.3 — when intelligence was last built. Drives the six-month cycle.
    ['intelligence_at', 'TEXT'],
  ],
  /*
   * These live in the CREATE TABLE above as well, for a database built from
   * scratch — but `CREATE TABLE IF NOT EXISTS` does nothing to a table that
   * already exists, and there are live Triage rows. Every column added after a
   * table ships has to be here too or it silently never appears.
   */
  triages: [
    ['charged_cvs', 'INTEGER NOT NULL DEFAULT 0'],
    ['refunded_cvs', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  companies: [
    /*
     * Whether each product's capacity is shared out equally by the system
     * rather than by hand. On by default: an organization that has never
     * thought about allowances should still have every seat able to work, and
     * an admin who wants to decide turns it off.
     *
     * One flag per product, never one for both. Reveals and Triage are bought,
     * spent and exhausted independently, and an admin who has fixed Triage
     * allowances by hand has said nothing about how reveals should be split.
     */
    ['reveal_split_equally', 'INTEGER NOT NULL DEFAULT 1'],
    ['triage_split_equally', 'INTEGER NOT NULL DEFAULT 1'],
    ['industry', 'TEXT'],
    ['company_size', 'TEXT'],
    ['normalized_name', 'TEXT'],
    // Who accepted the Terms for the organization, and against which wording.
    ['consent_at', 'TEXT'],
    ['consent_version', 'TEXT'],
    // §3.2 — the key is verified by hash. `key_sealed` holds it encrypted so an
    // org admin can still view it (§3.2 says an admin may retrieve it, which a
    // hash alone cannot satisfy).
    ['company_key_hash', 'TEXT'],
    ['company_key_sealed', 'TEXT'],
    ['company_key_created_at', 'TEXT'],
    // §4.2 — tier and billing live on the org, not the recruiter.
    ['tier', "TEXT NOT NULL DEFAULT 'solo_agency'"],
    ['stripe_customer_id', 'TEXT'],
    ['stripe_subscription_id', 'TEXT'],
    ['reveal_count_period', 'INTEGER NOT NULL DEFAULT 0'],
    ['period_started_at', 'TEXT'],
    // How many recruiter accounts the org may hold. Every company starts with
    // one free seat; each extra one is bought separately. The default applies
    // to existing rows on migration too, so nobody silently gains seats.
    ['seat_limit', 'INTEGER NOT NULL DEFAULT 1'],
    /*
     * §15 removed the shared sign-up secret, which was the only thing standing
     * between a stranger and every CV on the platform. Registration is open now
     * and the gate moved here instead: a company is created immediately and can
     * sign in, but stays 'pending' until someone approves it, and a pending
     * company cannot search, open a profile or reveal anybody.
     *
     * Existing rows default to 'approved' — they were created back when the
     * secret was the gate, and a migration that locked them out would be a
     * different change from the one being made.
     */
    /* 'pending' until reviewed, then 'approved' or 'declined'. The /api/hr gate
       opens for 'approved' and nothing else, so an unrecognised value refuses
       rather than admits. */
    ['approval_status', "TEXT NOT NULL DEFAULT 'approved'"],
    /* Why, and when. Kept rather than deleting the company: a refusal nobody
       recorded gets re-reviewed from scratch every time, and the reason is the
       thing you want in front of you if they register again. */
    ['declined_at', 'TEXT'],
    ['declined_reason', 'TEXT'],
    ['approved_at', 'TEXT'],
    /*
     * Pricing §7 — the organization's reveal wallet.
     *
     * A cache of billing_ledger, kept as a column so the hot path (may this
     * reveal proceed?) is one read rather than a sum over the whole history.
     * Every write to it happens in the same transaction as its ledger row.
     */
    ['reveal_balance', 'INTEGER NOT NULL DEFAULT 0'],

    /*
     * The organization's Triage wallet, denominated in CVs.
     *
     * A second currency, deliberately. A reveal opens one marketplace
     * candidate; Triage capacity processes one applicant CV. Sharing a balance
     * between them would mean a recruiter who bought reveals could silently
     * spend them on Triage and then find themselves unable to open the
     * candidate they went looking for — so "do not silently consume one
     * currency for the other" is enforced by there being no column the two
     * could share.
     *
     * `triage_credits` is the OLD column and counted whole Triage sessions. It
     * is left in place rather than dropped: it is the only record that a
     * company once bought sessions, and a migration cannot convert a session
     * into a number of CVs without inventing an exchange rate. See db.js, which
     * grants those companies a stated CV allocation and says so in the ledger.
     */
    ['triage_credits', 'INTEGER NOT NULL DEFAULT 0'],
    ['triage_cv_balance', 'INTEGER NOT NULL DEFAULT 0'],
    /* Whether the once-per-organization complimentary grant has been made.
       Separate from the balance, which changes constantly. */
    ['complimentary_granted_at', 'TEXT'],
    /* The same, for the Triage allowance. Its own column rather than a shared
       flag: the two grants were introduced at different times, so an
       organization can legitimately have had one and not the other, and one
       column could not tell those apart without granting somebody twice. */
    ['triage_complimentary_granted_at', 'TEXT'],
    /* Additional seats the organization subscribes to, on top of the
       administrator's included one. A state, not a running total. */
    ['purchased_seats', 'INTEGER NOT NULL DEFAULT 0'],
    /* What that subscription costs each month, at the tier in force. */
    ['seat_spend', 'INTEGER NOT NULL DEFAULT 0'],
    /*
     * When the current subscription started, and what it is dropping to.
     *
     * A month is counted from the day the seats were taken on, not from the
     * first of the calendar month — an organization that subscribed on the 17th
     * has paid through to the 17th, and taking the seat away sooner would be
     * charging for time it does not get. `seat_plan_since` is that anchor.
     *
     * `seat_plan_pending` is a reduction that has been asked for and not yet
     * happened: capacity stays at the paid level until the anchor comes round,
     * then falls to this. NULL means nothing is scheduled. Increases never wait
     * — they are paid for immediately and take effect immediately.
     */
    ['seat_plan_since', 'TEXT'],
    ['seat_plan_pending', 'INTEGER'],
    /* The day the pending reduction takes effect, fixed when it is scheduled
       rather than recomputed later. Recomputing walks forward to the next
       anniversary every time it is read, so the date the administrator was
       promised would keep receding and the reduction would never be due. */
    ['seat_plan_pending_at', 'TEXT'],
    /* §12 — automatic replenishment. Off unless an admin turns it on, and it
       names the pack it will buy so nothing is bought by surprise. */
    ['auto_replenish_pack', 'TEXT'],
    ['auto_replenish_at', 'TEXT'],
  ],
  recruiters: [
    /*
     * §9/§10 — how much of the organization's Triage capacity this seat may
     * spend. NULL means "draw freely from the shared pool", which is the
     * default and what every existing seat gets.
     *
     * Deliberately identical in shape to reveal_allocation/allocation_used
     * directly below: an allowance is not a sub-wallet. The organization still
     * owns the whole balance; this only records how much one seat is permitted
     * to draw and how much of that it has drawn. Aggregate consumption can
     * therefore never exceed what was purchased, because the pool is checked
     * as well on every launch.
     */
    ['triage_allowance', 'INTEGER'],
    ['triage_used', 'INTEGER NOT NULL DEFAULT 0'],
    ['email', 'TEXT'],
    ['phone', 'TEXT'],
    // §17 — asked for on the administrator sign-up, beneath the phone number.
    ['website', 'TEXT'],
    ['photo_name', 'TEXT'],
    // §3.2 — deactivation works without rotating the shared key.
    ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
    ['is_org_admin', 'INTEGER NOT NULL DEFAULT 0'],
    /* Pricing §7.2 — this seat's share of the organization's reveals.
       NULL means no share was set: the seat draws freely from the shared pool,
       which is the default and what every organization starts on.

       The pair is an allowance and what has been drawn against it. Held apart
       rather than as one counting-down number so that "you were given 20" and
       "you have spent 12" stay separately answerable — the admin needs both to
       redistribute sensibly, and a single figure can only say one of them.
       Setting a new allowance resets the draw, because the admin is stating how
       many that person gets from here, not amending history. */
    ['reveal_allocation', 'INTEGER'],
    ['allocation_used', 'INTEGER NOT NULL DEFAULT 0'],
    /*
     * The one sign-in this account is currently on, or NULL for none.
     *
     * A seat is bought per person, and a recruiter portal shows revealed
     * contact details — so an account being used in two places at once is
     * either a shared password or a stolen session, and both are worth ending.
     * Signing in writes a new id here, which is what makes every token issued
     * before it stop working: the newest device wins and the older one is
     * signed out on its next request.
     *
     * Newest-wins rather than refusing the second sign-in. Refusing sounds
     * stricter but locks people out of their own account for hours whenever a
     * browser is closed without signing out, and the way out of that is a
     * support request — so the rule that looks tighter is mostly a way of
     * teaching people to share one browser.
     */
    ['session_id', 'TEXT'],
  ],
  contact_messages: [
    // §12 — the new Reason for Contact dropdown.
    ['reason', 'TEXT'],
  ],
  messages: [
    // §4.8 — messages now hang off an explicit thread.
    ['thread_id', 'INTEGER'],
  ],
  search_chats: [
    // Each search owns a folder named after it, so saving a candidate from the
    // results has somewhere obvious to go.
    ['folder_id', 'INTEGER'],
  ],
  seat_purchases: [
    // Cancelling ends the recurring charge; it does not undo the payment that
    // already happened, so `status` stays 'paid' and this records the end date.
    // A seat counts towards the limit while this is null.
    ['cancelled_at', 'TEXT'],
    // Who is sitting in this seat. occupant_name is denormalised on purpose:
    // the whole point is to still know whose seat it was after the account has
    // been deleted, which is exactly when occupant_id becomes null.
    ['occupant_id', 'INTEGER'],
    ['occupant_name', 'TEXT'],
  ],
}

/**
 * §7 — the supporting documents a candidate may attach, by what they ARE.
 *
 * The form used to offer four fixed rows, three of them called "Additional
 * document N", which told a recruiter nothing about what they were opening.
 * These are the types the picker offers instead, each with its own ceiling.
 *
 * Storage is still one file per slot, so a type with a max of three simply owns
 * three slots. That keeps the documents table, the upload fields and the
 * replace-on-conflict behaviour exactly as they were — the change is in what
 * the slots are called and how many of each kind exist.
 */
export const DOCUMENT_TYPES = [
  { key: 'cover_letter', label: 'Cover letter', max: 1 },
  { key: 'certification', label: 'Certification(s)', max: 2 },
  { key: 'recommendation', label: 'Recommendation letter(s)', max: 3 },
  { key: 'additional', label: 'Additional document', max: 1 },
]

/**
 * Upload slots.
 *
 * `extracted` decides whether a document's text is read and used to understand
 * the candidate. All of them are, per §2 and §3.1: supporting documents are
 * listed there precisely because they "may enrich extraction", and a file we
 * accept but never read is a file the candidate uploaded for nothing. An image
 * simply yields nothing, which extraction already treats as a non-event.
 *
 * Derived from DOCUMENT_TYPES rather than written out, so a change to a type's
 * ceiling cannot leave the two lists disagreeing about which slots exist.
 */
export const DOCUMENT_SLOTS = [
  { key: 'cv', label: 'CV / Resume', type: 'cv', required: true, extracted: true },
  ...DOCUMENT_TYPES.flatMap(({ key, label, max }) =>
    Array.from({ length: max }, (_unused, index) => ({
      key: max === 1 ? key : `${key}_${index + 1}`,
      // Numbered only where there can be more than one, so a lone cover letter
      // is not filed as "Cover letter 1".
      label: max === 1 ? label : `${label.replace(/\(s\)$/, '')} ${index + 1}`,
      type: key,
      required: false,
      extracted: true,
    })),
  ),
]

export const DOCUMENT_SLOT_KEYS = DOCUMENT_SLOTS.map((slot) => slot.key)

/**
 * Slots the old form created and the new one no longer offers.
 *
 * Kept so those files stay visible, downloadable and removable rather than
 * being orphaned by a rename. Deliberately not folded into the new types: a
 * document somebody attached as "additional" is not evidence that it is a
 * recommendation letter, and relabelling it would tell a recruiter something
 * the candidate never said.
 */
export const LEGACY_DOCUMENT_SLOTS = [
  { key: 'additional_2', label: 'Additional document 2' },
  { key: 'additional_3', label: 'Additional document 3' },
]

/** The slots whose text is read. Kept as a set so lookups stay a lookup. */
export const EXTRACTED_SLOT_KEYS = DOCUMENT_SLOTS.filter((slot) => slot.extracted).map((slot) => slot.key)

/**
 * §5.2 — 5MB per file, validated server-side as well as client.
 *
 * Two lists, because the CV and the extras are asked for different things. The
 * CV has to be readable as text, so it stays PDF or DOCX; §7 adds PNG and JPEG
 * for the supporting types, where a photographed certificate is a perfectly
 * reasonable thing to attach and nothing depends on reading it.
 */
export const DOCUMENT_EXTENSIONS = ['.pdf', '.docx']
export const SUPPORTING_EXTENSIONS = ['.pdf', '.docx', '.png', '.jpg', '.jpeg']
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

export const CAPACITY_OPTIONS = ['Full time', 'Part time', 'Freelance']

/**
 * Applied to both blocked-company entries and org names so employer blocking
 * matches reliably (§14). Strips legal suffixes so "Acme Ltd" blocks "Acme".
 */
export function normalizeCompanyName(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ltd|limited|inc|incorporated|llc|gmbh|bv|sa|plc|co|corp|corporation)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * §4.1 — the only name form any pre-download recruiter surface may render.
 * "David Cohen" becomes "David C."
 */
/**
 * What a recruiter may see before the reveal event.
 *
 * An allow-list, not a delete-list. Candidates gain columns as the product
 * grows, and a new column must default to hidden — the failure mode of the
 * opposite arrangement is a silent identity leak that nobody notices until it
 * is in someone's search results.
 *
 * Everything here is what the recruiter needs to judge fit: how well they
 * match, what they can do, what they are looking for, and how current it is.
 * Identity and contact are not needed for that, so they are not here.
 */
const PRE_REVEAL_FIELDS = [
  'id', 'location', 'availability', 'capacity', 'notice_period',
  'open_to_relocation', 'preferred_regions',
  'skills', 'notes', 'current_title', 'desired_role',
  'created_at', 'profile_completion',
]

/** Released by the reveal event, on top of the fields above. */
const ON_REVEAL_FIELDS = [
  'name', 'first_name', 'middle_name', 'last_name',
  'email', 'phone', 'links', 'file_name',
]

/**
 * The recruiter-facing view of a candidate.
 *
 * Before the reveal: a first name and nothing else that points at a person — no
 * surname, no last initial, no photograph, no contact details, no filenames. A
 * CV named "Matan Cutler CV.pdf" identifies someone just as well as a database
 * column does, and so does a face.
 */
export function candidateForRecruiter(candidate, { revealed = false } = {}) {
  if (!candidate) return null

  const view = {}
  for (const field of PRE_REVEAL_FIELDS) {
    if (field in candidate) view[field] = candidate[field]
  }

  /*
   * The Professional Summary, under the name it is known by everywhere a
   * recruiter reads it.
   *
   * The column is `notes`, which is what the candidate's own form calls it, and
   * every recruiter surface used to see that raw name — except the profile
   * dialog, which renamed it to `summary` on the way past. So the same
   * paragraph reached a card as `notes` and a dialog as `summary`, and a
   * component written for one of them silently rendered nothing on the other.
   * Named once, here, because this is the function every recruiter view goes
   * through.
   */
  view.summary = candidate.notes ?? null
  view.display_name = maskedDisplayName(candidate.first_name)
  view.open_to_relocation = candidate.open_to_relocation === null
    || candidate.open_to_relocation === undefined
    ? null
    : Boolean(candidate.open_to_relocation)
  view.revealed = revealed

  if (!revealed) return view

  for (const field of ON_REVEAL_FIELDS) {
    if (field in candidate) view[field] = candidate[field]
  }

  /*
   * Once revealed, the short name stops being an abbreviation and becomes a
   * contradiction: the surname is already on the same screen, under Name, and
   * every heading built from display_name would still be saying "Sarah C." over
   * it. The masked form has no job left to do here.
   */
  const full = [candidate.first_name, candidate.last_name].filter(Boolean).join(' ')
  if (full) view.display_name = full

  /*
   * The photograph arrives with the rest of the identity, and not before.
   *
   * A boolean rather than the filename: uploads are named from the file the
   * candidate chose, so the name is itself identifying — the same reason
   * file_name is withheld until now. The recruiter fetches the image from
   * /api/hr/candidates/:id/photo, which applies this gate again on its own
   * account rather than trusting that the flag was respected.
   */
  view.has_photo = Boolean(candidate.photo_name)

  return view
}

/**
 * What a recruiter may call a candidate before paying to know who they are.
 *
 * A first name alone. It used to be "Dana R." — the surname's initial thrown in
 * on the grounds that one letter is not identifying. One letter is a great deal
 * when it is combined with a city, a job title, a seniority and an availability
 * date, all of which sit on the same card: across a company of any size it
 * usually narrows a shortlist to one person, and it does so for exactly the
 * candidate who least wants to be recognised — the one whose current employer
 * is browsing.
 *
 * It also fed the avatar's initials, so "DR" was leaking the same letter a
 * second time to anyone who thought to read the circle rather than the name.
 */
export function maskedDisplayName(firstName) {
  const first = String(firstName ?? '').trim()
  return first || 'Candidate'
}
