import { useState } from 'react'

/**
 * A list of short answers, as chips with a + on the end.
 *
 * The same shape the account page uses for industries and skills, because it is
 * the same kind of answer: a handful of words, each one whole, each removable on
 * its own. It replaced a comma-separated text box — which asked somebody to
 * remember a syntax, made "Customer Success, Support" ambiguous, and turned
 * deleting the middle entry into a text-editing exercise.
 *
 * The value stays a comma-joined string, because that is what the form sends
 * and what the server parses. Splitting and rejoining here keeps the change to
 * this component rather than spreading a new shape through the form, the
 * request and the endpoint.
 */
export default function TagChips({
  value,
  onChange,
  max = 10,
  placeholder = '',
  disabled = false,
  addLabel = 'Add',
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')

  const tags = String(value ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

  const full = tags.length >= max
  const commit = (next) => onChange(next.join(', '))

  function add(event) {
    event.preventDefault()
    const wanted = text.trim()
    if (!wanted) return

    /* Case-insensitively, because "Fintech" and "fintech" are one answer and
       two chips saying it is just a longer way of saying it once. */
    const already = tags.some((tag) => tag.toLowerCase() === wanted.toLowerCase())
    if (!already) commit([...tags, wanted])

    setText('')
    setAdding(false)
  }

  return (
    <div className="tag-chips">
      <div className="chip-row">
        {tags.map((tag) => (
          <span key={tag} className="chip">
            {tag}
            <button
              type="button"
              className="chip-x"
              disabled={disabled}
              aria-label={`Remove ${tag}`}
              onClick={() => commit(tags.filter((entry) => entry !== tag))}
            >
              &times;
            </button>
          </span>
        ))}

        {!adding && !full && (
          <button
            type="button"
            className="chip chip-add"
            disabled={disabled}
            aria-label={addLabel}
            onClick={() => setAdding(true)}
          >
            +
          </button>
        )}

        {/* Said rather than left to be discovered by a refusal. */}
        {full && <span className="muted chip-limit">{max} is the maximum</span>}
      </div>

      {adding && (
        /*
         * Not a <form>: this lives inside the application form, and a nested
         * form is invalid HTML — the browser drops it, and the Add button ends
         * up submitting the form around it instead. Enter is handled here for
         * the same reason.
         */
        <div className="chip-add-form">
          <input
            autoFocus
            value={text}
            maxLength={60}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); add(event) }
              if (event.key === 'Escape') { setAdding(false); setText('') }
            }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={disabled || !text.trim()}
            onClick={add}
          >
            Add
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-small"
            onClick={() => { setAdding(false); setText('') }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
