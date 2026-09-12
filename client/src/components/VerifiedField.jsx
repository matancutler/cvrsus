import { useCallback, useEffect, useRef, useState } from 'react'

import Req from './Req.jsx'
import { post } from '../api.js'
import useDismissOnOutside from '../useDismiss.js'

/*
 * Country dialling codes, the common ones.
 *
 * Not every country: a list of two hundred is a list nobody scrolls. These are
 * the places candidates plausibly are, with Israel first because that is who
 * signs up and the default should cost no clicks. Adding one is adding a line.
 */
const DIAL_CODES = [
  ['+1', 'United States', 'US'],
  ['+1', 'Canada', 'CA'],
  ['+44', 'United Kingdom', 'GB'],
  ['+972', 'Israel', 'IL'],
  ['+61', 'Australia', 'AU'],
  ['+43', 'Austria', 'AT'],
  ['+32', 'Belgium', 'BE'],
  ['+55', 'Brazil', 'BR'],
  ['+86', 'China', 'CN'],
  ['+357', 'Cyprus', 'CY'],
  ['+420', 'Czechia', 'CZ'],
  ['+45', 'Denmark', 'DK'],
  ['+358', 'Finland', 'FI'],
  ['+33', 'France', 'FR'],
  ['+49', 'Germany', 'DE'],
  ['+30', 'Greece', 'GR'],
  ['+852', 'Hong Kong', 'HK'],
  ['+36', 'Hungary', 'HU'],
  ['+91', 'India', 'IN'],
  ['+353', 'Ireland', 'IE'],
  ['+39', 'Italy', 'IT'],
  ['+81', 'Japan', 'JP'],
  ['+52', 'Mexico', 'MX'],
  ['+31', 'Netherlands', 'NL'],
  ['+64', 'New Zealand', 'NZ'],
  ['+47', 'Norway', 'NO'],
  ['+48', 'Poland', 'PL'],
  ['+351', 'Portugal', 'PT'],
  ['+40', 'Romania', 'RO'],
  ['+65', 'Singapore', 'SG'],
  ['+27', 'South Africa', 'ZA'],
  ['+82', 'South Korea', 'KR'],
  ['+34', 'Spain', 'ES'],
  ['+46', 'Sweden', 'SE'],
  ['+41', 'Switzerland', 'CH'],
  ['+90', 'Turkey', 'TR'],
  ['+380', 'Ukraine', 'UA'],
  ['+971', 'United Arab Emirates', 'AE'],
]

/*
 * The United States, because that is who the product is for now.
 *
 * It was Israel, which is where it was built. The two are the same one-line
 * change and this is the line — see also SMS_COUNTRY on the server, which has
 * to agree with it or a number typed here dials somewhere else.
 */
const DEFAULT_DIAL = '+1'

/*
 * How long before a code may be asked for again.
 *
 * Long enough to cover a slow SMS — carrier queues, a handset waking up — and
 * short enough that somebody who genuinely mistyped their number is not stuck.
 */
const RESEND_SECONDS = 60

/*
 * A flag from an ISO country code.
 *
 * Regional indicator symbols: 'US' becomes two code points that a platform with
 * flag support draws as one flag. A platform WITHOUT flag support — Windows,
 * mostly — draws the two letters instead, "US", which is still exactly the
 * information the flag was carrying. So the fallback needs no code.
 */
function flagFor(iso) {
  return String(iso ?? '')
    .toUpperCase()
    .replace(/[A-Z]/g, (c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
}

const DIAL_LABEL = new Map(DIAL_CODES.map(([code, country, iso]) => [
  `${code} ${country}`, { code, country, iso },
]))


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
      /* Only on success. A refused request sent nothing, so there is nothing to
         wait for and the button should be pressable again immediately. */
      setCooldown(RESEND_SECONDS)
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

  /*
   * Which flag to draw.
   *
   * A dial code is not a country — +1 is the United States and Canada, and the
   * number alone cannot say which. So the CHOICE is remembered separately and
   * the stored value stays what it always was, a plain dial code plus digits.
   * Nothing downstream knows or cares which of the two was picked.
   */
  /*
   * Seconds until another code may be asked for.
   *
   * Held here rather than as a timestamp because the button renders the number:
   * a deadline would need its own tick to be displayed anyway, and one interval
   * that owns both the state and the display cannot show a stale value.
   */
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = setInterval(() => setCooldown((left) => Math.max(0, left - 1)), 1000)
    return () => clearInterval(timer)
  }, [cooldown > 0])

  const [dialIso, setDialIso] = useState(null)
  const [dialOpen, setDialOpen] = useState(false)
  const dialWrap = useRef(null)

  useDismissOnOutside({
    ref: dialWrap,
    onDismiss: useCallback(() => setDialOpen(false), []),
    active: dialOpen,
  })

  const currentDial = splitPhone(value).dial
  const dialChoice = (dialIso && DIAL_CODES.find(([, , iso]) => iso === dialIso))
    ? { code: currentDial, country: DIAL_CODES.find(([, , iso]) => iso === dialIso)[1], iso: dialIso }
    : (() => {
      const match = DIAL_CODES.find(([code]) => code === currentDial)
      return match
        ? { code: match[0], country: match[1], iso: match[2] }
        : { code: currentDial, country: currentDial, iso: '' }
    })()

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
            {/*
              A flag, and nothing else, when it is shut.

              A native <select> shows the selected option's whole label, so
              "+972 Israel" sat in the closed box and left the number — the part
              somebody is actually reading back to check — in about eighty
              pixels on a phone. This is a button and a list instead: the button
              shows the flag, the list shows the flag, the country and the code,
              which is what you need to CHOOSE and not what you need to SEE.
            */}
            <div className="phone-dial-wrap" ref={dialWrap}>
              <button
                type="button"
                className="phone-dial"
                aria-haspopup="listbox"
                aria-expanded={dialOpen}
                aria-label={`Country: ${dialChoice.country}, ${dialChoice.code}`}
                disabled={disabled || (verified && lockWhenVerified)}
                onClick={() => setDialOpen((was) => !was)}
              >
                <span className="phone-flag" aria-hidden="true">{flagFor(dialChoice.iso)}</span>
                <span className="phone-dial-caret" aria-hidden="true">▾</span>
              </button>

              {dialOpen && (
                <ul className="phone-dial-list" role="listbox" aria-label="Country">
                  {DIAL_CODES.map(([code, country, iso]) => (
                    <li key={`${code} ${country}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={code === dialChoice.code && country === dialChoice.country}
                        className={code === dialChoice.code && country === dialChoice.country
                          ? 'phone-dial-option phone-dial-option-on'
                          : 'phone-dial-option'}
                        onClick={() => {
                          setDialIso(iso)
                          setDialOpen(false)
                          changed(`${code}${splitPhone(value).rest}`)
                        }}
                      >
                        <span className="phone-flag" aria-hidden="true">{flagFor(iso)}</span>
                        <span className="phone-dial-country">{country}</span>
                        <span className="phone-dial-code">{code}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

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
            disabled={!canSend || cooldown > 0}
          >
            {busy && step !== 'code'
              ? 'Sending…'
              /*
               * The wait, said in seconds, on the button itself.
               *
               * A text can take half a minute. With nothing on screen saying so,
               * people press Resend at twenty seconds, get a second code, and
               * then have two — of which only the newer works, so the first one
               * they read is the one that fails. Naming the number is what stops
               * the second press: a disabled button with no explanation reads as
               * broken, and a countdown reads as "not yet".
               */
              : cooldown > 0
                ? `Resend in ${cooldown}s`
                : step === 'code' ? 'Resend' : 'Verify'}
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
