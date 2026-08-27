/**
 * The candidate's Professional Summary, as recruiters read it.
 *
 * One component for every surface, because the same paragraph appearing three
 * ways on three screens is how one of them ends up out of step with the others.
 * Collapsed rows take the preview, opened profiles take the whole thing, and
 * both come from the same field.
 *
 * Not gated on the reveal. The summary is how a recruiter decides whether to
 * spend one, so putting it behind the reveal would defeat the purpose of having
 * a summary; what makes that safe is that the persisted text names no employer
 * — see server/src/summary.js, which is where that is guaranteed rather than
 * hoped for. Nothing here redacts anything, deliberately: a frontend that
 * hides what an API already sent has protected nobody.
 */

/**
 * The preview, for a collapsed row.
 *
 * As many words as the row has room for, and not one fewer.
 *
 * This used to cut the text to about two sentences in JavaScript before the CSS
 * clamp ever saw it, on the theory that ending on a sentence reads better than
 * ending mid-word. The two disagreed in practice: the row is two lines wide and
 * two sentences are usually shorter than that, so the second line came up empty
 * and the preview implied that was all there was to say about the person. The
 * clamp already ends the visible text with an ellipsis when it overruns, and it
 * measures the line rather than guessing at it.
 *
 * Whitespace is still normalised. A summary typed with a blank line between its
 * paragraphs is one paragraph to a clamp, and the line box has to be counting
 * words rather than newlines.
 *
 * Renders nothing at all when there is no summary. Every candidate should have
 * one — it is generated from the CV when they write none — so an empty here is
 * a record to repair rather than a state to design around, and the row simply
 * closes up rather than showing a gap where a paragraph should be.
 */
export function SummaryPreview({ summary, className = 'result-summary' }) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null

  return <p className={className}>{text}</p>
}

/** The whole thing, for an opened profile. */
export default function ProfessionalSummary({ summary, heading = 'Professional summary' }) {
  const text = String(summary ?? '').trim()
  if (!text) return null

  return (
    <div className="candidate-summary">
      <h4 className="modal-subhead">{heading}</h4>
      {/* Its own class, not `.notes`. That one is an italic, muted, left-ruled
          blockquote — the treatment for an aside — and this is now the first
          thing a recruiter reads about the person. */}
      <p className="candidate-summary-text">{text}</p>
    </div>
  )
}
