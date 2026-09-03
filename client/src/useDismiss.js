import { useEffect } from 'react'

/**
 * Close a thing when the next press lands outside it, or on Escape.
 *
 * Every menu, popover and drawer in the product needs this, and every one of
 * them had been getting it — or not getting it — on its own. NewMenu had it,
 * the two rails' ⋮ menus did not, so a menu opened on one search row stayed
 * open while you clicked a different row, and two menus could be on screen at
 * once. The tooltip bubbles had the same gap. One implementation, so a new
 * popup gets the behaviour by asking for it rather than by remembering to
 * reimplement it.
 *
 * `pointerdown`, not `click`. A click fires after the press completes, which
 * means a press that starts outside and ends inside — a drag, a text selection
 * that runs out of the panel — did not dismiss, while a press on a button
 * somewhere else dismissed *after* that button had already run. pointerdown is
 * the moment the user commits to being somewhere else.
 *
 * @param {object}   options
 * @param {object}   options.ref       Element the popup lives in. A press inside it is not "outside".
 * @param {object}   [options.trigger] The control that opens it, which is usually NOT inside the popup.
 * @param {Function} options.onDismiss Called for an outside press or Escape.
 * @param {boolean}  options.active    Whether to listen at all; false unhooks everything.
 * @param {object}   [options.focusOn] Given focus after Escape, so it is not left on a thing that is gone.
 * @param {boolean}  [options.stopEscape] Stop Escape propagating — for a menu inside a dialog, where both would close on one press.
 */
export default function useDismissOnOutside({
  ref, onDismiss, active, trigger = null, focusOn = null, stopEscape = false,
}) {
  useEffect(() => {
    if (!active) return undefined

    const onPointerDown = (event) => {
      /*
       * A press on an element that has since left the document counts as
       * inside. React removes a row before the event finishes travelling —
       * deleting a search closes its own menu — and `contains` on a detached
       * node is false, which would fire onDismiss for a popup already gone.
       */
      if (!event.target?.isConnected) return
      if (ref.current?.contains(event.target)) return
      /*
       * The button that opens it counts as inside.
       *
       * It is a sibling of the panel, not a parent, so without this a press on
       * it while open would dismiss here and then be toggled straight back on
       * by its own click handler — the menu would never close from its own
       * button. It also covers a popup rendered through a portal, where the
       * panel is nowhere near the control that owns it.
       */
      if (trigger?.current?.contains(event.target)) return
      onDismiss()
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (stopEscape) event.stopPropagation()
      onDismiss()
      focusOn?.current?.focus?.()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [active, ref, trigger, onDismiss, focusOn, stopEscape])
}
