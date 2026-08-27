import { randomUUID } from 'node:crypto'

/**
 * The payment seam.
 *
 * This module used to hold a recurring per-seat subscription as well. The
 * pricing model replaced that with prepaid Reveal Packs and one-time Seat
 * Packs, so the seat arithmetic now lives in wallet.js and every price in
 * pricing.js. What is left here is the one thing both products share: the
 * boundary a real processor plugs into.
 *
 * `charge` either resolves with a settled payment or throws — callers never see
 * a half-charged state, because nothing is credited until it resolves.
 */
const providers = {
  /**
   * No processor is configured yet, so a purchase is recorded and treated as
   * settled. Every row it writes carries provider 'local', which is what tells
   * a later reconciliation which purchases were never really charged.
   */
  local: {
    name: 'local',
    async charge() {
      return { status: 'paid', reference: `local_${randomUUID()}` }
    },
  },

  /**
   * Deliberately unimplemented. Selecting it without finishing the integration
   * fails loudly at purchase time rather than quietly giving product away.
   */
  stripe: {
    name: 'stripe',
    async charge() {
      throw new Error(
        'Stripe billing is selected but not implemented yet. '
        + 'Set BILLING_PROVIDER=local, or finish the Stripe integration.',
      )
    },
  },
}

export const billingProvider = providers[process.env.BILLING_PROVIDER ?? 'local'] ?? providers.local

/** True while purchases are recorded but no money actually moves. */
export const billingSimulated = billingProvider.name === 'local'
