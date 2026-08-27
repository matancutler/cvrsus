import { useEffect, useRef, useState } from 'react'

import { withToken } from '../api.js'

/**
 * §7 — the four types the + button offers, with their ceilings.
 *
 * Mirrors DOCUMENT_TYPES on the server, which derives its upload slots from the
 * same table; the server re-validates every field name it is sent, so a client
 * that got out of step is refused rather than believed.
 */
export const DOCUMENT_TYPES = [
  { key: 'cover_letter', label: 'Cover letter', max: 1 },
  { key: 'certification', label: 'Certification(s)', max: 2 },
  { key: 'recommendation', label: 'Recommendation letter(s)', max: 3 },
  { key: 'additional', label: 'Additional document', max: 1 },
]

/** Slot keys for one type, in the order they are filled. Matches the server. */
export function slotsFor(type) {
  return type.max === 1
    ? [type.key]
    : Array.from({ length: type.max }, (_unused, i) => `${type.key}_${i + 1}`)
}

const TYPE_BY_SLOT = new Map(
  DOCUMENT_TYPES.flatMap((type) => slotsFor(type).map((slot) => [slot, type])),
)

/** §7 — PDF, DOCX, PNG and JPEG only, across all four types. */
export const SUPPORTING_ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg,application/pdf,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg'

/**
 * The CV is not one of these types and keeps the narrower list: it is the one
 * document whose text has to be read, and a photographed CV yields nothing.
 */
export const CV_ACCEPT = '.pdf,.docx,application/pdf,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

const SUPPORTING_EXTENSIONS = ['.pdf', '.docx', '.png', '.jpg', '.jpeg']

/** Client-side check on the CV; the server re-validates (spec §5.2). */
export function validateCv(file) {
  const name = file.name.toLowerCase()
  if (!name.endsWith('.pdf') && !name.endsWith('.docx')) {
    return `"${file.name}" must be a PDF or DOCX file.`
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `"${file.name}" is larger than the 5 MB limit.`
  }
  return null
}

/** Client-side check; the server re-validates both of these (spec §5.2). */
export function validateSupportingDocument(file) {
  const name = file.name.toLowerCase()
  if (!SUPPORTING_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return `"${file.name}" must be a PDF, DOCX, PNG or JPEG file.`
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `"${file.name}" is larger than the 5 MB limit.`
  }
  return null
}

/**
 * Slots the old four-row form created and this one no longer offers.
 *
 * Their files still exist, so they are listed and can be removed — they are
 * simply never handed out again. Mirrors LEGACY_DOCUMENT_SLOTS on the server.
 */
const LEGACY_LABELS = {
  additional_2: 'Additional document 2',
  additional_3: 'Additional document 3',
}

/** The label a stored or chosen file is filed under. */
export function labelForSlot(slot) {
  const type = TYPE_BY_SLOT.get(slot)
  if (!type) return LEGACY_LABELS[slot] ?? 'Document'
  if (type.max === 1) return type.label
  const index = slotsFor(type).indexOf(slot) + 1
  return `${type.label.replace(/\(s\)$/, '')} ${index}`
}

/**
 * §7 — one + button and a list of what is attached.
 *
 * The four fixed rows are gone. They occupied the same space whether or not
 * anyone used them, and three of them were labelled "Additional document N",
 * which describes where a file was put rather than what it is.
 *
 * `files` is the not-yet-uploaded selection keyed by slot; `existing` is what
 * is already stored. Both are keyed the same way, so a row does not care which
 * of the two it came from.
 */
