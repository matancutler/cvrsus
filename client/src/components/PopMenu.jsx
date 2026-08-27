import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import portalHost from '../portalHost.js'

/**
 * A small menu behind a "…" button.
 *
 * Two problems this exists to solve, both of which the plain absolutely-
 * positioned version had:
 *
 * 1. It was clipped. The menus live inside the messaging dock, whose panel and
 *    chat windows both set `overflow: hidden` so their own contents scroll — and
 *    an absolutely positioned child cannot escape a clipping ancestor. A menu
 *    opened from a collapsed conversation was rendered, and invisible.
 *
 * 2. It opened downward regardless of room. The dock is anchored to the bottom
 *    of the window, so downward is the one direction with nothing in it: the
 *    menu ran off the bottom of the screen.
 *
 * Rendering through a portal to document.body escapes every clipper, and fixed
 * coordinates measured from the button let it flip above when there is no room
 * below. Position is recomputed on open rather than tracked continuously — the
 * menu closes on scroll and resize, so a stale position can never be shown.
 */
export default function PopMenu({ label, items, align = 'right', vertical = false }) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const button = useRef(null)
  const menu = useRef(null)

  const place = useCallback(() => {
    const trigger = button.current?.getBoundingClientRect()
    if (!trigger) return

    /* Measured after paint, so the height is the real one rather than a guess
       at how tall the items will be. */
    const height = menu.current?.offsetHeight ?? 0
    const width = menu.current?.offsetWidth ?? 190
    const GAP = 6

    const roomBelow = window.innerHeight - trigger.bottom
    const above = roomBelow < height + GAP && trigger.top > height + GAP

    const left = align === 'right'
      ? Math.max(GAP, Math.min(trigger.right - width, window.innerWidth - width - GAP))
      : Math.max(GAP, Math.min(trigger.left, window.innerWidth - width - GAP))

    /* Clamped as well as flipped: on a short viewport there is room in neither
       direction, and the unclamped form took a negative top that put the first
       item above the top of the screen. */
    const wanted = above ? trigger.top - height - GAP : trigger.bottom + GAP
    setBox({ left, top: Math.max(GAP, Math.min(wanted, window.innerHeight - height - GAP)) })
  }, [align])

  /* Placed before the browser paints, so it never appears in the wrong spot
     and jumps. The menu is rendered offscreen-but-measurable until then. */
  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  /*
   * Opening it puts you in it.
   *
   * A menu that opens with focus still on the button behind it is a menu a
   * keyboard cannot reach: Tab from there goes to whatever follows the trigger
   * in the document, which — since this renders through a portal to body — is
   * not the menu. Focus moves in on open and back to the trigger on close, so
   * Escape returns you where you were rather than at the top of the page.
   */
  useEffect(() => {
    if (!open) return undefined
    menu.current?.querySelector('[role=menuitem]')?.focus()
    return () => button.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined

    const close = () => setOpen(false)
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      /* This menu, not the dialog it was opened from — both were listening and
         both shut on one press. */
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    /* Capture phase: the dock's own columns scroll, and those do not bubble. */
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)

    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <div className="dock-row-menu">
      {/* Vertical in a dialog header, where it sits beside a close button in a
          column of controls; horizontal on a row, where it sits at the end of a
          line of text. Same menu either way. */}
      <button
        ref={button}
        type="button"
        className={vertical ? 'dock-icon dock-dots dock-dots-vertical' : 'dock-icon dock-dots'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((was) => !was) }}
      >
        {vertical ? '\u22EE' : '\u22EF'}
      </button>

      {open && createPortal(
        <div
          ref={menu}
          className="dock-menu dock-menu-floating"
          role="menu"
          /* Hidden until placed, so the first paint is never in the corner. */
          style={box ? { left: box.left, top: box.top } : { opacity: 0, pointerEvents: 'none' }}
          onClick={(event) => event.stopPropagation()}
          /* Arrow keys walk the items and wrap, Home and End jump to the ends —
             what a role="menu" promises anybody driving it by keyboard. */
          onKeyDown={(event) => {
            const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
            if (!keys.includes(event.key)) return
            event.preventDefault()
            event.stopPropagation()

            const options = [...menu.current.querySelectorAll('[role=menuitem]')]
            if (!options.length) return

            const here = options.indexOf(document.activeElement)
            const next = {
              ArrowDown: (here + 1) % options.length,
              ArrowUp: (here - 1 + options.length) % options.length,
              Home: 0,
              End: options.length - 1,
            }[event.key]

            options[next].focus()
          }}
        >
          {items.filter(Boolean).map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? 'dock-menu-item dock-menu-item-danger' : 'dock-menu-item'}
              onClick={() => { setOpen(false); item.onSelect() }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        portalHost(button.current),
      )}
    </div>
  )
}
