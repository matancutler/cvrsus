/**
 * How much of the job the score actually rests on.
 *
 * This replaces the model's own "high / medium / low confidence". The two
 * answer the same question and only one of them is evidence: coverage is
 * computed from the verdicts — the weighted share of the job's requirements
 * the CV let us check at all — while confidence was the model's opinion of
 * its own work, which is the weaker signal and the one we were showing.
 *
 * It matters because of what the score is. Fit is earned out of the whole
 * job, so a 74 on 90% coverage and a 74 on 30% are different claims: the
 * first is a judgement, the second is a judgement about a third of a job.
 * Below the floor the product says so in words rather than leaving the
 * recruiter to read a percentage and guess what it implies.
 *
 * Absent entirely when there is no coverage to report — a deterministic
 * score has no verdicts behind it, and an empty chip is furniture.
 *
 * ---
 *
 * In its own file because there are two candidate cards, one in the search
 * results and one in a Triage, and they are in different files. It was
 * written twice, and the two copies had already drifted: the Triage one was
 * missing the second sentence of both tooltips — the half that says what a
 * low percentage means for the number beside it, which is the only reason
 * the chip exists. A recruiter should not get a different explanation of the
 * same score depending on which screen they are on.
 */
export default function CoverageChip({ coverage, needsReview }) {
  if (!Number.isFinite(coverage)) return null

  if (needsReview) {
    return (
      <span
        className="chip chip-review"
        title={`Only ${coverage}% of this job could be checked against this CV. `
          + 'The score is a judgement about that part of it, not about the whole role.'}
      >
        Needs review
      </span>
    )
  }

  return (
    <span
      className="chip chip-neutral"
      title={`${coverage}% of the job's requirements could be checked against this CV. `
        + 'The rest are not mentioned either way.'}
    >
      Checked {coverage}% of the job
    </span>
  )
}
