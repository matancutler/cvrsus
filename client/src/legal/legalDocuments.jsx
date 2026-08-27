/**
 * The Terms of Service and the Privacy Policy, verbatim.
 *
 * One copy of each. They are rendered in two places — the /terms and /privacy
 * pages, and the modal behind the consent checkbox on the two account-creation
 * forms — and a document that says one thing on the page a candidate agreed to
 * and another on the page they can read afterwards is worse than no document.
 * So both places import from here, and neither restates a word.
 *
 * One deliberate departure from the supplied drafts:
 *
 *    The bracketed fields — [LEGAL ENTITY NAME], [PRIVACY EMAIL] and the rest —
 *    are left exactly as they are, and marked up so they read as unfilled rather
 *    than as text. They are the operator's own identity and contact routes.
 *    Inventing an entity name or a support address would produce a document that
 *    looks complete and names a company that does not exist, which is the one
 *    failure mode a legal page cannot have. See <Placeholder /> below.
 *
 * Both drafts also carry the operator's own instruction that they are not for
 * publication until those fields and the launch details are confirmed. That
 * notice is surfaced on the page rather than dropped — see DRAFT_NOTICE.
 *
 * The brand reads CURSUS throughout, as the drafts wrote it and as the rest of
 * the running text on the site now does. Note that the wordmark in the header
 * and footer still reads CVRSVS: the logo was left alone deliberately, so these
 * documents name a brand whose spelling differs from the mark at the top of the
 * page they are served on. That is a question for whoever signs them off, not
 * something to quietly reconcile here — a legal document should say what the
 * operator means it to say.
 */

/**
 * An unfilled field from the draft.
 *
 * Rendered rather than removed. A reader who reaches "contact
 * [PRIVACY EMAIL]" learns something true — that the route exists and has not
 * been published — where a silently deleted placeholder would leave a sentence
 * that reads as finished and tells them nothing.
 */
function Placeholder({ children }) {
  return <span className="legal-placeholder">[{children}]</span>
}

export const DRAFT_NOTICE =
  'This is a draft pending legal review. The operator’s registered details and '
  + 'contact addresses are still marked as unfilled fields below.'

/* One constant: the two documents were issued together and are meant to move
   together. Revised from the supplied drafts' 15 August 2026 when both were
   brought into line with what the platform actually does — Triage, the public
   demonstration, the seat subscription and automatic top-up, the named AI
   sub-processors, and what survives a deletion. */
const UPDATED = '24 August 2026'

