/**
 * Where a floating panel should render, given the button that opens it.
 *
 * These panels — the tag editor, the comments thread, the row menus — portal
 * out of the layout because their ancestors clip: the dock's columns and the
 * workspace rail both set `overflow: hidden` so their own contents scroll, and
 * an absolutely positioned child cannot escape a clipping ancestor. Rendering
 * to document.body solves that.
 *
 * It creates a second problem when the button is inside a dialog. A dialog with
 * `aria-modal="true"` tells assistive technology that everything outside it is
 * inert — so a panel opened from inside one, rendered as a sibling of the
 * dialog rather than a descendant, is announced to nobody. The panel is visibly
 * there and, to a screen reader, does not exist.
 *
 * So: inside the dialog when there is one, and document.body otherwise. The
 * dialog is not a clipping ancestor — it scrolls its body, and these panels are
 * `position: fixed`, which is resolved against the viewport either way — so
 * nothing about the placement changes.
 */
export default function portalHost(trigger) {
  return trigger?.closest?.('[role="dialog"]') ?? document.body
}
