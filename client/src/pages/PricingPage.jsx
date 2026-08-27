import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import EyeIcon from '../components/EyeIcon.jsx'
import { get, hasSession, post, put } from '../api.js'
import { formatSeatDate } from '../dates.js'
import { StatusNotice } from '../components/Notice.jsx'

/**
 * Pricing. §4 and Appendix A.
 *
 * Two products on one page, because they are bought by the same person for the
 * same team and comparing them is the decision: how many reveals do we need,
 * and how many of us need to be here. A separate page each would hide half the
 * answer behind a second click.
 *
 * Everything shown comes from GET /api/pricing. Nothing here knows a price, so
 * repricing is a server change and this page cannot fall out of date with what
 * a purchase actually charges.
 */

/**
 * §4.2 — Reveals first. Someone arriving cold is buying reveals, not seats.
 *
 * Triage is third and last, which is also the order the products were built in
 * and the order a recruiter meets them: find people, add colleagues, then sort
 * the pile that arrived on its own.
 */
const TABS = [
  { key: 'reveals', label: 'Reveals' },
  { key: 'seats', label: 'Seats' },
  { key: 'triage', label: 'Triage' },
]

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  )
}

/**
 * One pack. A radio, not a button: the four cards are one choice with one
 * answer, and that is what a radio group is. It buys keyboard arrow-key
 * movement between them and a single tab stop for the whole set, neither of
 * which a row of buttons gets without being taught.
 */
function PackCard({ pack, kind, selected, onSelect, name }) {
  const reveal = kind === 'reveal'
  const triage = kind === 'triage'

  return (
    <label className={`pack-card${selected ? ' pack-card-on' : ''}`}>
      <input
        type="radio"
        name={name}
        className="pack-radio"
        checked={selected}
        onChange={() => onSelect(pack.key)}
      />

      {/* No mark on the quantity. The eye appeared on the reveal packs only,
          which pushed their number 24px right of where the seat and Triage
          numbers sit and made one of the three tabs read as a different card. */}
      <span className="pack-quantity">
        <strong>{pack.quantity}</strong>
        {reveal
          ? ` reveal${pack.quantity === 1 ? '' : 's'}`
          : triage
            ? ` CVs`
            : ` seat${pack.quantity === 1 ? '' : 's'}`}
      </span>

      {/* Reveals have a price; seats have a rate. Saying "₪45" for a
          subscription and "₪45" for a pack in the same typography is how the
          two products got confused for one another in the first place. */}
      <span className="pack-total">
        {reveal || triage ? pack.formattedTotal : `${pack.formattedMonthly}/mo`}
      </span>

      <span className="pack-unit">
        {reveal
          ? `${pack.formattedUnit} per reveal`
          : triage
            ? `${pack.formattedUnit} per CV`
            : `${pack.formattedUnit} per seat / month`}
      </span>

      {/* Only where there is something to say. A "0% off" badge on the entry
          pack advertises the absence of a discount. */}
      {pack.discount > 0 && (
        <span className="pack-badge">Save {Math.round(pack.discount)}%</span>
      )}

      {selected && <span className="pack-tick" aria-hidden="true"><CheckIcon /></span>}
    </label>
  )
}

