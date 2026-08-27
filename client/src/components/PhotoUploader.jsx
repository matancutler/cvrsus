import { useRef, useState } from 'react'

import AddPhotoIcon from './AddPhotoIcon.jsx'
import PersonIcon from './PersonIcon.jsx'

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const PHOTO_TYPE_ERROR = 'Your photo must be a JPG, PNG or WebP image.'

/**
 * §5 — the profile picture, with the label above the circle and the circle as the
 * only target.
 *
 * The Add photo button that used to sit beside it is gone, so the dashed ring
 * has to carry the entire affordance: it is a real <button>, so it is tabbable
 * and announces itself, it changes cursor and border on hover, and it accepts a
 * drop as well as a click — which the button next to it never did.
 *
 * §16 uses the same component on the administrator sign-up. Built once on
 * purpose: the two forms had separately-written copies of this block and had
 * already drifted apart on their button labels.
 */
/*
 * `label` can be dropped where the circle needs no naming.
 *
 * On the candidate's own page the photo is large and centred above the CV box
 * with a Remove button under it — the heading was telling somebody looking at
 * their own face what it was. On the administrator sign-up it stays: there the
 * circle is small and inline among labelled fields, and an unlabelled one in
 * that column reads as a control nobody explained.
 *
 * Nothing is lost for a screen reader either way — the button below carries its
 * own accessible name, which is why this span was never a <label> to begin
 * with.
 */
export default function PhotoUploader({
  photoUrl, onChoose, onRemove, disabled = false, label = 'Profile picture',
  /*
   * Whether a picture can be added right now, which is what decides the mark in
   * an empty circle.
   *
   * True almost everywhere, because this component is normally the control. The
   * exception is the candidate's own page while it is locked: there it is a
   * profile being read rather than a form being filled, so an empty circle is a
   * statement — no picture — and not an instruction.
   */
  canAdd = true,
}) {
  const input = useRef(null)
  const [dragging, setDragging] = useState(false)

  const open = () => input.current?.click()

  return (
    <div className="photo-field">
      {/*
        Not a <label>: the control it names is a button, and a label pointing at
        a button is ignored by some screen readers and clickable in none of
        them. The button carries its own accessible name instead.
      */}
      {label && <span className="field-label">{label}</span>}

      <button
        type="button"
        className={dragging ? 'avatar avatar-editable avatar-dragging' : 'avatar avatar-editable'}
        onClick={open}
        disabled={disabled}
        aria-label={photoUrl
          ? 'Replace profile picture'
          : (canAdd ? 'Add a profile picture' : 'No profile picture')}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const dropped = e.dataTransfer.files?.[0]
          if (dropped) onChoose(dropped)
        }}
      >
        {/*
          A plus, not a silhouette. This circle is a button onto a file picker
          wherever it appears — the application form, the administrator sign-up,
          a profile being edited — so an empty one is an invitation rather than
          a report. It is also what a candidate sees the moment they press
          Remove and before they save: the picture is gone and the way to
          replace it is the same circle, which should say so.
        */}
        {photoUrl
          ? <img src={photoUrl} alt="" />
          : (
            <span className="avatar-empty">
              {canAdd ? <AddPhotoIcon size={40} /> : <PersonIcon size={44} />}
            </span>
          )}
      </button>

      <input
        ref={input}
        type="file"
        accept={PHOTO_TYPES.join(',')}
        hidden
        // Cleared after every pick, so choosing the same file twice in a row
        // still fires a change event.
        onChange={(e) => { const picked = e.target.files?.[0]; e.target.value = ''; if (picked) onChoose(picked) }}
      />

      {/* Only once there is something to remove. §5 removes the Add button, not
          the way back out of a photo you did not mean to attach. */}
      {photoUrl && onRemove && (
        <div className="photo-actions">
          <button type="button" className="btn btn-quiet btn-small" onClick={onRemove} disabled={disabled}>
            Remove
          </button>
        </div>
      )}
    </div>
  )
}
