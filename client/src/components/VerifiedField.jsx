import { useEffect, useRef, useState } from 'react'

import Req from './Req.jsx'
import { post } from '../api.js'

/*
 * Country dialling codes, the common ones.
 *
 * Not every country: a list of two hundred is a list nobody scrolls. These are
 * the places candidates plausibly are, with Israel first because that is who
 * signs up and the default should cost no clicks. Adding one is adding a line.
 */
const DIAL_CODES = [
  ['+972', 'Israel'],
  ['+1', 'US / Canada'],
  ['+44', 'United Kingdom'],
  ['+33', 'France'],
  ['+49', 'Germany'],
  ['+31', 'Netherlands'],
  ['+32', 'Belgium'],
  ['+41', 'Switzerland'],
  ['+43', 'Austria'],
  ['+39', 'Italy'],
  ['+34', 'Spain'],
  ['+351', 'Portugal'],
  ['+353', 'Ireland'],
  ['+46', 'Sweden'],
  ['+47', 'Norway'],
  ['+45', 'Denmark'],
  ['+358', 'Finland'],
  ['+48', 'Poland'],
  ['+420', 'Czechia'],
  ['+36', 'Hungary'],
  ['+30', 'Greece'],
  ['+40', 'Romania'],
  ['+380', 'Ukraine'],
  ['+7', 'Russia / Kazakhstan'],
  ['+90', 'Turkey'],
  ['+971', 'United Arab Emirates'],
  ['+357', 'Cyprus'],
  ['+91', 'India'],
  ['+86', 'China'],
  ['+81', 'Japan'],
  ['+82', 'South Korea'],
  ['+65', 'Singapore'],
  ['+852', 'Hong Kong'],
  ['+61', 'Australia'],
  ['+64', 'New Zealand'],
  ['+27', 'South Africa'],
  ['+55', 'Brazil'],
  ['+52', 'Mexico'],
  ['+54', 'Argentina'],
]

/* Israel, because that is who signs up. The field opens ready to use. */
const DEFAULT_DIAL = '+972'

/* Longest first, so +972 is not mistaken for +9 and +351 not for +35. */
const DIAL_BY_LENGTH = [...DIAL_CODES]
  .map(([code]) => code)
  .sort((a, b) => b.length - a.length)

/**
 * The digits a subscriber number is actually made of.
 *
 * Leading zeros go. In most of the world a number is written locally with a
 * trunk "0" that is dropped the moment a country code is put in front —
 * 052-959-2503 dialled from abroad is +972 52 959 2503, not +972 052…. Twilio
 * refuses the second with an error about the destination that says nothing
 * about the zero, so it is removed here, as it is typed, rather than becoming a
 * mistake somebody has to be told about.
 */
function subscriberDigits(value) {
  return String(value ?? '').replace(/\D/g, '').replace(/^0+/, '')
}

/**
 * A stored number, taken apart into the two controls.
 *
 * Handles what is already in the database as well as what somebody types:
 * "+972529592503", "00972529592503" and "052-959-2503" are one number, and a
 * profile saved before this control existed holds any of them. A value with no
 * country code is read as the default one, which is what it always meant.
 */
function splitPhone(value) {
  let text = String(value ?? '').replace(/[\s()\-.]/g, '')
  if (text.startsWith('00')) text = `+${text.slice(2)}`

  if (text.startsWith('+')) {
    const dial = DIAL_BY_LENGTH.find((code) => text.startsWith(code))
    if (dial) return { dial, rest: subscriberDigits(text.slice(dial.length)) }
    /* A country not on the list: keep the digits, fall back to the default so
       the control still has something selected, and let the person fix it. */
    return { dial: DEFAULT_DIAL, rest: subscriberDigits(text.slice(1)) }
  }

  return { dial: DEFAULT_DIAL, rest: subscriberDigits(text) }
}

/**
 * An email address or phone number, with the code that proves it is yours.
 *
 * Both sign-up flows use this, so a candidate and a company administrator
 * prove their contact details the same way and neither can drift.
 *
 * The shape of it: type the address, press Verify, a six-digit code arrives, type
 * it back, and the field locks with a tick. What the parent gets is a `proof` —
 * a short-lived token this server signed — which it sends with the form. The
 * proof names the address, so editing the field afterwards has to invalidate it;
 * that is what `onChange` clearing the proof is for, and why the input is locked
 * once verified rather than left quietly editable.
 */
