import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import useDismissOnOutside from '../useDismiss.js'
import { createPortal } from 'react-dom'

/**
 * §8 — the small grey (i) that replaces an inline helper line.
 *
 * Deliberately not a hover-only tooltip. The text it holds explains why a
 * button is disabled, and hover reaches neither a touch screen nor a keyboard —
 * so the people most likely to be stuck are exactly the ones a `:hover` rule
 * would never reach. It is a button: tab to it, tap it, or hover it, and the
 * same bubble appears. `aria-describedby` ties the text to the control so it is
 * read out even by someone who never opens it.
 *
 * The bubble is portalled to the body and positioned from the button's measured
 * box, for the same reason the conversation menu is: it opened upward out of a
 * scrolling container, and a clipping ancestor cuts off an absolutely positioned
 * child. Above the results toolbar — a row that sits at the very top of the
 * results column — that meant the bubble was rendered, sized, and entirely
 * invisible. Fixed coordinates escape the clipper, and it flips below the button
 * when there is no room above.
 */
/**
 * The mark itself: an italic i in a speech bubble.
 *
 * Drawn rather than typed. A bare letter took whatever the surrounding font
 * gave it and sat off-centre in most of them; the bubble also says the thing
 * is something said to you rather than a status, which is what distinguishes
 * an explanation from a warning.
 */
function InfoMark() {
  return (
    <svg
      viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M12 3.2c-4.9 0-8.8 3.2-8.8 7.2 0 2.3 1.3 4.3 3.3 5.6v3.4l3.3-2a11 11 0 0 0 2.2.2c4.9 0 8.8-3.2 8.8-7.2S16.9 3.2 12 3.2Z" />
      <path d="M12 7.4v.1" strokeLinecap="round" strokeWidth="2.2" />
      <path d="M12 10.2v3.6" strokeLinecap="round" strokeWidth="2.2" />
    </svg>
  )
}

export default function InfoHint({ text, label = 'More information' }) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const id = useId()
  const anchor = useRef(null)
  const bubble = useRef(null)

  /*
   * A press anywhere else closes it.
   *
   * On a pointer this opens on hover and closes on leave, so it never mattered.
   * On a touch screen there is no leave: the bubble is opened by tapping the
   * (i) and then stayed until something else re-rendered the page. The bubble
   * is portalled out of the anchor to escape the card's overflow, so the two
   * are passed separately — neither contains the other.
   */
  useDismissOnOutside({
    ref: bubble,
    trigger: anchor,
    onDismiss: useCallback(() => setOpen(false), []),
    active: open,
  })

  const place = useCallback(() => {
    const trigger = anchor.current?.getBoundingClientRect()
    if (!trigger) return

    /* Measured after the `hidden` attribute comes off, so this is the bubble's
       real height rather than a guess at how the text wraps. */
    const height = bubble.current?.offsetHeight ?? 0
    const width = bubble.current?.offsetWidth ?? 232
    const GAP = 8

    /* Above by preference — it points down at what it explains — but below
       rather than off the top of the window. */
    const above = trigger.top > height + GAP

    const centred = trigger.left + trigger.width / 2 - width / 2
    return setBox({
      left: Math.max(GAP, Math.min(centred, window.innerWidth - width - GAP)),
      top: above ? trigger.top - height - GAP : trigger.bottom + GAP,
    })
  }, [])

  /* Before paint, so it never shows in the corner and jumps into place. */
  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return undefined

    /* Position is taken once rather than tracked, so anything that would move
       the button out from under it closes it instead of leaving it stranded. */
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)

    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <span
      className="info-hint"
      ref={anchor}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="info-hint-toggle"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setOpen((was) => !was)}
        /*
         * Keyboard focus only.
         *
         * A mouse press focuses the button before it clicks it, so this fired
         * first and opened the bubble, and then onClick toggled it shut again:
         * pressing the (i) did nothing at all, every time, and only hovering
         * ever showed the hint. `:focus-visible` is the browser's own answer to
         * "did this focus come from the keyboard", which is the only case that
         * needs the bubble opened for it.
         */
        onFocus={(event) => { if (event.target.matches(':focus-visible')) setOpen(true) }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
      >
        <InfoMark />
      </button>

      {/*
        Always in the tree, hidden with `hidden` rather than unmounted, so
        aria-describedby always has something to point at — a description that
        only exists while the bubble is open is a description a screen reader
        never sees. An id reference resolves anywhere in the document, so moving
        it to the body costs nothing.
      */}
      {createPortal(
        <span
          ref={bubble}
          id={id}
          className="info-hint-bubble info-hint-bubble-floating"
          role="tooltip"
          hidden={!open}
          /* Transparent until measured, so the first paint is not in the corner. */
          style={box ? { left: box.left, top: box.top } : { opacity: 0 }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