export default function DocumentPicker({
  files, existing, onChoose, onRemove, disabled = false,
  /* Attaching and removing are actions, not facts. A locked profile lists what
     is on file and offers no way to change it, so the + and the × go with the
     rest of the editing controls rather than sitting there inert. */
  canAdd = true,
}) {
  const [open, setOpen] = useState(false)
  const [pendingType, setPendingType] = useState(null)
  const input = useRef(null)
  const wrap = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => { if (!wrap.current?.contains(event.target)) setOpen(false) }
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /*
   * Every slot that currently holds something, chosen or already stored.
   *
   * The CV is excluded — it has its own dropzone above — but a legacy slot is
   * not: those files are real, and a list that quietly omitted them would leave
   * a document attached to the profile that its owner could neither see nor
   * remove.
   */
  const taken = new Set([
    ...Object.keys(files),
    ...existing.map((doc) => doc.slot),
  ].filter((slot) => slot !== 'cv'))

  const usedBy = (type) => slotsFor(type).filter((slot) => taken.has(slot)).length
  /** The first free slot of a type — where the next file of that kind goes. */
  const nextSlot = (type) => slotsFor(type).find((slot) => !taken.has(slot)) ?? null

  const order = [...TYPE_BY_SLOT.keys()]
  const rows = [...taken]
    // Listed in the picker's own order rather than the order they were added,
    // so the list does not reshuffle as files come and go. Legacy slots sort to
    // the end, where -1 puts them once the known ones are placed.
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((slot) => ({
      slot,
      name: files[slot]?.name ?? existing.find((doc) => doc.slot === slot)?.file_name ?? '',
      pending: Boolean(files[slot]),
    }))

  const full = DOCUMENT_TYPES.every((type) => usedBy(type) >= type.max)

  function choose(type) {
    const slot = nextSlot(type)
    if (!slot) return
    setPendingType(slot)
    setOpen(false)
    // The dialog has to open from the click that chose the type, so the file
    // input is triggered here rather than from an effect a tick later.
    input.current?.click()
  }

  return (
    <div className="doc-picker" ref={wrap}>
      <input
        ref={input}
        type="file"
        accept={SUPPORTING_ACCEPT}
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0]
          e.target.value = ''
          if (picked && pendingType) onChoose(pendingType, picked)
          setPendingType(null)
        }}
      />

      {rows.length > 0 && (
        <ul className="doc-uploads">
          {rows.map(({ slot, name, pending }) => (
            <li key={slot} className="doc-upload">
              <div className="doc-upload-text">
                {/*
                  A file already on the server is a link to itself.

                  The name was printed and not openable, so the one question
                  this row raises — "which document is that?" — could only be
                  answered by recognising a filename chosen months ago. A new
                  tab, because this is a document rather than a destination and
                  the form behind it may have unsaved edits. A file only just
                  picked has nothing to link to yet: it is still on this
                  machine, so it stays plain text until it is saved.
                */}
                {pending ? (
                  <span className="doc-upload-name">{name}</span>
                ) : (
                  <a
                    className="doc-upload-name"
                    href={withToken(`/api/candidate/me/documents/${slot}`, 'candidate')}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {name}
                  </a>
                )}
                <span className="doc-upload-type">
                  {labelForSlot(slot)}
                  {!pending && ' · on file'}
                </span>
              </div>
              {/* §7 — a small red ×, and clicking it removes that upload. Gone
                  while the profile is locked: nothing there can be changed. */}
              {canAdd && (
              <button
                type="button"
                className="doc-remove"
                onClick={() => onRemove(slot)}
                disabled={disabled}
                aria-label={`Remove ${name || labelForSlot(slot)}`}
              >
                ✕
              </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
      <button
        type="button"
        className="doc-add"
        onClick={() => setOpen((was) => !was)}
        disabled={disabled || full}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={full ? 'All document types added' : 'Add a document'}
        title={full ? 'All document types added' : 'Add a document'}
      >
        {/* The plus alone. What it adds is obvious from where it sits — under a
            list of documents — and the words were the widest thing in a column
            of narrow controls. The name survives for anyone who cannot see it,
            and the full state still has to be said because a disabled button
            with no words cannot explain why. */}
        <span className="doc-add-plus" aria-hidden="true">＋</span>
        {full && 'All document types added'}
      </button>
      )}

      {open && (
        <div className="doc-menu" role="menu">
          {DOCUMENT_TYPES.map((type) => {
            const used = usedBy(type)
            const atMax = used >= type.max
            return (
              <button
                key={type.key}
                type="button"
                role="menuitem"
                disabled={atMax}
                onClick={() => choose(type)}
              >
                {type.label}
                {/* Says why the row is greyed rather than leaving it inert and
                    unexplained — §7 rules out failing after the pick instead. */}
                <span className="doc-menu-count">{used} / {type.max}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