export default function PricingPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()

  const [catalogue, setCatalogue] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  /*
   * Appendix A — the tab lives in the URL.
   *
   * So a link to the seat tier table lands on the seat tier table, and so the
   * sign-in detour below can send someone back to exactly the choice they were
   * making rather than to the top of the page.
   */
  const tab = TABS.some((entry) => entry.key === params.get('plan'))
    ? params.get('plan')
    : 'reveals'
  const [selected, setSelected] = useState({ reveals: null, seats: null, triage: null })

  useEffect(() => {
    get('/api/pricing')
      .then((data) => {
        setCatalogue(data)
        // Preselecting from the URL first, so a returning visitor finds their
        // choice made. Otherwise the middle pack, which is the honest default:
        // the cheapest looks like a nudge and the largest like a demand.
        const wanted = params.get('pack')
        setSelected({
          reveals: data.reveals.find((p) => p.key === wanted)?.key ?? data.reveals[1]?.key ?? null,
          seats: data.seats.find((p) => p.key === wanted)?.key ?? data.seats[0]?.key ?? null,
          /* The two-pack rather than the single: the same honest-default
             reasoning as reveals — the cheapest reads as a nudge, and a
             recruiter who has an applicant pile usually has a second role
             coming. */
          triage: data.triage.find((p) => p.key === wanted)?.key ?? data.triage[1]?.key ?? null,
        })
      })
      .catch((err) => setError(err.message))
    // Read once: the catalogue does not change while the page is open, and
    // re-running this on every URL change would fight the visitor's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function switchTab(next) {
    const updated = new URLSearchParams(params)
    updated.set('plan', next)
    updated.delete('pack')
    setParams(updated, { replace: true })
    setNotice('')
    setError('')
  }

  const packs = catalogue ? (catalogue[tab === 'reveals' ? 'reveals' : tab] ?? []) : []
  const chosen = packs.find((pack) => pack.key === selected[tab]) ?? null

  /**
   * Appendix A — one CTA, and what it does depends only on who is looking.
   *
   * Signed out it goes to the recruiter door carrying the tab and the pack, so
   * the choice survives signing in. Signed in it buys, then sends the admin to
   * their billing screen where the new balance is.
   */
  async function purchase() {
    if (!chosen) return

    if (!hasSession('recruiter')) {
      navigate(`/hr?next=pricing&plan=${tab}&pack=${chosen.key}`)
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (tab === 'seats') {
        const result = await put('/api/company/seat-plan', { seats: chosen.quantity })
        /*
         * A reduction is scheduled, not applied — the seats are paid for to the
         * end of the term and stay usable until then. Saying "your subscription
         * is now two seats" on the day somebody drops from five to two is how
         * an admin concludes three colleagues were locked out this afternoon,
         * goes looking for them, and finds them still working. The billing
         * panel already words it this way; this is the same event.
         */
        setNotice(result.plan.scheduled
          ? `Your seats stay as they are until ${formatSeatDate(result.plan.effectiveFrom)}, `
            + `then the subscription becomes ${result.plan.seats} additional `
            + `seat${result.plan.seats === 1 ? '' : 's'} at ${result.plan.monthly} a month.`
          : `Your seat subscription is ${result.plan.seats} additional `
            + `seat${result.plan.seats === 1 ? '' : 's'} at ${result.plan.monthly} a month.`)
      } else if (tab === 'triage') {
        const result = await post('/api/company/triage/purchase', { pack: chosen.key })
        setNotice(
          `${result.purchased.cvs} CVs of Triage capacity added for ${result.purchased.amount}. `
          + `Your balance is ${result.triageBalance} CVs.`,
        )
      } else {
        const result = await post('/api/company/reveals/purchase', { pack: chosen.key })
        setNotice(
          `${result.purchased.reveals} reveals added for ${result.purchased.amount}. `
          + `Your balance is now ${result.balance}.`,
        )
      }
      // Straight to the record of what just happened, rather than leaving them
      // on a sales page they have finished with.
      /* Straight to where the thing they just bought is used. Capacity is
         spent in the Triage workspace, not on the billing screen, so sending
         them to Billing would be one more click before the purchase does
         anything for them. */
      setTimeout(() => navigate(tab === 'triage' ? '/hr?tab=triage' : '/hr?tab=billing'), 1200)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (error && !catalogue) {
    return (
      <article className="panel panel-narrow info-page">
        <h1>Pricing</h1>
        <p className="alert alert-error">{error}</p>
      </article>
    )
  }

  if (!catalogue) {
    return (
      <article className="panel panel-narrow info-page">
        <h1>Pricing</h1>
        <p className="muted">Loading…</p>
      </article>
    )
  }

  return (
    <article className="panel pricing-page">
      <header className="pricing-head">
        <h1>Pricing</h1>
        <p className="pricing-lead">
          Cursus is free for candidates. Recruiters pay for three things: the
          reveals that open a candidate's contact details, the seats their colleagues sit in, and
          the Triage capacity that sorts the applicants they have already received.
        </p>

        {/*
          The same segmented control as the landing page's role switch, because
          it is the same kind of choice — two things, one of them true — and a
          second visual language for it would be a second thing to learn.
        */}
        <div className="role-switch" role="group" aria-label="What are you buying?">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={`role-option${tab === entry.key ? ' role-option-on' : ''}`}
              aria-pressed={tab === entry.key}
              onClick={() => switchTab(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      <p className="pricing-explainer">
        {tab === 'triage' ? (
          <>
            {/*
              §15.3 — Triage is a word we invented, so the page says what it
              means before it asks anybody to buy one. Three sentences, in front
              of the cards rather than under them.
            */}
            Cursus Triage helps you sort through the CVs you have already received for a role.
            Upload your job description and applicant CVs, and Cursus prioritises the full batch
            before progressively analysing and scoring candidates so you can review the strongest
            matches first. Create as many Triage workspaces as you need. You only use capacity
            for the CVs you submit for processing, and capacity never expires.
          </>
        ) : tab === 'reveals' ? (
          <>
            A reveal opens one candidate's contact details, CV and documents to your whole
            organization. A colleague opening the same person later costs nothing. Reveals never
            expire. Searching, filtering and shortlisting are always free.
          </>
        ) : (
          <>
            Your administrator account is included: {catalogue.includedSeats === 1
              ? 'one seat, and no subscription'
              : `${catalogue.includedSeats} seats, and no subscription`} until you add somebody.
            Additional seats are a monthly subscription: pick the number of colleagues you want,
            change it whenever that changes, and pay for the tier you are on. Reveals are bought
            separately and are not affected by it. A seat comes with no balance of its own, and
            buying reveals adds no seats.
          </>
        )}
      </p>

      <div
        className="pack-grid"
        role="radiogroup"
        /* Named for what is actually in it. Triage fell through to "Reveal
           packs", so the one tab whose packs are CVs announced itself as the
           other product. */
        aria-label={{ seats: 'Seat packs', triage: 'Triage packs' }[tab] ?? 'Reveal packs'}
      >
        {packs.map((pack) => (
          <PackCard
            key={pack.key}
            pack={pack}
            kind={tab === 'seats' ? 'seat' : tab === 'triage' ? 'triage' : 'reveal'}
            name={`pack-${tab}`}
            selected={selected[tab] === pack.key}
            onSelect={(key) => setSelected((was) => ({ ...was, [tab]: key }))}
          />
        ))}

        {/*
          §14.1 — above self-serve, a conversation rather than a card. Priced
          like the others it would be a guess; as a card it stays in the same
          row so a large team is not left wondering whether they are catered for.

          "Enterprise deal" rather than "More — Custom": the old label described
          the pricing mechanism, which nobody is shopping for. This names the
          thing being offered, and reads as a tier rather than as the absence of
          one.
        */}
        <Link
          className="pack-card pack-card-custom"
          to={`/contact?reason=${encodeURIComponent('Hiring on Cursus')}`}
        >
          <span className="pack-total">Enterprise deal</span>
          <span className="pack-unit">
            {tab === 'seats'
              ? `Teams over ${catalogue.seatSelfServeMax} additional seats`
              : tab === 'triage'
                ? `More than ${catalogue.triageSelfServeMax} CVs, or custom limits`
                : 'High volume hiring'}
          </span>
          <span className="pack-badge pack-badge-quiet">Contact sales</span>
        </Link>
      </div>

      <StatusNotice
        error={error}
        notice={notice}
        onDismiss={() => { setError(''); setNotice('') }}
      />

      <div className="pricing-cta">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={busy || !chosen}
          onClick={purchase}
        >
          {busy
            ? 'Working…'
            : !chosen
              ? (tab === 'seats' ? 'Subscribe' : 'Purchase')
              : tab === 'seats'
                ? 'Subscribe'
                : 'Purchase'}
        </button>

        {catalogue?.simulated && (
          <p className="alert alert-warn">
            No payment provider is connected yet, so purchases are recorded but nothing is charged.
          </p>
        )}

        <p className="muted pricing-fine">
          {!hasSession('recruiter')
            ? 'You will be asked to sign in or create a recruiter account first.'
            : tab === 'seats'
              ? 'Billed monthly. Change or cancel the subscription whenever your team changes.'
              : tab === 'triage'
                ? 'Charged once. Capacity is added to your organization immediately and never expires.'
                : 'Charged once. Reveals are added to your organization balance immediately.'}
        </p>
      </div>

      <section className="pricing-notes">
        <h2>What every organization gets</h2>
        <ul className="pricing-list">
          <li>
            <span>
              <strong>{catalogue.complimentaryReveals} complimentary reveals</strong> when you
              create an account, enough to judge the candidates before you pay for any.
            </span>
          </li>
          {/*
            Second, beside the free reveals rather than further down.
            
            The two free allowances are the "try both products before paying"
            pair and belong together: reveals prove the marketplace, and free
            Triage proves the same scoring against CVs the recruiter already
            has an opinion about — which is the faster of the two to believe.
            It also lands before the bullet explaining how the two currencies
            are accounted for, so the reader meets Triage before meeting its
            accounting.
          */}
          <li>
            <span>
              <strong>{catalogue.complimentaryTriageCvs} CVs of Triage capacity, free</strong>:
              upload a job description and the applications you already have, and see them scored
              and ranked before spending anything.
            </span>
          </li>
          <li>
            <span>
              <strong>
                {catalogue.includedSeats === 1
                  ? 'Your own seat'
                  : `${catalogue.includedSeats} recruiter seats`}
              </strong>{' '}
              included, with no monthly charge. Add colleagues on monthly seats whenever you need
              them.
            </span>
          </li>
          <li>
            <span>
              <strong>Unlimited searching, filtering and shortlisting.</strong> You only ever pay
              to open someone's details.
            </span>
          </li>
          <li>
            <span>
              <strong>One shared balance.</strong> Reveals belong to the organization, not to the
              person who bought them, and a candidate one colleague opened is open to everyone.
            </span>
          </li>
          <li>
            <span>
              {/*
                §7 of the Triage brief — the distinction between the two
                currencies has to be unambiguous, and the place a recruiter is
                most likely to conflate them is the page that sells both.
              */}
              <strong>Reveals and Triage capacity are separate.</strong> A reveal opens one
              candidate from the Cursus marketplace; Triage capacity processes a CV you already
              have. Buying one never spends or adds the other.
            </span>
          </li>
        </ul>

        <p className="muted">
          Buying for a larger team, or need an invoice? <Link to="/contact">Talk to us</Link>.
        </p>
      </section>
    </article>
  )
}
