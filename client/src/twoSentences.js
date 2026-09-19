/**
 * The first couple of sentences of a longer piece of prose.
 *
 * The reasoning a model writes about a candidate runs to a short paragraph.
 * On a card that is three or four lines, which makes every row a different
 * height and turns a list into something you read rather than scan — and the
 * whole of it is one click away in the Score tab, where there is room.
 *
 * Cut on sentence boundaries rather than at a character count, because a
 * preview that ends mid-clause reads as broken rather than as abbreviated.
 * "…" is appended only when something was actually left out.
 *
 * A CSS line-clamp is the backstop for two very long sentences and is applied
 * on top of this; it is not a substitute for it, because clamping alone cuts
 * mid-word and leaves the reader unsure whether the thought finished.
 */

/* A sentence ends at . ! or ? followed by whitespace and then something. */
const BOUNDARY = /[.!?]\s+(?=\S)/g

/*
 * …except after an initial or an abbreviation, which is where the naive rule
 * turns "Nearly five years with Gen. Cohen" into a whole sentence.
 *
 * Written as a literal rather than built from a string: `new RegExp('\s')`
 * takes a JavaScript string first, where `\s` is an unknown escape and
 * collapses to a bare `s` — so the guard silently became "preceded by the
 * letter s", which fired on every word ending in s and cut previews a
 * sentence early. A literal cannot lose a backslash on the way in.
 */
const NOT_AN_END = /(?:^|\s)(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|Rev|St|Gen|Brig|Col|Lt|Cpt|Capt|Maj|Sgt|Cpl|Adm|Ltd|Inc|Co|Corp|plc|vs|etc|approx|No|Vol|Dept|Univ)\.$/i

export default function twoSentences(text, limit = 2) {
  const whole = String(text ?? '').trim()
  if (!whole) return ''

  const ends = []
  BOUNDARY.lastIndex = 0
  let match = BOUNDARY.exec(whole)
  while (match !== null) {
    /* Where this sentence would end: just past its punctuation. */
    const at = match.index + 1
    if (!NOT_AN_END.test(whole.slice(0, at))) ends.push(at)
    match = BOUNDARY.exec(whole)
  }

  /* Fewer boundaries than asked for means the whole thing is the preview —
     and it gets no ellipsis, because nothing was left out. */
  if (ends.length < limit) return whole

  const cut = ends[limit - 1]
  if (cut >= whole.length) return whole

  const kept = whole.slice(0, cut).trim()

  /* The full stop is dropped before the ellipsis rather than kept beside it:
     "a genuine gap.…" reads as a typo, "a genuine gap…" reads as more to
     come. A question or exclamation mark is meaning rather than punctuation
     and stays. */
  return `${kept.endsWith('.') ? kept.slice(0, -1) : kept}…`
}
