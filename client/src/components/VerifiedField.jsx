import { useEffect, useRef, useState } from 'react'

import Req from './Req.jsx'
import { post } from '../api.js'

/*
 * The prefixes an Israeli mobile can start with.
 *
 * Mobiles only, deliberately: every field this component draws is verified by
 * SMS, so a landline here is a number the candidate can never receive a code
 * on. Offering 03 would be offering a choice that fails at the next step.
 */
const PHONE_PREFIXES = ['050', '051', '052', '053', '054', '055', '058']

/* Seven digits after the prefix — every Israeli mobile number is ten in total. */
const PHONE_REST_DIGITS = 7

/**
 * A stored number, taken apart into the two boxes.
 *
 * Handles what is already in the database as well as what a person types:
 * "+972529592503" and "00972529592503" are the same number as "052-959-2503",
 * and a profile saved before this control existed holds any of them.
 *
 * A number matching no known prefix comes back with an empty one and its digits
 * intact, so the field shows what is there and lets it be corrected — rather
 * than guessing a prefix and quietly changing somebody's number.
 */
function splitPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '')

  /* Longest international form first: 00972… also starts with 0. */
  if (digits.startsWith('00972')) digits = `0${digits.slice(5)}`
  else if (digits.startsWith('972')) digits = `0${digits.slice(3)}`

  const prefix = PHONE_PREFIXES.find((p) => digits.startsWith(p)) ?? ''
  return { prefix, rest: prefix ? digits.slice(prefix.length) : digits }
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
              className="phone-prefix"
              aria-label="Mobile prefix"
              value={splitPhone(value).prefix}
              disabled={disabled || (verified && lockWhenVerified)}
              onChange={(e) => {
                changed(`${e.target.value}${splitPhone(value).rest}`)
              }}
            >
              <option value="" disabled>Prefix</option>
              {PHONE_PREFIXES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>

            <input
              id={id}
              type="tel"
              inputMode="numeric"
              className="phone-rest"
              required={!optional}
              value={splitPhone(value).rest}
              placeholder="9592503"
              maxLength={PHONE_REST_DIGITS}
              autoComplete="tel-national"
              readOnly={verified && lockWhenVerified}
              disabled={disabled}
              onChange={(e) => {
                /* Digits only. Somebody pasting "052-959-2503" into this box
                   would otherwise end up with the prefix twice. */
                const rest = e.target.value.replace(/\D/g, '').slice(-PHONE_REST_DIGITS)
                changed(`${splitPhone(value).prefix}${rest}`)
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
