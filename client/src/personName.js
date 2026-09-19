/**
 * A person's name, capitalised the way names are written.
 *
 * Two places need it and they need the same answer, or the card and the form
 * disagree about who somebody is: a CV parsed out of a document that shouts
 * "MATAN CUTLER" in its header, and a field somebody typed in a hurry.
 *
 * What it will change:
 *
 *   MATAN CUTLER   -> Matan Cutler
 *   matan cutler   -> Matan Cutler
 *   NOA BAR-LEV    -> Noa Bar-Lev
 *   SHIRA O'BRIEN  -> Shira O'Brien
 *
 * What it will NOT change: anything already written in mixed case. McDonald,
 * DeSouza, van der Berg and MacLeod are how those people spell their names,
 * and a rule that lower-cased the interior would be correcting them. So the
 * fix only applies where there is no information to destroy — a word that is
 * entirely upper-case or entirely lower-case has told us nothing about its
 * own capitalisation, and a word with a capital in the middle has.
 *
 * That asymmetry is the whole design. "Title-case everything" is a one-line
 * function and it gets real names wrong every day.
 */

/* Split on the separators that carry a capital after them, keeping the
   separator, so "bar-lev" and "o'brien" each get two initials and "van der
   berg" gets three words handled independently. */
const PARTS = /([-'’\s]+)/

/*
 * Particles that stay lower-case when they are not the first word.
 *
 * "van der Berg" is how that name is written, and Title Case makes it "Van
 * Der Berg" — which is not a stylistic quibble, it is somebody's surname
 * spelled wrong on a recruiter's screen. Only when the particle leads does it
 * take a capital: plenty of people are called Van, De or Ben.
 */
const PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos', 'das',
  'du', 'la', 'le', 'lo', 'el', 'al', 'bin', 'ibn', 'ben', 'bat', 'abu',
  'mac', 'af', 'av', 'ter', 'ten', 'op', 'in', "'t",
])

/** Whether this word tells us anything about how its owner capitalises it. */
function deliberate(word) {
  const letters = word.replace(/[^\p{L}]/gu, '')
  if (letters.length < 2) return false
  /* A capital anywhere but the first position is a choice somebody made. */
  return /\p{Lu}/u.test(letters.slice(1)) && /\p{Ll}/u.test(letters)
}

function capitaliseWord(word) {
  if (!word) return word
  if (deliberate(word)) return word

  /* Only scripts with case are touched. Hebrew, Arabic and the rest have no
     upper and lower to choose between, and toLowerCase on them is a no-op
     that would still burn the comparison below. */
  const first = word.match(/\p{L}/u)
  if (!first) return word

  return word.replace(/\p{L}[\p{L}\p{M}]*/gu, (run) => (
    run.charAt(0).toLocaleUpperCase() + run.slice(1).toLocaleLowerCase()
  ))
}

/**
 * One name field — a first name, a last name, or a whole name.
 *
 * Returns the input unchanged when there is nothing to do, so it is safe to
 * run on every keystroke: React will not re-render for an identical string.
 */
export default function personName(value) {
  const text = String(value ?? '')
  if (!text.trim()) return text

  let seenWord = false

  return text
    .split(PARTS)
    .map((part) => {
      if (PARTS.test(part)) return part
      if (!part) return part

      const leading = !seenWord
      seenWord = true

      /* A particle keeps its lower case once something has come before it.
         `mac` is in the list for "Ronald mac Donald" and deliberately does
         NOT catch "MacLeod", which is one word and already protected. */
      if (!leading && PARTICLES.has(part.toLocaleLowerCase()) && !deliberate(part)) {
        return part.toLocaleLowerCase()
      }

      return capitaliseWord(part)
    })
    .join('')
}

/**
 * The same, but only once the field is finished with.
 *
 * Capitalising as somebody types fights them: type "mcdonald" and the "m"
 * becomes "M" before the "c" arrives, so the word is already mixed-case by
 * the third keystroke and `deliberate` then protects the wrong thing. Run on
 * blur instead, when the word is whole and the rule can see all of it.
 */
export function onBlurName(handler) {
  return (event) => {
    const tidied = personName(event.target.value)
    if (tidied !== event.target.value) handler(tidied)
  }
}
