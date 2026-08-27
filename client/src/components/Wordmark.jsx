/**
 * The Cvrsvs brand marks.
 *
 * Two assets with different jobs, per §3.3: the full wordmark belongs in the
 * header, footer, About and Contact; the compact mark is only for constrained
 * squares — the browser tab, a home-screen icon. The mark never stands in for
 * the wordmark on desktop.
 *
 * Drawn as inline SVG rather than an <img> so the strokes inherit currentColor.
 * That is what lets one asset sit black on white and white on oxblood without a
 * second file, which §3.1's contrast rule otherwise requires.
 */

/**
 * The mark on its own tile: an open C with a forward chevron in its mouth.
 *
 * Colours are fixed rather than inherited. The tile is the logo, and a logo
 * that changes colour with its surroundings is not a logo — it also means the
 * white strokes always sit on the red they were drawn for, at 9.33:1, wherever
 * the mark is placed.
 */
export const MARK_TILE = '#7A2E2A'
export const MARK_STROKE = '#FFFFFF'

/**
 * §1/§9 — the same mark inverted, for the oxblood header and footer.
 *
 * The tile becomes white and the strokes take the oxblood, rather than the tile
 * going transparent and the strokes going white: an outlined C floating on the
 * bar loses the logo's silhouette, and the two colours are the same pair either
 * way round, so the inverted mark still measures 9.33:1.
 */
export function BrandMark({ size = 32, title = null, inverse = false }) {
  const tile = inverse ? MARK_STROKE : MARK_TILE
  const stroke = inverse ? MARK_TILE : MARK_STROKE

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title ? 'img' : 'presentation'}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : 'true'}
      focusable="false"
    >
      <rect width="64" height="64" rx="15" fill={tile} />
      {/*
        The arc stops short on the right rather than closing, so the chevron
        occupies the gap instead of colliding with the stroke. Round caps keep
        the two shapes reading as one drawn gesture.
      */}
      <path
        d="M44 15.5a21 21 0 1 0 0 33"
        fill="none"
        stroke={stroke}
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path
        d="M31 21.5 45.5 32 31 42.5"
        fill="none"
        stroke={stroke}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The full wordmark. Set in the brand's own letterforms rather than live text
 * elsewhere, but kept as text here so it stays selectable, searchable and
 * legible to a screen reader at any zoom.
 */
export default function Wordmark({ mark = true, size = 28, inverse = false }) {
  return (
    <span className={inverse ? 'wordmark wordmark-inverse' : 'wordmark'}>
      {mark && <BrandMark size={size} inverse={inverse} />}
      <span className="wordmark-text">CVRSVS</span>
    </span>
  )
}
