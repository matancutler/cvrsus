import { useCallback, useEffect, useRef, useState } from 'react'

import useDismissOnOutside from '../useDismiss.js'

/**
 * Choose what part of the picture the frame shows.
 *
 * Before this, the frame took the middle of whatever was uploaded and that was
 * the end of it — `object-fit: cover` centres a crop and cannot be argued with.
 * On the pictures people actually upload that is the wrong middle surprisingly
 * often: a phone portrait is three times taller than the circle, so a head at
 * the top of the frame is cropped to a chest; a group photo needs one person
 * out of four; a logo on a wide canvas comes out as its middle third.
 *
 * So the crop is a decision rather than an accident. Drag to move, the slider
 * or the wheel to zoom, and what is inside the frame at the end is what gets
 * uploaded — the file is rendered through a canvas here, so the server stores
 * the picture as chosen and every place that displays it needs no changes.
 */

/* Output edge in pixels. Large enough for the 300px frame on a 2× display and
   for whatever the profile page grows into, small enough that nobody waits. */
const OUTPUT = 640

/* How far in the zoom goes. 1 is "the picture exactly fills the frame", which
   is the old behaviour and so the sensible place to open. */
const MAX_ZOOM = 4

export default function PhotoCropper({
  file,
  shape = 'circle',
  noun = 'profile picture',
  onCancel,
  onDone,
}) {
  const [image, setImage] = useState(null)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(1)

  /*
   * Where the picture sits, as a fraction of the slack rather than in pixels.
   *
   * 0 is centred and ±0.5 is flush with an edge, in both axes and at every
   * zoom. Pixels would have to be re-clamped on every zoom change — zooming out
   * shrinks the slack, so an offset that was legal a moment ago now shows a
   * band of background — and the arithmetic for that is exactly this division
   * done in a less obvious place.
   */
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  const frame = useRef(null)
  const canvas = useRef(null)
  const drag = useRef(null)
  const panel = useRef(null)

  /* Square for a face, 2:1 for a wordmark — the proportions of the frames these
     end up in, so what you line up here is what you get. */
  const aspect = shape === 'rect' ? 2 : 1

  useDismissOnOutside({
    ref: panel,
    onDismiss: useCallback(() => onCancel?.(), [onCancel]),
    active: true,
  })

  /* ------------------------------------------------------------- loading --- */

  useEffect(() => {
    if (!file) return undefined

    const url = URL.createObjectURL(file)
    const img = new Image()

    img.onload = () => {
      setImage(img)
      setZoom(1)
      setOffset({ x: 0, y: 0 })
    }
    img.onerror = () => setError('That image could not be opened. Try another file.')
    img.src = url

    /* The object URL is what the <img> is reading from, so it is released when
       this cropper goes away and not when the load finishes. */
    return () => URL.revokeObjectURL(url)
  }, [file])

  /* ------------------------------------------------------------ geometry --- */

  /*
   * The cover fit, which is the same rule `object-fit: cover` applies and the
   * reason zoom 1 looks exactly like the old behaviour: scale until the picture
   * covers the frame on both axes, and let the longer one overhang.
   */
  const layout = () => {
    const box = frame.current?.getBoundingClientRect()
    if (!image || !box) return null

    const cover = Math.max(box.width / image.width, box.height / image.height)
    const scale = cover * zoom
    const width = image.width * scale
    const height = image.height * scale

    /* What is left to move, which is zero on the axis that fits exactly. */
    const slackX = Math.max(0, width - box.width)
    const slackY = Math.max(0, height - box.height)

    return { box, scale, width, height, slackX, slackY }
  }

  const nudge = (dx, dy) => {
    const geometry = layout()
    if (!geometry) return

    const { slackX, slackY } = geometry
    const clamp = (value) => Math.min(0.5, Math.max(-0.5, value))

    setOffset((was) => ({
      /* A zero-slack axis cannot move, and dividing by it would be NaN — which
         reaches the canvas as a blank frame rather than as an error. */
      x: slackX ? clamp(was.x + dx / slackX) : 0,
      y: slackY ? clamp(was.y + dy / slackY) : 0,
    }))
  }

  /* --------------------------------------------------------- the preview --- */

  /*
   * The picture is an <img> positioned by CSS rather than a live canvas.
   *
   * A canvas redrawn on every pointer move is a frame of latency behind the
   * finger on a large photo, and the crop is judged by eye — so the thing being
   * judged has to keep up. The canvas comes out once, at the end, to produce
   * the file, and it is given the identical arithmetic.
   */
  const preview = (() => {
    const geometry = layout()
    if (!geometry) return null

    const { box, width, height, slackX, slackY } = geometry
    return {
      width,
      height,
      left: (box.width - width) / 2 + offset.x * slackX,
      top: (box.height - height) / 2 + offset.y * slackY,
    }
  })()

  /* ---------------------------------------------------------- the output --- */

  async function confirm() {
    const geometry = layout()
    if (!image || !geometry) return

    const { box, scale, width, height, slackX, slackY } = geometry

    const out = canvas.current
    out.width = OUTPUT
    out.height = Math.round(OUTPUT / aspect)

    const context = out.getContext('2d')

    /*
     * White underneath, always.
     *
     * A PNG with transparency drawn onto a fresh canvas and saved as JPEG gets
     * black wherever it was clear, which turns a logo on a transparent
     * background into a logo in a black box. Filling first costs one call and
     * makes the JPEG path safe for every input.
     */
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, out.width, out.height)

    /* The preview's arithmetic at the output's size. The ratio is what carries
       a 300px-wide frame up to a 640px-wide picture. */
    const ratio = out.width / box.width
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      image,
      ((box.width - width) / 2 + offset.x * slackX) * ratio,
      ((box.height - height) / 2 + offset.y * slackY) * ratio,
      image.width * scale * ratio,
      image.height * scale * ratio,
    )

    /*
     * PNG only where transparency was in the file to begin with. Everything
     * else goes out as JPEG: a photograph re-encoded as PNG is several times
     * the size for no visible difference, and this is uploaded over a phone
     * connection.
     */
    const png = file?.type === 'image/png'
    const type = png ? 'image/png' : 'image/jpeg'

    const blob = await new Promise((resolve) => {
      out.toBlob(resolve, type, png ? undefined : 0.9)
    })

    if (!blob) {
      setError('That image could not be saved. Try another file.')
      return
    }

    const name = String(file?.name ?? 'photo').replace(/\.[^.]+$/, '')
    onDone(new File([blob], `${name}.${png ? 'png' : 'jpg'}`, { type }))
  }

  /* ----------------------------------------------------------- the panel --- */

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cropper-title">
      <div className="modal cropper-modal" ref={panel}>
        <header className="modal-head">
          <h2 id="cropper-title">Position your {noun}</h2>
          <p className="muted">
            Drag the picture to move it, and use the slider to zoom. What is inside
            the frame is what recruiters see.
          </p>
        </header>

        {error && <p className="form-error" role="alert">{error}</p>}

        {/*
          The frame is the crop, so it is the drop shadow's inside edge and not a
          border drawn over the picture: what you line up against is exactly what
          gets kept, to the pixel.

          Pointer events rather than mouse events, so a finger on a phone drags
          it too — and setPointerCapture means a fast drag that leaves the frame
          keeps moving instead of stopping at the edge.
        */}
        <div
          ref={frame}
          className={shape === 'rect' ? 'cropper-frame cropper-frame-rect' : 'cropper-frame'}
          onPointerDown={(e) => {
            if (!image) return
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY }
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            nudge(e.clientX - drag.current.x, e.clientY - drag.current.y)
            drag.current = { x: e.clientX, y: e.clientY }
          }}
          onPointerUp={() => { drag.current = null }}
          onPointerCancel={() => { drag.current = null }}
          onWheel={(e) => {
            if (!image) return
            setZoom((was) => Math.min(MAX_ZOOM, Math.max(1, was - e.deltaY * 0.002)))
          }}
        >
          {preview && (
            <img
              src={image.src}
              alt=""
              draggable="false"
              style={{
                position: 'absolute',
                width: `${preview.width}px`,
                height: `${preview.height}px`,
                left: `${preview.left}px`,
                top: `${preview.top}px`,
                maxWidth: 'none',
              }}
            />
          )}
        </div>

        {/*
          A slider as well as the wheel, because a trackpad's wheel is a gesture
          people discover by accident and a laptop without one has no way in at
          all. It is also the only part of this that a keyboard can reach.
        */}
        <label className="cropper-zoom">
          <span className="field-label">Zoom</span>
          <input
            type="range"
            min="1"
            max={MAX_ZOOM}
            step="0.01"
            value={zoom}
            disabled={!image}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
          />
        </label>

        <div className="modal-foot">
          <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={!image}>
            Use this picture
          </button>
        </div>

        {/* Never shown. It is where the crop is rendered on the way out. */}
        <canvas ref={canvas} hidden />
      </div>
    </div>
  )
}
