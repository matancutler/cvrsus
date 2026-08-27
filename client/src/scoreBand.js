/**
 * How a score is coloured, for every surface that shows one.
 *
 * Five bands rather than three, because "green, oxblood, grey" said nothing
 * about the difference between a 51 and a 74:
 *
 *   80–100  excellent   70–79  strong   60–69  fair   50–59  weak   under 50  poor
 *
 * In a module of its own because three screens draw scores — the search card,
 * the candidate profile, and Triage — and for a while only the first two agreed.
 * Triage and the public demo each carried their own `>= 75 ? 'high' : ...`,
 * emitting `score-high`, `score-mid` and `score-low`, which the stylesheet has
 * never defined: every Triage score rendered unstyled, and the two that were
 * styled disagreed with it about where the boundaries fell. A number has to
 * mean the same thing and look the same wherever it is shown.
 */
export default function scoreBand(score) {
  if (score >= 80) return 'excellent'
  if (score >= 70) return 'strong'
  if (score >= 60) return 'fair'
  if (score >= 50) return 'weak'
  return 'poor'
}
