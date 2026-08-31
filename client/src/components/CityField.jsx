import { useEffect, useId, useRef, useState } from 'react'

import { CITIES, cityKey, matchCities } from '../data/cities.js'

/**
 * The City field: a text box that offers the cities rather than restricting to
 * them.
 *
 * Clicking it shows every city; typing narrows the list as each character
 * lands, ignoring case, spacing and punctuation, so "tel aviv" finds
 * "Tel Aviv-Yafo" and "beersheva" finds "Be'er Sheva".
 *
 * It stays a text input, and that is the whole design. A closed dropdown would
 * have to answer for everybody who lives somewhere it does not list — the
 * previous version of this field WAS a dropdown with an "Other" escape, and it
 * was replaced precisely because asking a person in Limassol to file
 * themselves under Other is a poor way to greet them. So: no forced choice, no
 * "no results" dead end, nothing lost by typing something the list has never
 * heard of. The suggestions are a shortcut for the common case, and the common
 * case is most of the traffic.
 *
 * Not a native <datalist>: it will not open on click in Firefox or Safari, it
 * ignores every attempt to style it, and on mobile it collapses to a keyboard
 * suggestion strip. "Click and see the list" has to actually happen.
 */
export default function CityField({
  value,
  onChange,
  id,
  required = false,
  placeholder = '',
  disabled = false,
}) {
  const generatedId = useId()
  const inputId = id ?? `city-${generatedId}`
  const listId = `${inputId}-options`

  const [open, setOpen] = useState(false)
  /*
   * null means "not filtering", which is not the same as an empty query.
   *
   * Clicking a field that already says Haifa asks to see the cities, not to
   * see Haifa — so the list opens whole and only starts narrowing once a key
   * is pressed. Deriving this from `value` instead would show a one-item list
   * to anybody whose city was already filled in from their CV, which is most
   * people, and would look broken.
   */
  const [query, setQuery] = useState(null)
  const [active, setActive] = useState(-1)

  const wrap = useRef(null)
  const list = useRef(null)
  const input = useRef(null)

  const options = query === null ? CITIES : matchCities(query)

  /* Closing on a click elsewhere and on Escape, the same way the workspace's
     own menus do — see NewMenu in HrPanel. */
  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (!wrap.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  /* Keeping the highlighted row in view, because arrowing to something you
     cannot see is arrowing into nothing. */
  useEffect(() => {
    if (!open || active < 0) return
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function show() {
    if (disabled) return
    setOpen(true)
    setQuery(null)
    setActive(-1)
  }

  /*
   * The arrow: the list collapses as well as opens.
   *
   * Clicking the field opens it, which is what somebody who means to type
   * does. The arrow is for somebody who does not yet know there is a list —
   * a bare text box gives no sign that one exists — and it is also the way
   * back out, which clicking a text input cannot be.
   *
   * mousedown is swallowed so the press does not move focus off the input:
   * collapsing the list should leave the cursor where it was, not somewhere
   * the next keystroke goes missing.
   */
  function toggle() {
    if (open) {
      setOpen(false)
      setActive(-1)
      return
    }
    input.current?.focus()
    show()
  }

  function choose(city) {
    onChange(city)
    setOpen(false)
    setQuery(null)
    setActive(-1)
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        show()
        return
      }
      if (!options.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((was) => {
        const next = was + step
        if (next < 0) return options.length - 1
        if (next >= options.length) return 0
        return next
      })
      return
    }

    if (event.key === 'Enter') {
      /*
       * Only when a row is highlighted, and then the form must not also
       * submit.
       *
       * Both halves matter. Swallowing every Enter would stop somebody
       * finishing the signup form from the keyboard; swallowing none would
       * submit the form underneath at the moment they meant to pick a city.
       */
      if (open && active >= 0 && options[active]) {
        event.preventDefault()
        choose(options[active])
      } else {
        setOpen(false)
      }
      return
    }

    if (event.key === 'Escape' && open) {
      /* Not stopped from bubbling on purpose is wrong here: this field is used
         inside a dialog, and Escape should close the list first and the dialog
         only if the list was already shut. */
      event.stopPropagation()
      setOpen(false)
      setActive(-1)
    }
  }

  /* The typed text may itself be a city — worth marking, so somebody who has
     scrolled a long list can see where they already are. */
  const chosen = cityKey(value)

  return (
    <div className="city-field" ref={wrap}>
      <input
        ref={input}
        id={inputId}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        required={required}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setQuery(event.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={show}
        onClick={show}
        onKeyDown={onKeyDown}
      />

      <button
        type="button"
        className="city-toggle"
        /* Named for what it does now, so a screen reader announces the state
           rather than a shape. */
        aria-label={open ? 'Hide the list of cities' : 'Show the list of cities'}
        aria-expanded={open}
        aria-controls={listId}
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
      >
        <svg
          viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" focusable="false"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul className="city-options" id={listId} role="listbox" ref={list}>
          {options.map((city, index) => (
            <li
              key={city}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={cityKey(city) === chosen}
              className={[
                'city-option',
                index === active ? 'is-active' : '',
                cityKey(city) === chosen ? 'is-chosen' : '',
              ].filter(Boolean).join(' ')}
              /* pointerdown, not click: blur would close the list before a
                 click could land on the row that was under the cursor. */
              onPointerDown={(event) => {
                event.preventDefault()
                choose(city)
              }}
              onMouseEnter={() => setActive(index)}
            >
              {city}
            </li>
          ))}

          {!options.length && (
            /* Not an error, and not a dead end. Whatever they have typed is
               already in the field and will be saved as they wrote it. */
            <li className="city-option city-option-none" aria-disabled="true">
              Not on our list — we will use what you typed.
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