function TermsBody() {
  return (
    <>
      <p className="legal-updated">Last updated: {UPDATED}</p>

      <aside className="legal-callout">
        <h2>Important draft status</h2>
        <p>
          This document is a product-specific legal draft for counsel review, not legal advice.
          Before publication, CURSUS must replace the bracketed operator/contact fields and confirm
          the launch jurisdiction, payment rules, vendors, cookie stack and retention periods listed
          in the final implementation checklist.
        </p>
      </aside>

      <p>
        These Terms of Service (the &ldquo;Terms&rdquo;) govern access to and use of CURSUS,
        including the website, the candidate marketplace, recruiter tools, matching functionality,
        messaging, profile-reveal features, CURSUS Triage, the public demonstration and related
        services (collectively, the &ldquo;Service&rdquo;).
      </p>
      <p>
        The Service is operated under the CURSUS brand by <Placeholder>LEGAL ENTITY NAME</Placeholder>,
        with registered address at <Placeholder>REGISTERED ADDRESS</Placeholder> (&ldquo;CURSUS&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo; or &ldquo;our&rdquo;). By creating an account, accessing or
        using the Service, you agree to these Terms. If you use the Service on behalf of a company or
        other organization, you represent that you have authority to bind that organization.
      </p>

      <h2>1. Eligibility and Account Types</h2>
      <p>
        You must be at least 18 years old, or the age of legal majority where you live if higher, to
        create or use a CURSUS account. Both account-creation forms ask you to affirm this, and
        neither will create an account without it; the affirmation, its date and the version of the
        wording you were shown are recorded. CURSUS does not ask for a date of birth or for proof of
        age, so it relies on that affirmation. You may use only one candidate identity and must
        provide accurate account information.
      </p>

      <h3>Candidate Accounts</h3>
      <p>
        Candidate Accounts are for individuals presenting their own professional background and
        considering employment, freelance, consulting or other professional opportunities. Candidate
        access is currently free unless CURSUS clearly introduces a paid feature and you affirmatively
        choose it.
      </p>

      <h3>Recruiter and Organization Accounts</h3>
      <p>
        Recruiter Accounts are for authorized employees, internal recruiters, hiring managers and
        other professional users acting for legitimate hiring purposes. You must accurately identify
        the organization you represent. Organization administrators may add or remove seats, manage
        permissions, view organization-level usage and control shared Reveal Credits where those
        features are available.
      </p>
      <p>
        You are responsible for maintaining the confidentiality of credentials, one-time codes and
        connected sign-in accounts, and for activity performed through your account. Notify us
        promptly at <Placeholder>SUPPORT EMAIL</Placeholder> if you suspect unauthorized access.
      </p>

      <h2>2. What CURSUS Provides</h2>
      <p>
        CURSUS is a talent discovery and matching marketplace. Candidates provide one professional
        profile and current CV. Recruiters provide role requirements, typically through a job
        description. CURSUS then uses software, including automated and AI-assisted systems, to
        identify and rank potentially relevant candidates.
      </p>
      <p>
        The Service may include profile parsing, matching scores, ranking explanations, search and
        filtering, organization workspaces, saved candidate folders, messaging, activity-status
        checks, withheld profile fields, profile reveals and related recruiting workflow tools.
      </p>

      <h3>The two products</h3>
      <p>
        CURSUS sells two distinct services, and they process different people&rsquo;s information.
      </p>
      <ul>
        <li>
          <strong>Search</strong> matches a recruiter&rsquo;s role against the CURSUS candidate
          marketplace: people who have created a Candidate Account and chosen to be discoverable.
        </li>
        <li>
          <strong>CURSUS Triage</strong> ranks CVs the recruiter already holds. The recruiter
          uploads applications they received through their own channels and CURSUS orders them
          against the role. The people in those documents are <em>not</em> CURSUS users. They have
          no account, no profile, no visibility controls and no prior relationship with CURSUS, and
          they are not added to the marketplace. Section 4 and Section 11 set out what a recruiter
          warrants when uploading them.
        </li>
      </ul>

      <h3>The public demonstration</h3>
      <p>
        CURSUS operates a Live Demo that anyone may use without an account. It has two halves and
        both use the real system rather than a mock-up:
      </p>
      <ul>
        <li>
          A demonstration search runs against the live candidate marketplace and returns real
          candidates in the withheld form described in Section 6. No identity, contact details or
          documents are disclosed, and nothing in the demonstration can spend a Reveal.
        </li>
        <li>
          A demonstration of Triage accepts a limited number of CVs from the visitor, ranks them and
          returns the ranking. The uploaded files are read and deleted in the course of answering the
          request and no copy is retained.
        </li>
      </ul>
      <p>
        Using the Live Demo means accepting these Terms for that use, whether or not an account is
        created. Section 10A sets out what a visitor may and may not submit.
      </p>
      <p>
        CURSUS is not an employer, recruitment agency, staffing firm, employment law adviser,
        background-check provider or party to any employment agreement unless we expressly state
        otherwise for a particular service. We do not guarantee that any candidate will be contacted,
        interviewed, hired or remain employed, or that any recruiter will find a suitable candidate.
      </p>

      <h2>3. Candidate Rules and Authenticity</h2>
      <p>
        CURSUS is designed around a consistent professional profile rather than role-by-role
        application tailoring. By using a Candidate Account, you agree that information you submit
        will truthfully represent you and your professional history.
      </p>
      <ul>
        <li>
          Your CV, profile, employment history, education, skills, availability and other
          professional information must be materially accurate and not misleading.
        </li>
        <li>
          You may update or replace your CV when your real professional information changes, but you
          may not impersonate another person or fabricate credentials, employment, qualifications,
          references or achievements.
        </li>
        <li>
          You should not upload unnecessary sensitive information such as national identification
          numbers, financial account data, medical information, biometric data, political views,
          religion, sexual orientation or other special-category information unless it is genuinely
          necessary and lawful to do so.
        </li>
        <li>
          You remain responsible for the content and accuracy of documents generated outside CURSUS,
          including any material created or edited with third-party AI tools.
        </li>
      </ul>
      <p>
        CURSUS may flag, deprioritize, hide, request correction of or remove incomplete, suspicious,
        misleading or low-quality profiles. We may use both automated checks and human review to
        protect marketplace quality.
      </p>

      <h2>4. Recruiter Rules and Responsible Hiring</h2>
      <p>
        Recruiters and Organizations may use candidate information only for genuine recruiting,
        workforce planning and hiring-related communication on behalf of the organization identified
        in the account.
      </p>
      <ul>
        <li>
          Do not use the Service to advertise products, sell services, build marketing lists, enrich
          unrelated databases, resell candidate data or conduct non-recruiting solicitation.
        </li>
        <li>
          Do not scrape, crawl, systematically copy, export or harvest candidate information except
          through functionality CURSUS expressly provides.
        </li>
        <li>
          Do not share revealed candidate data outside your organization except with service
          providers or advisers who genuinely need it for the same hiring process and are subject to
          appropriate confidentiality/privacy obligations.
        </li>
        <li>
          Retain revealed candidate information only for as long as reasonably necessary for
          legitimate recruitment or hiring purposes. Do not retain candidate data indefinitely merely
          because it was revealed.
        </li>
        <li>
          If you learn — from CURSUS, from the candidate, or otherwise — that a candidate has
          withdrawn, deleted their account or requested deletion, delete or anonymize the copies
          your organization holds when they are no longer needed, unless your organization has an
          independent lawful basis, an active recruitment need or a legal obligation to retain it.
        </li>
        <li>
          Where CURSUS offers candidate-facing profile-view transparency, your name, organization and
          the date/time of a profile view may be shown to the candidate.
        </li>
        <li>
          Do not use candidate data or CURSUS matching outputs to discriminate unlawfully. Hiring
          decisions remain your responsibility and must comply with applicable employment, equality,
          labor and privacy laws.
        </li>
        <li>
          Do not attempt to infer or use protected or sensitive characteristics that CURSUS did not
          ask the candidate to provide.
        </li>
      </ul>
      <p>
        Once your organization receives candidate information, including after a Reveal, your
        organization may independently become responsible for how it stores, uses, shares and
        deletes that information under applicable law. A Reveal lets your recruiters open the
        candidate&rsquo;s documents and download them, and a CV saved to a laptop, a shared drive or
        an applicant-tracking system is your organization&rsquo;s copy from that moment on, held on
        your own lawful basis and under the rules above. CURSUS does not control your off-platform
        recruiting process, and has no way to recall, expire or delete a file you already hold.
      </p>

      <h3>Uploading other people&rsquo;s applications to Triage</h3>
      <p>
        Where an Organization uses CURSUS Triage it uploads documents about people who are not
        CURSUS users and who have no way of knowing that CURSUS holds them. That places the
        Organization, and not CURSUS, in the position of deciding why those documents are being
        processed. Accordingly:
      </p>
      <ul>
        <li>
          The Organization is the controller of applicant data it uploads to Triage. CURSUS processes
          it on the Organization&rsquo;s documented instructions and for no independent purpose;
          applicant data is not added to the candidate marketplace, is not used to match other roles,
          and is not used to train any model.
        </li>
        <li>
          The Organization confirms that it lawfully received each document, that it is entitled to
          have it processed by CURSUS and its sub-processors (Section 13), and that it has given the
          applicant whatever notice the law requires, including notice that a third-party service
          will read and rank their application.
        </li>
        <li>
          The Organization remains responsible for answering an applicant&rsquo;s access, correction,
          objection or erasure request. CURSUS will assist as processor and will delete a Triage
          workspace and its documents on the Organization&rsquo;s instruction.
        </li>
        <li>
          Ranking is an ordering aid. The Organization remains responsible for the decisions it takes
          about the people in the pile, including any obligation to consider them fairly.
        </li>
      </ul>

      <h2>5. Matching, Ranking and AI-Assisted Features</h2>
      <p>
        Matching scores and rankings are estimates of relevance based on available profile
        information, candidate preferences, recruiter-provided requirements and system logic. They can
        be incomplete, wrong or affected by ambiguous or inaccurate source data.
      </p>
      <p>
        CURSUS does not represent that a higher score means a candidate is objectively better, more
        qualified or legally eligible for a role. Recruiters must independently review candidate
        information and use human judgment. CURSUS does not make hiring decisions. Recruiters and
        employers make all decisions regarding whether to view, contact, interview, reject, hire,
        promote or terminate any person.
      </p>
      <p>
        We may change, retrain, replace or discontinue matching methods, ranking logic or AI providers
        as the Service evolves. Where appropriate, we may use automated systems to parse documents,
        detect incomplete profiles, rank candidates, identify spam or abuse and improve search
        quality.
      </p>

      <h2>6. Profile Visibility, Company Blocks and Activity Status</h2>
      <p>
        Candidate visibility is controlled by product settings and these Terms. A candidate who opts
        into the marketplace authorizes CURSUS to make relevant portions of their professional profile
        discoverable to recruiter users, and to visitors of the public demonstration described below,
        subject to the candidate&rsquo;s visibility preferences and company-block settings.
      </p>

      <h3>Before a Reveal</h3>
      <p>
        Until a Reveal, CURSUS withholds the candidate&rsquo;s surname, email address, telephone
        number, links, photograph, document filenames and documents themselves. What remains visible
        is the candidate&rsquo;s first name, city, current and desired role, seniority, availability,
        capacity, notice period, relocation preference, skills and their professional summary —
        which they may have written themselves, and from which the names of their employers have
        been removed.
      </p>
      <p>
        Candidates should understand that this is withholding, not anonymity. A first name together
        with a city, a job title and a summary of a career can identify a person to somebody who
        already knows them, and a current employer in particular. Candidates who need to be certain a
        specific company cannot recognise them should use the company block below rather than rely on
        the withheld fields.
      </p>

      <h3>The public demonstration</h3>
      <p>
        The Live Demo described in Section 2 shows real candidates, in the withheld form above, to
        visitors who have no account. Fewer fields are shown than a signed-in recruiter sees, no
        Reveal can be spent, and no view is recorded against the candidate. Opting into the
        marketplace includes appearing in the demonstration. A candidate who does not want to appear
        there can hide their profile from search entirely, or block the companies they are concerned
        about, using the controls in their account.
      </p>

      <h3>Company blocks</h3>
      <p>
        Candidates may name the companies they wish to hide from, from their own account. A block is
        a live restriction rather than a preference about future searches: it removes the candidate
        from that company&rsquo;s searches, from any search already open when the block was added,
        and from every other place its recruiters could otherwise reach the person: the
        profile, a Reveal, the documents, the photograph, saved folders and shortlists, message
        threads, and the notes and tags that team had written about them. This holds where a
        recruiter already holds the candidate&rsquo;s identifier from an earlier search, a colleague
        or a saved folder, and where the Organization revealed the candidate before the block was
        added. No refund is due for a Reveal that a later block puts out of reach.
      </p>
      <p>
        A block is matched on the company identity CURSUS holds, and the matching is deliberately
        more forgiving than exact spelling: differences of case, punctuation, spacing and common
        legal suffixes are disregarded, and a name you give is treated as covering a longer
        registered name that begins with it, so naming &ldquo;KPMG&rdquo; also covers &ldquo;KPMG
        Israel&rdquo;. It is not a resemblance test: a company that merely shares a common word with
        the name you gave is not treated as that company.
      </p>
      <p>
        CURSUS cannot guarantee that every affiliate, alternate trading name, newly created account
        or misrepresented recruiter identity will be detected, and a block does not reach information
        a recruiter obtained before it was set or holds outside the Service. Where a company you have
        blocked trades under a name you would not think to give, naming that name as well is the only
        thing that will reach it.
      </p>
      <p>
        CURSUS asks candidates roughly every thirty days to confirm that they remain open to
        opportunities. A profile that stops confirming is <em>labelled</em> with how long it has been
        unconfirmed and stays discoverable; it is not hidden. A candidate who answers that they are no
        longer looking, or who hides their profile themselves, is removed from discovery until they
        return. Neither state is account deletion.
      </p>

      <h2>7. Reveals, Credits and Capacity</h2>
      <p>
        A &ldquo;Reveal&rdquo; is an in-product action that unlocks the candidate information
        identified in the confirmation screen. Depending on the product version, this may include a
        fuller professional profile, contact details or other designated information.
      </p>
      <ul>
        <li>A Reveal Credit is consumed only when the Service confirms the Reveal action.</li>
        <li>Purchased Reveal Credits do not expire.</li>
        <li>
          Reveal Credits have no cash value, are not transferable outside the purchasing organization
          and cannot be resold.
        </li>
        <li>
          Where organization workspaces are enabled, Reveal Credits may be shared across authorized
          seats in the organization account and used according to administrator permissions.
        </li>
        <li>
          Promotional, trial or complimentary credits may be subject to separate limitations disclosed
          when granted. A new Organization currently receives a complimentary balance of Reveal
          Credits and a complimentary allowance of Triage capacity; the amounts are stated on the
          pricing page and may change for Organizations created later.
        </li>
      </ul>

      <h3>What a Reveal unlocks, and for how long</h3>
      <ul>
        <li>
          A Reveal is bought by the Organization, not by the individual who pressed it. Once any seat
          reveals a candidate, every seat in that Organization sees the candidate unmasked, at no
          further charge, including colleagues who join afterwards.
        </li>
        <li>
          A Reveal releases the fields Section 6 lists as withheld, the documents among them. The
          recruiter can read the CV and anything filed with it, and can download those files onto
          the Organization&rsquo;s own computers and systems; that is what the charge buys, and it
          is the point at which a copy of the candidate&rsquo;s documents leaves CURSUS.
        </li>
        <li>
          A Reveal is not a permanent entitlement to the candidate&rsquo;s data. If the candidate
          deletes their account, or blocks the Organization, the profile and the documents stop
          being reachable through the Service and no refund is due. What ends is CURSUS serving
          them: a file the Organization already downloaded is its own copy, on its own systems, and
          governed by Section 4, which already requires the Organization to hold its own copy of
          anything it needs to keep for a live hiring process, on its own lawful basis.
        </li>
      </ul>

      <h3>Triage capacity</h3>
      <ul>
        <li>
          Triage capacity is counted in CVs, is shared across the Organization, and does not expire.
        </li>
        <li>
          Capacity is consumed when a Triage is launched, at one unit per valid CV submitted for
          processing. Creating a workspace, uploading files and deleting them beforehand cost
          nothing. Duplicates and files that cannot be read are not charged for.
        </li>
        <li>
          Where processing fails on our side, the capacity for the affected CVs is returned to the
          Organization&rsquo;s balance.
        </li>
      </ul>

      <h3>Seats</h3>
      <ul>
        <li>
          Seats are a recurring monthly subscription and are described in Section 8. They are not
          credits: a seat carries no balance of its own, and buying Reveal Credits or Triage capacity
          adds no seats.
        </li>
      </ul>
      <p>
        Except where required by law or where CURSUS confirms a duplicate charge, technical failure or
        other billing error, completed Reveals and purchased credit packs are non-refundable. If
        CURSUS permanently discontinues paid Reveal functionality, we will provide a commercially
        reasonable remedy for unused purchased credits, which may include continued access, conversion
        to an equivalent service or a refund, as required by applicable law.
      </p>

      <h2>8. Fees, Billing and Taxes</h2>
      <p>
        Recruiter pricing, pack sizes, discounts and taxes are shown at the point of purchase. You
        authorize CURSUS and its payment providers to charge the payment method you select for
        purchases you approve, and for any standing instruction you have switched on.
      </p>
      <aside className="legal-callout">
        <h3>Current billing status</h3>
        <p>
          No payment processor is connected to the Service at the date above. Purchases are recorded
          against the Organization&rsquo;s account and the corresponding credits or capacity are
          granted, but no money is taken and no payment card is collected. The Service says so at the
          point of purchase. Before charging begins, CURSUS will name the payment provider, collect a
          payment method, and state how balances recorded during this period are treated.
        </p>
      </aside>
      <h3>One-off purchases</h3>
      <p>
        Reveal Packs and Triage capacity packs are one-off purchases. They do not renew, and CURSUS
        will not charge for them again unless a user affirmatively initiates a new purchase, subject
        to the standing instruction described below.
      </p>

      <h3>Seats are a monthly subscription</h3>
      <p>
        The administrator account is included at no monthly charge. Additional seats are a recurring
        monthly subscription at the tier the Organization selects.
      </p>
      <ul>
        <li>
          The monthly period runs from the day the subscription was first taken on, not from the
          first of the calendar month.
        </li>
        <li>
          Increasing the seat count takes effect immediately and is charged immediately.
        </li>
        <li>
          Reducing the seat count is scheduled rather than immediate: the Organization keeps the
          capacity it has paid for until the next anniversary, and the lower tier begins from that
          date. Reductions are not refunded for the remainder of the paid period.
        </li>
        <li>
          If a reduction would leave fewer seats than the Organization has occupants, the accounts
          that lose their seat on the effective date are deleted, together with the work held in
          them. Section 15 sets out how they are chosen and what is destroyed. The administrator is
          responsible for exporting anything the Organization wants to keep before that date.
        </li>
      </ul>

      <h3>Automatic top-up</h3>
      <p>
        An administrator may switch on a standing instruction to buy a named Reveal Pack whenever the
        Organization&rsquo;s reveal balance reaches zero. Where it is switched on:
      </p>
      <ul>
        <li>
          the charge is made without a further approval at the moment of purchase; that is the
          purpose of the instruction;
        </li>
        <li>
          it can be triggered by any seat in the Organization attempting a Reveal, not only by the
          administrator;
        </li>
        <li>
          it buys one pack at a time, at the pack price then shown, and is recorded in the billing
          history as an automatic purchase; and
        </li>
        <li>
          it is off unless an administrator turns it on, and can be turned off at any time from the
          billing screen.
        </li>
      </ul>
      <p>
        If the top-up cannot be completed, the Reveal is refused and the Organization is told it is
        out of reveals. Nothing is charged for a Reveal that did not happen.
      </p>
      <p>
        Organizations are responsible for applicable taxes, duties and similar governmental charges
        other than taxes based on CURSUS&rsquo;s net income. We may suspend paid features for
        chargebacks, fraud, overdue amounts or payment-provider restrictions.
      </p>

      <h2>9. Messaging and Communications</h2>
      <p>
        The Service may allow recruiters and candidates to exchange messages and may send operational
        or transactional notices by email, SMS or in-app notification, including sign-in codes,
        account activity notices, candidate-contact alerts, security notices and marketplace status
        checks.
      </p>
      <p>
        At launch, CURSUS does not use email or SMS to send promotional advertising. If CURSUS later
        introduces promotional email or SMS, it will obtain consent where required by applicable law
        and provide an effective way to withdraw or unsubscribe.
      </p>
      <p>
        You may not use messaging to harass, threaten, deceive, spam or solicit users for unrelated
        purposes. CURSUS may use automated systems and, when reasonably necessary for safety, abuse
        prevention or support, authorized personnel to review metadata or message content consistent
        with the Privacy Policy and applicable law.
      </p>

      <h2>10. Acceptable Use</h2>
      <p>You must not:</p>
      <ul>
        <li>Violate any law, regulation, court order or third-party right.</li>
        <li>
          Attempt to gain unauthorized access to accounts, systems, source code, non-public APIs,
          model prompts, ranking logic or security controls.
        </li>
        <li>
          Reverse engineer, benchmark for the purpose of building a competing service, copy at scale,
          frame or systematically reproduce material from the Service except where applicable law does
          not permit that restriction.
        </li>
        <li>
          Introduce malware, automated abuse, denial-of-service traffic or excessive requests that
          interfere with the Service.
        </li>
        <li>
          Create fake recruiter organizations, fake candidates, duplicate identities or misleading
          profiles.
        </li>
        <li>
          Use candidate information for background investigations, credit decisions, insurance,
          housing, lending or other purposes unrelated to recruiting unless CURSUS has expressly
          enabled that use and it is lawful.
        </li>
        <li>
          Circumvent Reveal controls, usage limits, access restrictions, payment mechanisms or
          company-block settings.
        </li>
      </ul>
      <p>
        We may investigate suspected abuse and cooperate with lawful requests from courts, regulators
        and law-enforcement authorities.
      </p>

      <h2>10A. Using the Service Without an Account</h2>
      <p>
        The Live Demo is open to anyone. Using it means accepting these Terms for that use even
        though no account is created, and Sections 10, 17, 18 and 19 apply to it in full.
      </p>
      <ul>
        <li>
          You may submit a job description and a limited number of CVs, as stated in the product. The
          limits are enforced by the Service and may change.
        </li>
        <li>
          If you upload a CV, you confirm that you lawfully hold it and are entitled to have CURSUS
          read it for the purpose of ranking it. Do not upload documents you have no right to
          disclose. Section 19&rsquo;s indemnity applies to what you upload.
        </li>
        <li>
          Uploaded files are read to produce the ranking and deleted in the course of answering the
          request. CURSUS keeps no copy of them, creates no profile from them and does not add them
          to the marketplace. A record that a demonstration ran, tied to a device fingerprint rather
          than to you, is kept to enforce the limits; the Privacy Policy describes it.
        </li>
        <li>
          Candidates shown in the demonstration search are real people. You may not attempt to
          identify them, aggregate the results, automate requests, or use anything shown for any
          purpose other than evaluating whether to open an account.
        </li>
        <li>
          The demonstration is provided as-is, is rate limited, may be withdrawn or changed at any
          time, and produces no entitlement of any kind.
        </li>
      </ul>

      <h2>11. User Content and License to CURSUS</h2>
      <p>
        You retain ownership of CVs, cover letters, job descriptions, messages, company materials and
        other content you submit (&ldquo;User Content&rdquo;). You grant CURSUS a worldwide,
        non-exclusive, royalty-free license to host, copy, parse, transform, index, display and
        otherwise process User Content only as reasonably necessary to operate, secure, support,
        maintain and improve the Service and as described in the Privacy Policy. This license does not
        permit CURSUS to use candidate CVs, cover letters or identifiable candidate profile content to
        train a general-purpose AI model.
      </p>
      <p>
        You represent that you have the rights and permissions needed to submit User Content and allow
        CURSUS to process it. For recruiter-uploaded job descriptions or company materials, you
        confirm that you are authorized to use them for recruiting.
      </p>
      <p>
        We may create aggregated or de-identified information that does not reasonably identify an
        individual and use it for analytics, benchmarking, security and product improvement, subject
        to applicable law.
      </p>

      <h2>12. CURSUS Intellectual Property</h2>
      <p>
        CURSUS and its licensors own the Service, software, design, brand assets, databases, matching
        systems, interfaces, documentation and other proprietary materials, excluding User Content.
        These Terms grant you a limited, revocable, non-exclusive and non-transferable right to use
        the Service for its intended purpose.
      </p>
      <p>
        Feedback, suggestions and product ideas you voluntarily provide may be used by CURSUS without
        restriction or compensation, provided we do not publicly identify you as the source without
        permission.
      </p>

      <h2>13. Third-Party Services</h2>
      <p>
        CURSUS relies on a small number of sub-processors that it has chosen, and which receive
        content you submit. These are not services &ldquo;you choose to use&rdquo;: they are part of
        how the Service works, and CURSUS remains responsible for them. They are named, with what
        each receives, in the Privacy Policy.
      </p>
      <p>
        Where the Service links out to a third party you choose to use on your own account, CURSUS is
        not responsible for that service, except to the extent applicable law provides otherwise.
      </p>

      <h2>14. Privacy</h2>
      <p>
        Our Privacy Policy forms part of these Terms and explains how CURSUS handles personal
        information. By using the Service, you acknowledge the practices described there. Recruiters
        and Organizations must also comply with their own legal obligations when processing candidate
        data obtained through CURSUS.
      </p>

      <h2>15. Suspension and Termination</h2>
      <p>
        You may stop using the Service at any time. Candidates may request account deletion through
        available account settings or by contacting <Placeholder>PRIVACY EMAIL</Placeholder>.
        Organization administrators may remove seats and close individual recruiter accounts from
        the Team screen. To close an Organization entirely, contact CURSUS using the details in
        Section 23; we will confirm what is deleted and what is retained subject to outstanding
        legal, billing and security obligations.
      </p>
      <p>
        We may restrict, suspend or terminate access if we reasonably believe you violated these
        Terms, created security or legal risk, failed to pay amounts due, misrepresented your identity
        or organization, abused candidate data or materially disrupted the Service. Where appropriate
        and legally permitted, we will provide notice and a reasonable opportunity to address the
        issue.
      </p>
      <p>
        Provisions that by their nature should survive termination — including payment obligations,
        intellectual property, confidentiality, disclaimers, liability limits, indemnity and dispute
        provisions — will survive.
      </p>

      <h3>What deletion actually removes, and what survives it</h3>
      <p>
        Closing an account is not the same as erasing every trace of it, and the difference is set
        out here rather than left to be discovered.
      </p>
      <ul>
        <li>
          <strong>A candidate deleting their profile</strong> removes the profile, the documents and
          the files themselves, everything CURSUS derived from them, the message history, and the
          notes, tags and shortlist entries recruiters wrote about them. Recruiter Organizations lose
          the Reveal record for that candidate and receive no refund; usage figures may therefore fall
          retrospectively. Deletion works forwards, and it reaches only CURSUS&rsquo;s own copies: a
          document a recruiter downloaded before the account was closed is already on that
          Organization&rsquo;s systems, Section 4 governs what they may do with it, and nothing
          CURSUS does afterwards can reach it.
        </li>
        <li>
          <strong>A recruiter account being deleted</strong> hands its folders and saved work to a
          remaining colleague where there is one. The Organization&rsquo;s Reveal records survive so
          colleagues do not lose access to candidates the Organization has paid for; the departed
          recruiter&rsquo;s name is removed from them.
        </li>
        <li>
          <strong>Records that survive.</strong> Billing ledger entries are kept as the
          Organization&rsquo;s financial record and are not deleted; a line recording a Reveal
          continues to reference the candidate it was spent on after that account is gone. The
          access history — which Organization opened which profile, and when — survives a
          recruiter account being closed, and carries that recruiter&rsquo;s name and their
          Organization&rsquo;s name so it stays meaningful. A candidate deleting their profile
          removes that history with everything else. CURSUS also keeps the fact that a deletion
          happened. The Privacy Policy states the basis and the period.
        </li>
      </ul>
      <p>
        A recruiter cannot delete a candidate&rsquo;s account. Erasing an account is the account
        holder&rsquo;s decision and is available only from their own settings; there was a recruiter
        route that could do it and it has been removed.
      </p>
      <p>
        Sections 7, 18 and 19 survive termination, and so do the records described above.
      </p>

      <h2>16. Service Changes and Availability</h2>
      <p>
        CURSUS is an evolving product. We may add, modify or discontinue features, integrations,
        ranking methods or usage limits. We do not guarantee uninterrupted or error-free availability.
        We may perform maintenance, impose reasonable rate limits or temporarily disable functionality
        to protect security, integrity or legal compliance.
      </p>
      <p>
        If a change materially reduces a paid service you already purchased, we will use commercially
        reasonable efforts to provide notice and an appropriate remedy where required by law.
      </p>

      <h2>17. Disclaimers</h2>
      <p className="legal-caps">
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND
        &ldquo;AS AVAILABLE.&rdquo; CURSUS DISCLAIMS IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS
        FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY AND RESULTS.
      </p>
      <p className="legal-caps">
        CURSUS DOES NOT WARRANT THE ACCURACY OF CVs, CANDIDATE REPRESENTATIONS, RECRUITER IDENTITIES,
        JOB DESCRIPTIONS, MATCH SCORES, AI-GENERATED OR AI-ASSISTED OUTPUTS, EMPLOYMENT ELIGIBILITY,
        BACKGROUND INFORMATION OR THE CONDUCT OF USERS. USERS MUST PERFORM THEIR OWN DUE DILIGENCE.
      </p>

      <h2>18. Limitation of Liability</h2>
      <p className="legal-caps">
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, CURSUS AND ITS AFFILIATES, OFFICERS, EMPLOYEES AND
        SERVICE PROVIDERS WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE OR
        CONSEQUENTIAL DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOSS OF OPPORTUNITY, LOSS OF DATA OR
        BUSINESS INTERRUPTION, ARISING OUT OF OR RELATED TO THE SERVICE.
      </p>
      <p className="legal-caps">
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, CURSUS&rsquo;S TOTAL AGGREGATE LIABILITY ARISING OUT
        OF OR RELATING TO THE SERVICE OR THESE TERMS WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS
        YOU OR YOUR ORGANIZATION PAID TO CURSUS DURING THE 12 MONTHS BEFORE THE EVENT GIVING RISE TO
        THE CLAIM OR (B) USD 100.
      </p>
      <p>
        Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or
        limited, including liability for fraud, willful misconduct or other liability protected by
        mandatory law.
      </p>

      <h2>19. Indemnity</h2>
      <p>
        To the extent permitted by law, recruiter users and Organizations agree to indemnify and hold
        CURSUS harmless from third-party claims, losses, damages and reasonable costs arising from
        their unlawful use of candidate data, discriminatory or unlawful hiring practices, violation
        of these Terms, infringement of third-party rights or User Content they submit. This
        obligation does not apply to the extent a claim results from CURSUS&rsquo;s own unlawful
        conduct.
      </p>

      <h2>20. Changes to These Terms</h2>
      <p>
        We may update these Terms as the Service or law changes. We will post the updated version and
        revise the &ldquo;Last updated&rdquo; date. If a change materially affects your rights or
        ongoing paid use, we will provide additional notice where required by law. Continued use after
        the effective date of an update constitutes acceptance where legally permitted.
      </p>

      <h2>21. Governing Law and Disputes</h2>
      <p>
        Unless mandatory law requires otherwise, these Terms are governed by the laws of the State of
        Israel, without regard to conflict-of-law rules. Subject to any non-waivable rights or
        jurisdictional requirements, the competent courts located in Tel Aviv-Jaffa, Israel will have
        exclusive jurisdiction over disputes arising from these Terms or the Service.
      </p>
      <p>
        Before filing a formal claim, you agree to contact us at <Placeholder>LEGAL EMAIL</Placeholder>{' '}
        and make a good-faith effort to resolve the dispute informally for at least 30 days, unless
        urgent injunctive relief or a legal limitation period requires faster action.
      </p>

      <h2>22. General Terms</h2>
      <p>
        If any provision is found unenforceable, the remaining provisions remain in effect and the
        unenforceable provision will be modified only to the minimum extent necessary. Our failure to
        enforce a provision is not a waiver. You may not assign these Terms without our prior written
        consent, except where mandatory law provides otherwise. CURSUS may assign these Terms in
        connection with a merger, acquisition, financing, reorganization or sale of all or
        substantially all relevant assets.
      </p>
      <p>
        CURSUS will not be responsible for delay or failure caused by events beyond its reasonable
        control, including major internet or cloud outages, cyberattacks, war, civil emergency, labor
        disruption, government action or natural disaster, except where applicable law provides
        otherwise.
      </p>
      <p>
        These Terms, together with the Privacy Policy and any purchase-specific terms presented to
        you, form the entire agreement between you and CURSUS regarding the Service and supersede
        prior agreements on the same subject.
      </p>

      <h2>23. Contact</h2>
      <address className="legal-contact">
        CURSUS / <Placeholder>LEGAL ENTITY NAME</Placeholder>
        <br />
        <Placeholder>REGISTERED ADDRESS</Placeholder>
        <br />
        General support: <Placeholder>SUPPORT EMAIL</Placeholder>
        <br />
        Legal notices: <Placeholder>LEGAL EMAIL</Placeholder>
      </address>
    </>
  )
}

