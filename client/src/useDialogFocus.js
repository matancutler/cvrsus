import { useCallback, useRef } from 'react'

/**
 * Keeps the keyboard inside an open dialog, and gives it back when it closes.
 *
 * `aria-modal="true"` is a claim, not a mechanism. It tells a screen reader
 * that everything behind this element is inert; it does nothing whatever to
 * where the Tab key goes. Every dialog in the product made that claim and none
 * of them acted on it, so tabbing out of one walked into the page underneath —
 * where the reader is being told there is nothing — and Escape returned focus
 * to the top of the document rather than to the control that opened the thing.
 *
 * Three jobs, in the order they matter:
 *
 *  1. Move focus in. The dialog itself takes it if nothing inside wants it, so
 *     the first Tab goes to the first control rather than to the browser
 *     chrome. That is why the element needs `tabIndex={-1}`.
 *  2. Keep it in. Tab off the last control wraps to the first; Shift+Tab off
 *     the first wraps to the last. The list is read at the moment of the press
 *     rather than cached: dialogs here grow rows, reveal sections and swap
 *     buttons while open, and a cached list would send focus to a node that is
 *     no longer on screen.
 *  3. Give it back. Whatever had focus when the dialog opened gets it again on
 *     close, so dismissing a menu's confirmation puts you back on the menu.
 *
 * A callback ref rather than a ref object with an effect beside it, because
 * most of these dialogs are conditional — `{confirming && <div role="dialog">}`
 * inside a component that stays mounted for the whole session. An effect keyed
 * on the component's own mount runs once, while the node is still absent, and
 * would never fire again when the dialog actually appeared. A callback ref runs
 * when the node attaches and when it detaches, which is precisely the dialog's
 * lifetime and nobody else's.
 *
 * Usage: `const dialog = useDialogFocus()` then `ref={dialog} tabIndex={-1}` on
 * the element carrying role="dialog".
 */
export default function useDialogFocus() {
  /* Held per hook instance rather than in state: nothing here is rendered, and
     a re-render between attach and detach must not lose the opener. */
  const held = useRef(null)

  return useCallback((element) => {
    if (!element) {
      const previous = held.current
      held.current = null
      if (!previous) return

      previous.element.removeEventListener('keydown', previous.onKey)
      /* Only if it is still there to receive it: a dialog that closed because
         the row behind it was deleted has no opener left to return to, and
         focusing a detached node silently drops focus onto the body. */
      const { opener } = previous
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
      return
    }

    const opener = document.activeElement

    /* Anything a browser will focus, minus the things it will not: a disabled
       control, one parked out of the tab order on purpose, or one currently
       drawn at no size — a collapsed section's buttons are in the DOM. */
    const focusable = () => [...element.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]',
    )].filter((node) => !node.disabled
      && node.getAttribute('tabindex') !== '-1'
      && (node.offsetWidth > 0 || node.offsetHeight > 0))

    const onKey = (event) => {
      if (event.key !== 'Tab') return

      const options = focusable()
      if (!options.length) {
        // Nothing to move to, so the press must not leave either.
        event.preventDefault()
        return
      }

      const edge = event.shiftKey ? options[0] : options[options.length - 1]
      if (document.activeElement !== edge && element.contains(document.activeElement)) return

      event.preventDefault()
      ;(event.shiftKey ? options[options.length - 1] : options[0]).focus()
    }

    element.addEventListener('keydown', onKey)
    held.current = { element, onKey, opener }

    /* After paint: the dialogs that fetch their contents render a spinner
       first, and focusing before that resolves lands on a node that is about
       to be replaced. */
    requestAnimationFrame(() => {
      if (held.current?.element !== element) return
      if (element.contains(document.activeElement)) return
      const first = focusable()[0]
      if (first) first.focus()
      else element.focus()
    })
  }, [])
}
