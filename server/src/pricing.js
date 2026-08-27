/**
 * Every commercial number in the product, in one place.
 *
 * §3 and §14.2 both say the same thing: the values below are provisional and
 * must not be hard-coded through the application. Nothing else in the codebase
 * may state a pack size, a price, a discount, a grant or a threshold — it asks
 * here. That is what lets CURSUS reprice, run an A/B test on the onboarding
 * grant, or add a market without a code change beyond this file.
 *
 * Money is held in minor units (agorot) as integers everywhere, because prices
 * in a float lose precision on exactly the arithmetic an invoice depends on.
 */

const asInt = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

export const CURRENCY = process.env.BILLING_CURRENCY ?? 'ILS'

/**
 * §6 — the complimentary grant, once per organization.
 *
 * Ten rather than two or three: a token trial that runs out before a recruiter
 * has tested candidate quality teaches them nothing about the product. Ten
 * rather than twenty-five: twenty-five is the whole smallest pack, so it would
 * let an organization work for a long time before ever meeting the commercial
 * model.
 */
export const COMPLIMENTARY_REVEALS = asInt(process.env.COMPLIMENTARY_REVEALS, 10)

/*
 * The same welcome, for the other product.
 *
 * A new organization gets a Triage allowance as well as a reveal balance,
 * because the two answer different questions and an organization that has only
 * tried one has only seen half of what it is being asked to pay for. Triage is
 * also the faster proof: it runs against the CVs the recruiter already has and
 * already has an opinion about, so the scoring can be checked against their own
 * judgement rather than taken on trust.
 *
 * Counted in CVs, like every other Triage number — never in sessions. A hundred
 * is one real applicant pile, which is the smallest quantity that demonstrates
 * anything; ten would only ever prove that the button works.
 */
export const COMPLIMENTARY_TRIAGE_CVS = asInt(process.env.COMPLIMENTARY_TRIAGE_CVS, 100)

/**
 * §14.1 — what every organization gets without paying: the administrator's own
 * seat, and nothing else. Purchased seats are added on top of it.
 *
 * One rather than five. Five made the seat product invisible to every
 * organization that never grew past a handful of people — they would never meet
 * it, and the ones who did met it as a wall rather than as something they had
 * already understood. At one, the second hire is the moment seats are explained,
 * which is the moment somebody is actually deciding about them.
 */
export const INCLUDED_SEATS = asInt(process.env.INCLUDED_SEATS, 1)

/*
 * There are no low-balance thresholds.
 *
 * LOW_BALANCE_THRESHOLDS lived here, defaulting to 10 and 5, and decided where
 * the UI began warning that a balance was running down. Nothing warns on the
 * way down any more: a banner that appears at "getting low" is on screen for
 * most of a balance's life, and by the time it means something nobody reads it.
 * The one warning left fires at zero, which needs no threshold to describe.
 */

/**
 * §3 — Reveal Packs.
 *
 * `total` is authoritative; the per-unit price and the discount are derived for
 * display so a rounded unit price can never disagree with what is charged.
 */
export const REVEAL_PACKS = [
  { key: 'reveals_25', reveals: 25, total: 2500 },
  { key: 'reveals_50', reveals: 50, total: 4500 },
  { key: 'reveals_75', reveals: 75, total: 6500 },
  { key: 'reveals_100', reveals: 100, total: 8000 },
]

/**
 * Seats, as a recurring monthly subscription.
 *
 * Not a purchase. An organization subscribes to a number of ADDITIONAL seats —
 * the administrator's own is included and never counted here — and pays that
 * tier every month for as long as it holds it. Changing the number changes the
 * subscription; it is not a second transaction added to a first, and there is
 * no true-up, because nothing is being owned.
 *
 * The whole tier is priced, not the step: three seats is ₪60/month, whatever
 * the organization was on before. That is what makes a downgrade expressible —
 * under the old owning model a smaller number was simply meaningless.
 *
 * Per-seat cost falls as the count rises while the monthly total climbs, which
 * is the intended shape: volume is rewarded without the organization ever
 * paying less in total for more people.
 *
 * Prices are provisional. Everything downstream reads this table and the two
 * helpers below, so retuning a tier is an edit here and nothing else.
 */
export const SEAT_PLANS = [
  { key: 'seats_1', seats: 1, monthly: 2500 },
  { key: 'seats_2', seats: 2, monthly: 4500 },
  { key: 'seats_3', seats: 3, monthly: 6000 },
  { key: 'seats_4', seats: 4, monthly: 7500 },
]

/** Above this, self-serve stops and Contact Sales begins. */
export const SEAT_SELF_SERVE_MAX = asInt(
  process.env.SEAT_SELF_SERVE_MAX,
  SEAT_PLANS[SEAT_PLANS.length - 1].seats,
)


/**
 * Cursus Triage — packs of CV processing capacity.
 *
 * The metered unit is the CV, not the Triage. A Triage workspace is free and
 * unlimited: a recruiter can open one per role, per week, per idea, and it
 * costs nothing until CVs are actually submitted for processing.
 *
 * That is the honest shape for this product. Selling whole Triages meant a
 * recruiter with forty applicants paid the same as one with four hundred, and
 * it made opening a second workspace for a second role feel expensive — which
 * discouraged the exact behaviour the feature exists to support.
 *
 * `total` is authoritative and the per-CV rate is derived from it, so a rounded
 * unit price can never disagree with what is charged. Same convention as the
 * reveal packs, for the same reason.
 */
export const TRIAGE_PACKS = [
  { key: 'triage_cv_100', cvs: 100, total: 3000 },
  { key: 'triage_cv_200', cvs: 200, total: 5500 },
  { key: 'triage_cv_300', cvs: 300, total: 7500 },
  { key: 'triage_cv_500', cvs: 500, total: 11500 },
]