function PrivacyBody() {
  return (
    <>
      <p className="legal-updated">Last updated: {UPDATED}</p>

      <aside className="legal-callout">
        <h2>Plain-language summary</h2>
        <p>
          CURSUS is a recruiter-first talent marketplace. Candidates upload one professional profile
          and CV; recruiters describe a role; CURSUS matches the two. Recruiters first see a profile
          with the identifying fields withheld, and unlock them by spending a Reveal, which then
          applies to their whole organization. Anyone can try the same search without an account, so
          real candidates appear in a public demonstration with those fields withheld too.
          Separately, CURSUS Triage reads CVs that recruiters received directly, on their behalf and
          for their role only. A good deal of what we hold about a candidate is produced by reading
          their CV rather than typed in by them. CURSUS does not make hiring decisions, and does not
          train models of its own on candidate data.
        </p>
        <p>
          One consequence outlives the account. A Reveal does not only display a CV: the recruiter
          can download that CV, and the supporting documents filed with it, onto their own
          computer, and CURSUS has no way to retrieve, expire or delete the copy they take.
          Deleting a CURSUS account removes what we hold — apart from the few records listed in
          Section 10 — and stops us serving those documents to anyone again. It cannot reach a copy
          already taken.
        </p>
      </aside>

      <p>
        This Privacy Policy explains how <Placeholder>LEGAL ENTITY NAME</Placeholder>, operating the
        CURSUS brand (&ldquo;CURSUS&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo; or &ldquo;our&rdquo;),
        collects, uses, shares and protects personal information when you use the Service. It also
        explains choices and rights that may apply to you.
      </p>

      <h2>1. Who Is Responsible for Your Data</h2>
      <p>
        For personal information CURSUS collects to operate accounts, the marketplace, matching,
        billing, security and support, <Placeholder>LEGAL ENTITY NAME</Placeholder> is the
        organization responsible for the processing (often called the &ldquo;controller&rdquo; under
        privacy laws). Contact details appear in Section 18.
      </p>
      <p>
        Recruiter organizations that receive or reveal candidate information generally determine their
        own subsequent hiring uses of that information and may therefore act as separate controllers
        or otherwise bear independent legal responsibilities. Their handling of candidate data outside
        CURSUS is governed by their own privacy practices and applicable law.
      </p>

      <h2>2. Information We Collect</h2>

      <h3>Candidate account and profile information</h3>
      <ul>
        <li>
          Identity and contact information: name, email address, phone number and authentication
          identifiers.
        </li>
        <li>
          Location and work preferences: city, relocation preference, availability, employment
          capacity, notice period and the types of roles, industries or opportunities you choose to
          indicate.
        </li>
        <li>
          Professional information: CV, professional summary, employment and education history,
          skills, languages, seniority, portfolio/website links, LinkedIn URL and other information
          contained in your professional documents.
        </li>
        <li>Optional documents: cover letters and other professional files you choose to upload.</li>
        <li>
          Visibility controls: companies you ask us to hide your profile from and whether you are open
          to all opportunities or only specified roles/industries.
        </li>
        <li>
          Activity information: whether you confirm that you are still open to opportunities, logins
          and account status.
        </li>
      </ul>

      <h3>Recruiter and organization information</h3>
      <ul>
        <li>
          Name, work contact details, job title, organization identity, organization domain and
          authentication information.
        </li>
        <li>
          Job descriptions, search criteria, role requirements, prompts or notes submitted to the
          matching system.
        </li>
        <li>
          Saved candidates, folders, candidate-profile views, Reveal activity, messaging,
          organization-seat administration and usage records.
        </li>
        <li>
          Purchase and billing records, such as credit packs purchased, transaction amounts, tax
          details and payment status. Payment card details may be processed directly by our payment
          provider rather than stored by CURSUS.
        </li>
      </ul>

      <h3>Information we derive about candidates</h3>
      <p>
        A substantial part of what CURSUS holds about a candidate is not supplied by them: it is
        produced by reading their documents. This is personal information and the rights in Section 12
        apply to it.
      </p>
      <ul>
        <li>
          A structured reading of the CV: contact details, employment history, education, skills,
          languages, seniority and inferred years of experience in particular domains.
        </li>
        <li>
          Classification labels drawn from a fixed vocabulary — industries, functions, specialisms and
          roles — each with a confidence value and the passage of the CV that supports it.
        </li>
        <li>
          A written professional summary drafted from the CV, which the candidate can edit.
        </li>
        <li>
          A numerical representation (an &ldquo;embedding&rdquo;) of the profile text, used to compare
          it with job descriptions by meaning rather than by keyword.
        </li>
        <li>
          A retained assessment of the candidate against each role they have been scored for, which
          may contain machine-written commentary and quoted extracts from their CV. These are cached
          and re-shown to the recruiter rather than recomputed.
        </li>
      </ul>
      <p>
        Where a candidate replaces their CV, earlier readings of previous versions may be retained
        alongside the current one. Section 10 covers retention.
      </p>

      <h3>Information about people who are not CURSUS users</h3>
      <p>
        Two features cause CURSUS to hold information about people who never created an account and
        may not know the Service exists.
      </p>
      <ul>
        <li>
          <strong>CURSUS Triage.</strong> A recruiter uploads CVs of people who applied to them
          directly. CURSUS stores those documents, the text read from them, and the name, email
          address, telephone number and city found in them, for as long as the recruiter keeps the
          Triage workspace. The recruiter is the controller of this information; CURSUS processes it
          on their instructions. See Section 7A.
        </li>
        <li>
          <strong>Documents that name other people.</strong> A cover letter or a letter of
          recommendation a candidate uploads routinely names a referee or a former manager and
          sometimes gives their contact details. That text is read and used in the same way as the
          rest of the document.
        </li>
      </ul>

      <h3>Technical and usage information</h3>
      <ul>
        <li>
          Device, browser, IP address, timestamps, log data, pages/features used, referral
          information, cookie identifiers and security events.
        </li>
        <li>
          A one-way fingerprint of a visitor&rsquo;s IP address and browser user-agent, stored
          against each use of the public demonstration so that its limits can be enforced across
          restarts. The address itself is not stored and the fingerprint cannot be reversed into one.
        </li>
        <li>
          A first-party record of product events — an account created, a search run, a candidate
          revealed, a document read — identified by the internal account number rather than by name.
        </li>
        <li>
          A record of which recruiter, at which organization, opened which candidate profile and
          downloaded which document, with the date and time. The recruiter&rsquo;s name and the
          organization&rsquo;s name are stored alongside it so the record remains meaningful after
          the recruiter account is closed.
        </li>
        <li>Support requests, feedback and communications with us.</li>
      </ul>
      <p>
        We do not intentionally ask candidates to provide sensitive personal information that is
        unnecessary for professional matching. Please avoid including national ID numbers, financial
        account data, medical information or other highly sensitive details in CVs or uploaded
        documents unless necessary and lawful.
      </p>

      <h2>3. Where Information Comes From</h2>
      <ul>
        <li>
          Directly from you when you register, upload documents, set preferences, search, purchase
          credits, send messages or contact support.
        </li>
        <li>
          From files you provide, including information extracted or structured from a CV, cover
          letter or job description.
        </li>
        <li>
          From a visitor of the public demonstration, where they paste a job description or upload
          CVs of their own applicants.
        </li>
        <li>
          From your organization, such as when an administrator creates or manages a recruiter seat.
        </li>
        <li>Automatically from your browser, device and use of the Service.</li>
        <li>
          From fraud-prevention, security, payment and other service providers where reasonably
          necessary to operate the Service.
        </li>
      </ul>

      <h2>4. How We Use Personal Information</h2>
      <p>We use personal information to:</p>
      <ul>
        <li>Create, authenticate and administer Candidate, Recruiter and Organization Accounts.</li>
        <li>Parse and structure professional documents and build candidate profiles.</li>
        <li>
          Compare candidate experience, skills and preferences with recruiter-provided role
          requirements, generate match scores and rank potentially relevant candidates.
        </li>
        <li>
          Display candidate profiles to authorized recruiter users in accordance with visibility
          settings and the Reveal model.
        </li>
        <li>
          Enable recruiter-candidate messaging, operational notifications and, where enabled,
          candidate-facing transparency about which recruiter viewed a profile.
        </li>
        <li>
          Maintain candidate activity status and hide inactive profiles from discovery until
          reactivation.
        </li>
        <li>
          Process purchases, maintain Reveal Credit balances, prevent duplicate charges and keep
          financial records.
        </li>
        <li>Provide customer support, troubleshoot problems and respond to requests.</li>
        <li>
          Detect low-quality or incomplete profiles, spam, fraud, fake accounts, scraping, abuse and
          security threats.
        </li>
        <li>
          Analyze and improve product performance, ranking quality, user experience and marketplace
          health.
        </li>
        <li>
          Comply with legal obligations, enforce agreements and establish, exercise or defend legal
          claims.
        </li>
      </ul>

      <h2>5. Legal Bases Where GDPR/UK GDPR Applies</h2>
      <p>
        Where European Economic Area or United Kingdom data-protection law applies, we rely on one or
        more lawful bases depending on the processing. The table below summarizes the principal bases
        expected for the Service.
      </p>
      {/* Wrapped so the table scrolls inside its own box on a phone rather than
          pushing the whole policy sideways. */}
      <div className="legal-table-wrap">
        <table className="legal-table">
          <thead>
            <tr>
              <th scope="col">Purpose</th>
              <th scope="col">Typical lawful basis</th>
              <th scope="col">Examples</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Provide the Service</td>
              <td>Contract</td>
              <td>
                Account creation, authentication, candidate profile operation, matching requested by
                users, messaging, Reveal-credit administration.
              </td>
            </tr>
            <tr>
              <td>Security and marketplace integrity</td>
              <td>Legitimate interests; legal obligation where applicable</td>
              <td>
                Fraud prevention, abuse detection, account verification, security logging, enforcing
                rules.
              </td>
            </tr>
            <tr>
              <td>Improve product and matching quality</td>
              <td>Legitimate interests</td>
              <td>
                Analytics, testing, quality assurance, de-identified/aggregated insights and system
                improvement, balanced against user rights.
              </td>
            </tr>
            <tr>
              <td>Payments, tax and legal compliance</td>
              <td>Contract; legal obligation</td>
              <td>
                Processing purchases, maintaining invoices/records, responding to lawful requests and
                legal claims.
              </td>
            </tr>
            <tr>
              <td>Processing applications on a recruiter&rsquo;s behalf (Triage)</td>
              <td>Processor acting on the Organization&rsquo;s instructions; the Organization
                identifies its own basis</td>
              <td>Reading and ranking CVs the Organization uploaded, and nothing else.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>6. Matching, Profiling and Automated Processing</h2>
      <p>
        CURSUS uses automated systems, including AI-assisted tools, to parse professional documents,
        identify attributes relevant to work, compare candidate profiles with role requirements,
        detect incomplete or suspicious records and produce ranking or relevance scores.
      </p>
      <p>
        CURSUS does not make hiring decisions. Recruiters and employers decide whether to view,
        contact, interview, reject, hire or otherwise progress a candidate, and CURSUS does not make a
        final employment decision on anyone&rsquo;s behalf.
      </p>

      <h3>Automated processing does more than order results</h3>
      <p>
        It is important to be precise about this, because &ldquo;affects the order&rdquo; would
        understate it. Two things happen automatically before a recruiter sees anything:
      </p>
      <ul>
        <li>
          <strong>Exclusion.</strong> Candidates are removed from a search result entirely, before any
          scoring and before any person sees them. The grounds are: the candidate has blocked that
          employer, using the control on their own account described in Section 12; the candidate has
          hidden their profile or answered that they are not looking; the candidate&rsquo;s stated
          preferences do not permit the kind of role in question; and requirements read out of the
          job description by an automated reading of it. The first of these is re-applied whenever a
          stored search is reopened or extended, so a block added today reaches a search that was run
          last week.
        </li>
        <li>
          <strong>Ranking.</strong> Remaining candidates are scored and ordered. The score shown to a
          recruiter is <em>relative to the other candidates in that particular search</em>: it is a
          position in a list, not an assessment of the person, and the same candidate can show a
          different number in a different search, or when more candidates are added to the same one.
        </li>
      </ul>
      <p>
        Candidates are not shown their own scores, the commentary written about them, or which
        searches they were excluded from. A candidate who wants to know how they have been assessed
        can ask, using Section 18.
      </p>

      <h3>Human involvement</h3>
      <p>
        Matching, scoring and exclusion run without human review. A person at CURSUS reviews these
        outputs only where a user raises a specific complaint, where abuse is being investigated, or
        where a candidate exercises a right that requires it. Where applicable law gives you the right
        to obtain human intervention in, or to contest, an automated decision, contact us using
        Section 18 and a person will review it.
      </p>

      <h3>Model training</h3>
      <p>
        CURSUS does not train any model of its own on candidate CVs, cover letters or profile
        information, and does not sell or license that content to anyone for training. Where content
        is sent to the AI providers named in Section 8, CURSUS relies on those providers&rsquo;
        contractual commitments not to train their general-purpose models on data submitted through
        their business interfaces. That is a contractual position rather than a technical control
        CURSUS applies to each request.
      </p>
      <p>
        Automated systems can make mistakes, and the automated readings of a CV described in Section 2
        can be wrong. Candidates can correct their profile, their summary and their classification
        labels from their account, and the correction is what the matching then uses.
      </p>

      <h2>7. How Candidate Profiles Are Shown to Recruiters</h2>
      <p>
        When a candidate chooses to participate in the marketplace, CURSUS makes relevant
        professional information discoverable to recruiter users, and — in the public demonstration
        described in Section 7B — to visitors with no account. Recruiters first see a limited profile
        with identifying fields withheld, and unlock the rest through a Reveal.
      </p>
      <p>
        Until a Reveal, the surname, email address, telephone number, links, photograph, document
        filenames and the documents themselves are withheld. The first name, city, current and desired
        role, seniority, availability, capacity, notice period, relocation preference, skills and a
        summary of the CV are shown. Candidates should treat this as withholding rather than
        anonymity: a first name with a city and a career summary can identify somebody to a person who
        already knows them.
      </p>
      <p>
        A Reveal unlocks the withheld fields for the whole recruiter Organization, at no further
        charge to any colleague, including people who join it later, and for as long as the profile
        remains on the Service. Recruiters are
        contractually restricted to legitimate hiring uses.
      </p>
      <p>
        A Reveal releases the documents themselves, not only a view of them. A recruiter who has
        revealed a candidate can open the CV and the supporting documents filed with it, and save
        the complete original to their own computer, and so can each of their colleagues at that
        Organization. CURSUS applies no watermark, no expiry and no view-only mode to those files.
        Blocking the Organization or deleting the account stops CURSUS serving them again, and
        neither reaches a copy that has already been saved; from that point the copy is held under
        the Organization&rsquo;s own responsibilities as a separate controller, described in
        Section 1, and under the recruiter rules in the Terms.
      </p>
      <p>
        Where profile-view transparency is enabled, CURSUS may show a candidate that a recruiter
        viewed the candidate&rsquo;s profile, including the recruiter&rsquo;s name, organization and
        the date/time of the view. Recruiters are informed of this transparency through these Terms
        and this Policy.
      </p>
      <p>
        Candidates may use company-block settings to hide their profiles from named companies. We use
        reasonable efforts to enforce these settings using the organization identities available to
        us, but aliases, affiliates, newly created accounts or identity misrepresentation may limit
        perfect enforcement.
      </p>

      <h2>7A. CURSUS Triage: Data About People Who Did Not Sign Up</h2>
      <p>
        In Triage, a recruiter uploads CVs of people who applied to them directly. Those people have
        no CURSUS account and, unless their prospective employer tells them, no way of knowing that
        CURSUS holds their application.
      </p>
      <ul>
        <li>
          <strong>Who is responsible.</strong> The recruiter&rsquo;s Organization is the controller.
          CURSUS is a processor acting on its instructions and has no independent purpose for the
          data. It is not added to the candidate marketplace, is not used to fill other roles, and is
          not used to train any model.
        </li>
        <li>
          <strong>What is held.</strong> The uploaded document, the text read from it, and the name,
          email address, telephone number and city found in it, together with the ranking and any
          written analysis produced for that role.
        </li>
        <li>
          <strong>Where it goes.</strong> The document text is sent to the AI providers named in
          Section 8 in the same way as a candidate&rsquo;s CV, and therefore leaves the country in
          which it was uploaded.
        </li>
        <li>
          <strong>How long.</strong> For as long as the Organization keeps the Triage workspace.
          Deleting the workspace deletes the documents and the files themselves.
        </li>
        <li>
          <strong>Notice and rights.</strong> The obligation to tell applicants that their application
          will be processed this way rests with the Organization that received it. An applicant who
          believes CURSUS holds their CV may contact us using Section 18; we will identify the
          Organization concerned, pass the request to it, and act on its instruction, and we will
          respond directly where the law requires us to.
        </li>
      </ul>

      <h2>7B. The Public Demonstration</h2>
      <p>
        Anyone can use the Live Demo without an account. It runs the real system, not a simulation.
      </p>
      <ul>
        <li>
          <strong>The demonstration search</strong> matches a pasted job description against the live
          candidate marketplace and shows real candidates with identifying fields withheld, as in
          Section 7, and with fewer fields than a signed-in recruiter sees. No Reveal can be spent, no
          contact details or documents are disclosed, and the visit is not recorded against the
          candidate&rsquo;s profile, so a candidate is not told when they have appeared in one.
          A candidate who has blocked any company at all does not appear in the demonstration at
          all. A block names a company, and an anonymous visitor has no company; they could be
          from the one that was blocked. Withholding the person from the whole demonstration is the
          only reading of &ldquo;hide me from these companies&rdquo; that holds on a surface where
          the viewer is unknown.
        </li>
        <li>
          <strong>The demonstration of Triage</strong> accepts a limited number of CVs from the
          visitor. They are read to produce a ranking and deleted in the course of answering the
          request. No copy is kept, no profile is created, and nothing from them enters the
          marketplace.
        </li>
        <li>
          <strong>What is kept.</strong> A record that a demonstration ran, carrying the one-way
          device fingerprint described in Section 2 and the time, so the limits can be enforced. For a
          demonstration search, the job description the visitor pasted and the resulting ranking are
          also kept, so that the search can be restored if the visitor goes on to create an account.
        </li>
      </ul>
      <p>
        A candidate who would rather not appear in the demonstration can hide their profile from
        search, or name any company on the hidden-companies list described in Section 12, either of
        which takes them out of it.
      </p>

      <h2>8. When We Share Personal Information</h2>

      <h3>Recruiters and organizations</h3>
      <p>
        Candidate professional information is shared with recruiter users as part of the core
        marketplace function and according to profile visibility, matching and Reveal settings.
        Recruiter information may be shown to candidates when a recruiter contacts them and, where
        profile-view transparency is enabled, when the recruiter views the candidate&rsquo;s profile.
        This may include the recruiter&rsquo;s name, organization and view date/time. Sharing a
        revealed candidate with a recruiter is not a loan: Section 7 describes what the recruiter
        may then download and keep, and Section 10 what a later deletion can and cannot reach.
      </p>

      <h3>Sub-processors</h3>
      <p>
        CURSUS uses few third parties, and names them rather than describing categories.
      </p>
      <ul>
        <li>
          <strong>Anthropic</strong> (United States). Reads CVs and other uploaded documents to
          produce the structured profile, the professional summary and the written match analysis.
          What is sent includes the text of the document itself, not merely attributes drawn from it.
        </li>
        <li>
          <strong>Voyage AI</strong> (United States). Produces the numerical representation of a
          profile and of a job description used for meaning-based matching. What is sent includes
          profile text and an extract of the CV.
        </li>
        <li>
          <strong>Hosting.</strong> The application, the database and uploaded files are held by our
          hosting provider.
        </li>
      </ul>
      <p>
        Document parsing, matching, scoring, product analytics and search all run on CURSUS&rsquo;s
        own systems. There is no third-party analytics service, advertising network, error-reporting
        service or content delivery network in the product, and the pages you use make no requests to
        any third party.
      </p>
      <p>
        Where the AI providers above are not configured, the Service falls back to processing that
        runs entirely on CURSUS systems and nothing is sent to them. We will keep this list current
        and give notice before adding a sub-processor that receives candidate content.
      </p>

      <h3>Corporate transactions</h3>
      <p>
        Information may be disclosed as part of a financing, merger, acquisition, reorganization,
        asset sale or similar transaction, subject to appropriate confidentiality and legal
        protections.
      </p>

      <h3>Legal and safety reasons</h3>
      <p>
        We may disclose information when reasonably necessary to comply with law, legal process or
        regulatory requests; enforce our Terms; protect the rights, safety or security of users,
        CURSUS or others; investigate fraud or abuse; or establish, exercise or defend legal claims.
      </p>

      <h3>With your direction or consent</h3>
      <p>
        We may share information in other circumstances when you ask us to do so or give valid
        consent.
      </p>

      <h2>9. International Data Transfers</h2>
      <p>
        CURSUS may use infrastructure and service providers located in Israel, the European Economic
        Area, the United Kingdom, the United States and other countries. Your information may
        therefore be processed outside the country where you live.
      </p>
      <p>
        Specifically: where the AI features are enabled, document text is transferred to Anthropic and
        to Voyage AI, both in the United States, as described in Section 8. This includes the text of
        candidate CVs and of CVs uploaded to Triage. Where those providers are not configured, the
        Service processes documents on its own systems and no such transfer takes place.
      </p>
      <p>
        Where cross-border transfer rules apply, we will use legally recognized safeguards as
        required, which may include adequacy decisions, contractual protections or other permitted
        transfer mechanisms. Additional rules may apply to personal data transferred into Israel from
        the European Economic Area.
      </p>

      <h2>10. Data Retention</h2>
      <p>
        We keep personal information only for as long as reasonably necessary for the purposes
        described in this Policy, including to operate active accounts, provide marketplace
        functionality, maintain transaction records, resolve disputes, enforce agreements, prevent
        abuse and satisfy legal obligations.
      </p>
      <ul>
        <li>
          Candidate profiles: kept while the account exists. A profile that stops confirming activity
          is labelled rather than hidden; one the candidate hides or deactivates is removed from
          discovery but not deleted.
        </li>
        <li>
          Deleted candidate accounts: deletion is immediate and thorough. The profile, the uploaded
          files, everything derived from them, the message history, the check-in history, and the
          notes, tags and shortlist entries recruiters wrote about the candidate are all removed at
          once, and it reaches everything CURSUS holds and controls. See the exceptions below, and
          &ldquo;What a deletion cannot reach&rdquo; for what it does not.
        </li>
        <li>
          Triage applicant data: kept for as long as the recruiter Organization keeps the Triage
          workspace, and deleted with it, files included.
        </li>
        <li>
          Previously revealed candidate data held by recruiters: recruiter organizations may be
          separate controllers. CURSUS requires recruiters to retain candidate information only while
          reasonably necessary for legitimate recruitment and to delete or anonymize it when no longer
          needed, subject to any independent lawful basis, active recruitment need or legal retention
          obligation. That is a requirement CURSUS places on them, not a control it operates: a
          document already downloaded to a recruiter&rsquo;s computer sits outside our systems, and
          we can neither carry out its deletion nor confirm that the Organization has.
        </li>
        <li>
          Recruiter purchases and financial records: retained for the period required by tax,
          accounting and other applicable law.
        </li>
        <li>
          Security logs and abuse records: retained for periods proportionate to security and
          fraud-prevention needs.
        </li>
      </ul>

      <h3>What a deletion cannot reach</h3>
      <p>
        Everything listed in this section is a record CURSUS holds. One thing sits outside that
        description altogether, and it is why deletion is a forward-looking promise rather than an
        absolute one. A recruiter who spent a Reveal before the deletion may have downloaded the CV
        and the other documents to their own computer. That file is an ordinary copy on somebody
        else&rsquo;s equipment: CURSUS cannot see it, cannot expire it and cannot delete it, and no
        setting in the product ever could.
      </p>
      <p>
        Deleting the account therefore does two things, completely, and then stops. It removes what
        CURSUS holds, apart from the records listed below, and it ends every future disclosure. From
        that moment no recruiter and no Organization can open the profile, the documents, the
        message history or anything derived from them, whether or not they paid to reveal the
        candidate. What it does not do — because nothing could — is retrieve a copy already taken.
      </p>
      <p>
        A second copy can sit beyond a deletion in the same way. Where a recruiter had separately
        uploaded the same person&rsquo;s CV into a Triage workspace, the Organization is its
        controller under Section 7A, the document carries no link to the CURSUS account, and closing
        that account does not reach it. Section 7A sets out how long it is kept and how an applicant
        can ask about it.
      </p>

      <h3>What survives a deletion</h3>
      <p>
        Some records are deliberately kept after an account is closed. They are listed here rather
        than covered by a general exception.
      </p>
      <ul>
        <li>
          <strong>Billing ledger entries.</strong> The Organization&rsquo;s financial record of what
          it bought and spent. A line recording a Reveal continues to reference the internal
          identifier of the candidate it was spent on, so that the Organization&rsquo;s accounts can be
          reconciled. Retained for the period tax and accounting law requires.
        </li>
        <li>
          <strong>Access history.</strong> When a recruiter account is closed, the record of which
          recruiter, at which organization, opened which profile and downloaded which document is
          kept. The recruiter&rsquo;s name and the organization&rsquo;s name are stored on the record
          itself so that it remains meaningful afterwards; closing a recruiter account does not
          remove their name from profiles they opened. A candidate deleting their profile removes
          this history along with everything else.
        </li>
        <li>
          <strong>Reveal records.</strong> When a recruiter account is closed, the Organization&rsquo;s
          record that it revealed a candidate is kept — otherwise colleagues would lose access to
          candidates the Organization paid for — with the departed recruiter&rsquo;s name removed.
        </li>
        <li>
          <strong>The record that a deletion happened</strong>, and only that. The
          first-party product events described in Section 2 are deleted with the account. The single
          exception is the entry recording that an erasure was carried out: the account number is
          removed from it and the details it carried are replaced, leaving the fact and the date. It
          is what allows us to show that a request was honoured, and it no longer says whose it was.
        </li>
        <li>
          <strong>Public demonstration records.</strong> The throttling records described in
          Section 7B, and the job description and ranking from a demonstration search.
        </li>
      </ul>
      <p>
        Internal account numbers are never reissued, so records that reference one remain linkable to
        the closed account. Where you want a record in this list removed and believe the law requires
        it, contact us using Section 18.
      </p>
      <p>
        Some of these periods are now set and enforced automatically: a sign-in code is deleted 24
        hours after it is issued, an enquiry sent through the contact form is deleted after two
        years, and the records left by an unclaimed public demonstration are deleted after seven
        days. CURSUS is still setting maximum periods for the remaining operational categories above,
        several of which are currently kept for as long as the Service runs. Publishing those periods
        is a launch requirement; see the Implementation Checklist.
      </p>

      <h2>11. Security</h2>
      <p>
        We use administrative, technical and organizational measures intended to protect personal
        information against unauthorized access, alteration, disclosure, loss or destruction. Measures
        may include access controls, authentication, logging, encryption in transit and at rest where
        appropriate, vulnerability management, backups, vendor controls and incident-response
        procedures.
      </p>
      <p>
        No system is completely secure. Users are responsible for protecting account credentials and
        reporting suspected compromise promptly. CURSUS maintains incident-response procedures and
        will assess, contain and document personal-data security incidents. We will notify the Israeli
        Privacy Protection Authority, affected users, recruiter organizations or other parties when
        and to the extent required by applicable law or binding contractual obligations.
      </p>

      <h2>12. Your Choices and Rights</h2>
      <p>
        Depending on where you live and which law applies, you may have rights to access or review
        personal information, request correction, request deletion, restrict or object to certain
        processing, withdraw consent, receive portable data, object to direct marketing, and complain
        to a competent data-protection authority.
      </p>
      <p>
        Israeli privacy law provides rights in relation to personal information held in databases,
        including rights of access and, in relevant circumstances, correction or deletion. EEA and UK
        users may have additional rights under the GDPR or UK GDPR.
      </p>
      <p>
        You can also manage certain choices directly in CURSUS. Your account page carries three of
        them: whether your profile is visible to recruiters at all, what kinds of opportunity you are
        open to, and &ldquo;Hide my profile from these companies&rdquo; &mdash; a list of company
        names, as many as you need, that you can add to and remove from at any time. Naming a company
        there takes effect immediately and across the whole Service; Sections 6 and 7B describe what
        it reaches. To exercise a legal right that is not available in-product,
        contact <Placeholder>PRIVACY EMAIL</Placeholder>. We may need to verify your identity before
        fulfilling a request and may retain limited records of the request itself. We aim to respond
        to verified privacy-rights requests within 30 days, unless applicable law permits or requires
        a different period.
      </p>
      <p>
        Some rights are subject to exceptions. For example, we may need to retain transaction records
        or information necessary for legal claims, fraud prevention or security even after an account
        is deleted.
      </p>
      <p>
        A further limit is not a retention decision of ours at all. Where a recruiter downloaded a
        candidate&rsquo;s CV or documents before the request, that copy is on their equipment and
        beyond our reach; we can stop serving the files, and we do, but we cannot delete a copy we
        never held. Section 10 explains this under &ldquo;What a deletion cannot reach&rdquo;.
      </p>
      <p>
        What a candidate can do about such a copy is ask the Organization holding it directly. The
        recruiter rules in the Terms require Organizations to delete or anonymize candidate
        information once it is no longer needed for the role they held it for, and a candidate may
        hold them to that. Worth knowing before rather than after: the account page names the
        Organizations that have revealed the profile, and that record is deleted with the account,
        so a candidate who wants to approach them later should note them down first. CURSUS does
        not notify Organizations that an account has been deleted.
      </p>

      <h2>13. Operational Communications and Future Marketing</h2>
      <p>
        At launch, CURSUS uses email, SMS or in-app communications for operational and transactional
        purposes such as authentication, security, account status, recruiter-candidate activity,
        support and billing. These communications are part of operating the Service and are not
        promotional advertising.
      </p>
      <p>
        CURSUS does not currently send promotional advertising by email or SMS. If we later introduce
        promotional email or SMS, we will update our practices as appropriate, obtain prior consent
        where required by applicable law and provide an effective method to withdraw consent or
        unsubscribe.
      </p>
      <p>
        We do not permit recruiter users to use candidate contact data obtained through CURSUS for
        unrelated advertising, bulk marketing or data-broker activity.
      </p>

      <h2>14. Cookies and Similar Technologies</h2>
      <aside className="legal-callout">
        <h3>What CURSUS does not use</h3>
        <p>
          There are no third-party tags, tracking pixels, advertising technologies or analytics
          services in the Service, and the pages you use make no requests to any third party; the
          typefaces are served from CURSUS&rsquo;s own systems for that reason. Product analytics is a
          first-party record described in Section 2. The identifier that matters for the public
          demonstration is not a cookie at all: it is the server-side device fingerprint described in
          Section 2 and Section 7B.
        </p>
      </aside>
      <p>
        CURSUS may use cookies, local storage, pixels or similar technologies for account
        authentication, security, preferences, analytics and product performance. Strictly necessary
        technologies may operate without optional consent where law permits. Analytics or advertising
        technologies will be managed through an appropriate consent mechanism where required by law.
      </p>
      <p>
        Before publication, CURSUS should align this section with the actual cookie/analytics tools
        deployed and, if needed, publish a separate Cookie Notice or consent manager.
      </p>

      <h2>15. Children</h2>
      <p>
        Both account-creation forms require an affirmation that the person is 18 or over, and refuse
        to create an account without it. That affirmation is recorded with its date and the version
        of the wording shown. CURSUS does not collect dates of birth and does not verify age by any
        other means, so this is a declaration rather than a check.
      </p>
      <p>
        CURSUS is intended for adults participating in professional recruiting and is not directed to
        children. We do not knowingly create accounts for people under 18. If you believe a minor has
        provided personal information to CURSUS, contact <Placeholder>PRIVACY EMAIL</Placeholder>.
      </p>

      <h2>16. Special-Category and Sensitive Information</h2>
      <p>
        CURSUS does not need sensitive personal information such as health data, biometric
        identifiers, political opinions, religious beliefs, sexual orientation or similar
        special-category data for ordinary candidate matching. Candidates should avoid including such
        information in CVs and documents unless they choose to do so and it is appropriate and lawful.
      </p>
      <p>
        If sensitive information is incidentally contained in a submitted document, we will process it
        only as necessary to provide the Service, comply with law and protect users. Recruiters must
        not use sensitive or protected characteristics for unlawful discrimination.
      </p>

      <h2>17. Changes to This Privacy Policy</h2>
      <p>
        We may update this Policy to reflect product, legal, security or operational changes. We will
        post the revised version and update the date above. Where required, we will provide additional
        notice of material changes.
      </p>

      <h2>18. Contact and Complaints</h2>
      <p>Privacy questions and rights requests:</p>
      <address className="legal-contact">
        CURSUS / <Placeholder>LEGAL ENTITY NAME</Placeholder>
        <br />
        <Placeholder>REGISTERED ADDRESS</Placeholder>
        <br />
        Privacy contact: <Placeholder>PRIVACY EMAIL</Placeholder>
        <br />
        Data Protection Officer (if required/appointed):{' '}
        <Placeholder>DPO NAME / DPO EMAIL</Placeholder>
        <br />
        General support: <Placeholder>SUPPORT EMAIL</Placeholder>
      </address>
      <p>
        If you are in a jurisdiction with a data-protection regulator, you may also have the right to
        lodge a complaint with that authority. We encourage you to contact us first so we can try to
        resolve the issue directly.
      </p>
    </>
  )
}

/**
 * The two documents, by the key the router and the consent links use.
 *
 * `path` is here so the modal can offer a real link to the standalone page and
 * nothing has to remember the URL twice.
 */
export const LEGAL_DOCUMENTS = {
  terms: {
    title: 'Terms of Service',
    subtitle: 'For Candidates, Recruiters and Organizations',
    path: '/terms',
    Body: TermsBody,
  },
  privacy: {
    title: 'Privacy Policy',
    subtitle: 'How CURSUS Handles Candidate, Recruiter and Visitor Data',
    path: '/privacy',
    Body: PrivacyBody,
  },
}
