/**
 * Wording drafted for the rolling-Triage change, NOT PUBLISHED.
 *
 * Two clauses in the live documents stopped being true when a Triage stopped
 * being a one-off report:
 *
 *   Privacy 7A, "How long": "For as long as the Organization keeps the Triage
 *   workspace." Honest about an afternoon's work. About a session designed to
 *   stay open for weeks it means "forever", concerning people who never heard
 *   of us and never agreed to anything.
 *
 *   Privacy 7A, "Notice and rights": we promise to pass an erasure request to
 *   the Organization and act on its instruction — while the product had no way
 *   to remove one person's CV from a launched session. The only available
 *   action was deleting the whole session, every other applicant with it.
 *
 * Both are now answerable: there is a retention rule and a per-CV delete. This
 * file is the proposed replacement text.
 *
 * It renders ONLY in development, so it is visible in the test version and
 * cannot reach cvrsvs.com: a production build resolves import.meta.env.DEV to
 * false and the bundler drops the whole branch. legal-check asserts the built
 * bundle does not contain it. Publishing it is a deliberate act — move the
 * text into legalDocuments.jsx, move the UPDATED date, and decide what to do
 * about re-consent — and it is not this file's to take.
 */

export const PROPOSAL_MARKER = 'PROPOSED WORDING — NOT IN FORCE'

/*
 * `import.meta.env.DEV` is written out in full at each guard rather than
 * hoisted into a constant, and that is not stylistic.
 *
 * Vite substitutes the literal `false` into a production build, which makes
 * `if (!false) return null` unreachable code that the bundler then deletes —
 * so the wording is not merely un-rendered on the live site, it is not in the
 * bundle at all. Going through `Boolean(import.meta.env?.DEV)` defeated that:
 * the optional chain is not something the substitution can fold, so every
 * sentence below shipped to cvrsvs.com as dead strings anyone could read out
 * of the JavaScript. legal-check is what holds this.
 */

/**
 * The replacement for Privacy 7A's retention and rights clauses.
 *
 * Written to be read by a lawyer beside the current text, which is why it
 * quotes what it replaces rather than only stating the new rule.
 */
export function ProposedTriageRetention() {
  if (!import.meta.env.DEV) return null

  return (
    <aside className="legal-callout legal-proposal">
      <p><strong>{PROPOSAL_MARKER}</strong></p>
      <p>
        Visible in the test version only. The live documents are unchanged and this text has no
        effect. It replaces the two bullets in 7A marked <em>How long</em> and
        {' '}<em>Notice and rights</em>.
      </p>

      <p><strong>How long.</strong> Replacing: &ldquo;For as long as the Organization keeps the
        Triage workspace. Deleting the workspace deletes the documents and the files
        themselves.&rdquo;
      </p>
      <blockquote>
        <p>
          <strong>How long.</strong> Until the earlier of: ninety days after the Organization
          closes the Triage workspace, or twelve months after the document was uploaded. A
          workspace that is reopened is no longer closed, and the ninety-day period restarts when
          it is closed again; the twelve-month period runs from the upload and is not restarted
          by anything. At the end of the applicable period CURSUS deletes the uploaded document,
          the text read from it, the details found in it and the analysis produced from it. The
          Organization&rsquo;s own billing record of the workspace is retained, and contains no
          applicant data. The Organization may also delete a workspace, or an individual
          document within it, at any time before then.
        </p>
      </blockquote>

      <p><strong>Notice and rights.</strong> Replacing the final sentence of that bullet.</p>
      <blockquote>
        <p>
          <strong>Notice and rights.</strong> The obligation to tell applicants that their
          application will be processed this way rests with the Organization that received it. An
          applicant who believes CURSUS holds their CV may contact us using Section 18; we will
          identify the Organization concerned, pass the request to it, and act on its
          instruction, and we will respond directly where the law requires us to. CURSUS is able
          to remove an individual document, and everything read from it, from a Triage workspace
          without affecting the other applications in it.
        </p>
      </blockquote>

      <p><strong>Why this changed.</strong> A Triage used to be a single pile of CVs ranked once.
        It can now stay open and take further documents over time, so &ldquo;as long as the
        Organization keeps the workspace&rdquo; no longer describes a bounded period. The second
        change records a capability the product did not previously have: until now the only way
        to remove one applicant&rsquo;s document was to delete the entire workspace.
      </p>

      <p><strong>Still to decide, not for CURSUS to decide alone:</strong></p>
      <ul>
        <li>
          Whether ninety days and twelve months are the right numbers. Both are configurable
          without a code change, so they can be set to whatever review concludes.
        </li>
        <li>
          Whether Organizations with open workspaces must be told before the first deletion runs,
          and how long before.
        </li>
        <li>
          Whether this counts as a material change requiring notice under Terms 17, or a
          clarification that may be posted with an updated date.
        </li>
      </ul>
    </aside>
  )
}

/**
 * The matching note for the Terms, where the Organization is told what it is
 * agreeing to about other people's data.
 */
export function ProposedTriageTerms() {
  if (!import.meta.env.DEV) return null

  return (
    <aside className="legal-callout legal-proposal">
      <p><strong>{PROPOSAL_MARKER}</strong></p>
      <p>
        Visible in the test version only. Proposed as an addition to the Triage section of the
        Terms, so that the retention rule is something the Organization has agreed to rather than
        something it reads about in the Privacy Policy.
      </p>
      <blockquote>
        <p>
          <strong>Retention of Triage documents.</strong> Documents uploaded to a Triage workspace
          are deleted ninety days after the workspace is closed, or twelve months after upload,
          whichever is earlier. The Organization is responsible for retrieving anything it needs
          before then, and for any record-keeping obligation of its own that outlasts those
          periods; CURSUS does not hold Triage documents as an archive on the
          Organization&rsquo;s behalf. The Organization may close, reopen or delete a workspace,
          and may delete an individual document within one, at any time.
        </p>
      </blockquote>
    </aside>
  )
}