/**
 * The most CVs one Triage may hold. A safety limit, not a commercial one.
 *
 * This number used to be the product: a Triage was the unit sold and this was
 * "what you bought". It no longer means anything commercial — capacity is a
 * pool of CVs the organization spends across as many Triages as it likes — so
 * it is now only what it always should have been: the point past which one
 * upload is too big to process sensibly in a single batch.
 */
export const TRIAGE_MAX_FILES = asInt(
  process.env.TRIAGE_MAX_FILES,
  TRIAGE_PACKS[TRIAGE_PACKS.length - 1].cvs,
)

/** Beyond the largest pack, a conversation rather than an extrapolated price. */
export const TRIAGE_SELF_SERVE_MAX = asInt(
  process.env.TRIAGE_SELF_SERVE_MAX,
  TRIAGE_PACKS[TRIAGE_PACKS.length - 1].cvs,
)

const SYMBOLS = { ILS: '₪', USD: '$', EUR: '€', GBP: '£' }

/** "8000" -> "₪80.00". Server-side so receipts and UI cannot disagree. */
export function formatAmount(minorUnits, currency = CURRENCY) {
  const symbol = SYMBOLS[currency] ?? `${currency} `
  const major = (minorUnits / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${symbol}${major}`
}

/** Trailing ".00" dropped, for card headlines where the cents are noise. */
export function formatRounded(minorUnits, currency = CURRENCY) {
  const formatted = formatAmount(minorUnits, currency)
  return formatted.replace(/\.00$/, '')
}

/**
 * What `seats` additional seats cost per month.
 *
 * Zero is free — that is an organization on the administrator alone, which is
 * the state every one of them starts in. Above the self-serve maximum there is
 * no price at all rather than an extrapolated one: those organizations are told
 * to contact sales, and inventing a number for them here would be quoting a
 * deal nobody has agreed to.
 */
export function seatPlanMonthly(seats) {
  if (seats <= 0) return 0
  const plan = SEAT_PLANS.find((entry) => entry.seats === seats)
  return plan ? plan.monthly : null
}

/** Display metadata for one tier: the monthly charge and the cost per seat. */
export function seatPlanView(seats) {
  const monthly = seatPlanMonthly(seats)
  if (monthly === null) return null

  /* The headline figure is the monthly total; per-seat is derived from it, so a
     rounded unit price can never disagree with what is actually charged. */
  const unit = seats > 0 ? Math.round(monthly / seats) : 0
  const base = SEAT_PLANS[0].monthly

  return {
    key: `seats_${seats}`,
    kind: 'seat',
    quantity: seats,
    monthly,
    unit,
    currency: CURRENCY,
    /* Against the price of a single seat, which is the undiscounted rate — the
       same convention the reveal packs use against their smallest pack. */
    discount: base === 0 ? 0 : Math.round((1 - unit / base) * 1000) / 10,
    formattedMonthly: formatRounded(monthly),
    formattedUnit: formatRounded(unit),
  }
}

/** The same, for a reveal pack. The 25-pack sets the undiscounted unit price. */
export function revealPackView(pack) {
  const unit = pack.total / pack.reveals
  const base = REVEAL_PACKS[0].total / REVEAL_PACKS[0].reveals

  return {
    key: pack.key,
    kind: 'reveal',
    quantity: pack.reveals,
    total: pack.total,
    unit,
    currency: CURRENCY,
    discount: Math.round((1 - unit / base) * 1000) / 10,
    formattedTotal: formatRounded(pack.total),
    // Reveals are priced in fractions of a shekel, so this one keeps its cents.
    formattedUnit: formatAmount(unit),
  }
}


/** The same, for a Triage pack. The smallest pack sets the undiscounted rate. */
export function triagePackView(pack) {
  const unit = pack.total / pack.cvs
  const base = TRIAGE_PACKS[0].total / TRIAGE_PACKS[0].cvs

  return {
    key: pack.key,
    kind: 'triage',
    quantity: pack.cvs,
    total: pack.total,
    unit,
    currency: CURRENCY,
    maxFiles: TRIAGE_MAX_FILES,
    discount: Math.round((1 - unit / base) * 1000) / 10,
    formattedTotal: formatRounded(pack.total),
    /* Per CV, so it keeps its cents — 30 ILS for 100 CVs is 0.30 each, and
       rounding that to a whole shekel would misstate it by 200%. */
    formattedUnit: formatAmount(unit),
  }
}

/**
 * Everything the pricing page needs, in the shape it renders.
 *
 * Public: §4.1 puts both tabs in front of unauthenticated visitors, because
 * team size is a normal thing to work out before signing up.
 */
export function pricingCatalogue() {
  return {
    currency: CURRENCY,
    complimentaryReveals: COMPLIMENTARY_REVEALS,
    complimentaryTriageCvs: COMPLIMENTARY_TRIAGE_CVS,
    includedSeats: INCLUDED_SEATS,
    seatSelfServeMax: SEAT_SELF_SERVE_MAX,
    triageMaxFiles: TRIAGE_MAX_FILES,
    triageSelfServeMax: TRIAGE_SELF_SERVE_MAX,
    reveals: REVEAL_PACKS.map(revealPackView),
    seats: SEAT_PLANS.map((plan) => seatPlanView(plan.seats)),
    triage: TRIAGE_PACKS.map(triagePackView),
  }
}

/** Looks up a pack the client claims to have selected. Never trusts its price. */
export function findRevealPack(key) {
  return REVEAL_PACKS.find((pack) => pack.key === key) ?? null
}

/** The same for Triage. The client sends a key; the price is read here. */
export function findTriagePack(key) {
  return TRIAGE_PACKS.find((pack) => pack.key === key) ?? null
}