export default function VerifiedField({
  channel,
  label,
  id,
  value,
  proof,
  onChange,
  onProof,
  /*
   * Whether the address counts as proved. Defaults to "we hold a proof for it",
   * which is the sign-up case. The profile page passes this explicitly, because
   * there an address that has not been touched is already verified — it was
   * proved when the account was created and there is no proof in hand for it.
   */
  verified: verifiedProp = null,
  /* Called when the person asks to change a verified address, so a caller that
     decides `verified` on its own can unlock the field. */
  onEdit = null,
  /*
   * Whether a verified address is typed over directly.
   *
   * At sign-up it is not: you proved an address a moment ago and silently
   * editing it afterwards would leave a proof attached to a value it was never
   * about, so the field locks and there is a button to start again.
   *
   * On the profile the opposite is true. The address is verified because it has
   * been on the account for months, not because anything was proved just now —
   * and "edit my profile" has to mean every field, not every field except the
   * two most likely to change. So it stays typeable, and the moment it differs
   * from what is stored the caller's `verified` goes false and the Verify
   * button appears on its own.
   */
  lockWhenVerified = true,
  /*
   * Whether this field may be left blank.
   *
   * Everywhere it appears at sign-up it is required, and it says so. The one
   * place it is not is the form an administrator uses to create a colleague's
   * account: the person can add their own details later, so holding up the
   * account over a phone number nobody has been given yet would be inventing a
   * rule. `required` matters as much as the asterisk — a required input that is
   * empty silently refuses to submit the form around it.
   */
  optional = false,
  type = 'text',
  placeholder,
  autoComplete,
  disabled = false,
}) {
  const [step, setStep] = useState('idle')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [devCode, setDevCode] = useState('')
  const codeInput = useRef(null)

  const verified = verifiedProp ?? Boolean(proof)

  // Focus the code box the moment it appears, so the six digits somebody has
  // just read off their phone go straight in.
  useEffect(() => {
    if (step === 'code') codeInput.current?.focus()
  }, [step])

  async function request() {
    setBusy(true)
    setError('')
    try {
      const result = await post('/api/verify/request', { channel, destination: value })
      setSentTo(result.maskedTo)
      setDevCode(result.devCode ?? '')
      setCode('')
      setStep('code')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    setBusy(true)
    setError('')
    try {
      const result = await post('/api/verify/confirm', { channel, destination: value, code })
      onProof(result.proof)
      setStep('idle')
      setCode('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  /** Editing a verified address makes the proof stale, so it goes with it. */
  function edit() {
    onProof('')
    onEdit?.()
    setStep('idle')
    setError('')
  }

  const canSend = value.trim().length > 3 && !busy && !disabled

  /* Every edit, whichever box it came from, means the same thing: what was
     proved about the old value no longer covers this one. */
  function changed(next) {
    onChange(next)
    if (verified) onProof('')
    if (step === 'code') setStep('idle')
  }

  return (
    <div className="field verified-field">
      <label className="field-label" htmlFor={id}>{label}{optional ? null : <Req />}</label>

      <div className="verified-row">
        {/*
          A phone is two controls, an email is one.

          Free text let somebody write 052-959-2503, +972 52 959 2503, or
          0529592503, and every one of those had to be guessed at before it
          could be dialled. A prefix from a list and seven digits cannot be
          ambiguous — there is one number it can mean.

          Both halves are still reported through the same onChange as one
          string, so nothing outside this component knows the field changed
          shape: the form submits what it always submitted.
        */}
        {channel === 'phone' ? (
          <>
            <select
              className="phone-dial"
              aria-label="Country dialling code"
              value={splitPhone(value).dial}
              disabled={disabled || (verified && lockWhenVerified)}
              onChange={(e) => changed(`${e.target.value}${splitPhone(value).rest}`)}
            >
              {DIAL_CODES.map(([code, country]) => (
                <option key={`${code} ${country}`} value={code}>{code} {country}</option>
              ))}
            </select>

            <input
              id={id}
              type="tel"
              inputMode="numeric"
              className="phone-rest"
              required={!optional}
              value={splitPhone(value).rest}
              autoComplete="tel-national"
              readOnly={verified && lockWhenVerified}
              disabled={disabled}
              onChange={(e) => {
                /* Through subscriberDigits, so a pasted "052-959-2503" and a
                   typed leading zero both become the same thing the dialling
                   code expects to be followed by. */
                changed(`${splitPhone(value).dial}${subscriberDigits(e.target.value)}`)
              }}
            />
          </>
        ) : (
          <input
            id={id}
            type={type}
            required={!optional}
            value={value}
            placeholder={placeholder}
            autoComplete={autoComplete}
            readOnly={verified && lockWhenVerified}
            disabled={disabled}
            onChange={(e) => changed(e.target.value)}
          />
        )}

        {verified ? (
          <span className="verified-mark" title="Verified">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
              <path
                d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6"
                strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
            Verified
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-small verified-send"
            onClick={request}
            disabled={!canSend}
          >
            {busy && step !== 'code' ? 'Sending…' : step === 'code' ? 'Resend' : 'Verify'}
          </button>
        )}
      </div>

      {/* Only meaningful when the field is locked; where it is typeable, the
          way to use a different address is to type one. */}
      {verified && lockWhenVerified && (
        <button type="button" className="btn btn-quiet btn-small verified-edit" onClick={edit}>
          Use a different {channel === 'email' ? 'email address' : 'number'}
        </button>
      )}

      {!verified && step === 'code' && (
        <div className="verify-code">
          <p className="field-hint">
            We sent a six-digit code to <strong>{sentTo}</strong>.
            {devCode && <> Development mode: the code is <strong>{devCode}</strong>.</>}
          </p>
          <div className="verified-row">
            <input
              ref={codeInput}
              inputMode="numeric"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              // Enter inside a form would submit it, and the form is not ready
              // to be submitted — this is the only field that matters here.
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }}
            />
            <button
              type="button"
              className="btn btn-primary btn-small verified-send"
              onClick={confirm}
              disabled={busy || code.length !== 6}
            >
              {busy ? 'Checking…' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
