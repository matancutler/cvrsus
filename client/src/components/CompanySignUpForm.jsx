import { useEffect, useState } from 'react'

import LegalConsent from './LegalConsent.jsx'
import PhotoUploader, { PHOTO_TYPES, PHOTO_TYPE_ERROR } from './PhotoUploader.jsx'
import Req from './Req.jsx'
import VerifiedField from './VerifiedField.jsx'
import { PASSWORD_RULES } from '../passwordRules.js'
import { sendForm } from '../api.js'
import { StatusNotice } from './Notice.jsx'

/**
 * Creating a company and its administrator account.
 *
 * Lives here rather than inside HrPanel because it is now rendered in two
 * places: on /hr behind "Create a company account", and on the landing page
 * when someone answers "I am: Recruiter". One copy, so the two cannot drift —
 * which is exactly what happened to the profile-photo block before it was
 * shared.
 *
 * `chrome` decides how much frame it draws. On /hr it is the whole card and
 * carries its own heading; inside the landing card the surrounding aside is
 * already the card, so it draws no panel of its own.
 */
/**
 * `demoSearchToken` is the search a recruiter ran on the landing page before
 * they had an account. Sent with the registration because that is the only
 * request that knows both the token and the account being created — registering
 * does not sign anybody in, so there is no later moment to connect the two.
 */
export default function CompanySignUpForm({ onCreated, chrome = 'panel', demoSearchToken = null }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [photo, setPhoto] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  /* The company's mark, sent with the registration rather than after it:
     registering does not sign anybody in, so there is no later moment when
     this browser could prove it is the administrator. */
  const [logo, setLogo] = useState(null)
  const [logoPreview, setLogoPreview] = useState(null)
  const [proofs, setProofs] = useState({ email: '', phone: '' })

  /* Agreement to the Terms and the Privacy Policy. Unticked to start, and never
     seeded — the administrator signing up is binding the whole organization to
     the recruiter obligations in §4, so this is the one that matters most. */
  const [agreed, setAgreed] = useState(false)
  const [consentError, setConsentError] = useState(false)

  const [form, setForm] = useState({
    companyName: '', firstName: '', lastName: '',
    email: '', phone: '', website: '',
    password: '', confirmPassword: '',
  })

  // Object URLs have to be revoked, or each re-pick leaks the previous image.
  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null)
      return undefined
    }
    const url = URL.createObjectURL(photo)
    setPhotoPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  /* The same validation the portrait gets — one rule for both, so a file that
     is refused as a picture is not quietly accepted as a mark. */
  function chooseLogo(selected) {
    if (!selected) return
    if (!PHOTO_TYPES.includes(selected.type)) {
      setError(PHOTO_TYPE_ERROR)
      return
    }
    setError('')
    setLogo(selected)
    setLogoPreview(URL.createObjectURL(selected))
  }

  function choosePhoto(selected) {
    if (!selected) return
    if (!PHOTO_TYPES.includes(selected.type)) {
      setError(PHOTO_TYPE_ERROR)
      return
    }
    setError('')
    setPhoto(selected)
  }

  async function submit(event) {
    event.preventDefault()

    /* Set before the other checks so its message — which sits under the
       checkbox, not in the error line below — appears alongside them rather
       than only once everything else is satisfied. */
    setConsentError(!agreed)

    // The server refuses an unproved address anyway; saying so here means the
    // whole form is not thrown back for something visible on screen.
    if (!proofs.email || !proofs.phone) {
      setError(`Please verify your ${!proofs.email ? 'email address' : 'phone number'} first.`)
      return
    }

    // Silent: the message is already on screen from the line above.
    if (!agreed) return

    setBusy(true)
    setError('')
    try {
      const data = new FormData()
      if (photo) data.append('photo', photo)
      if (logo) data.append('logo', logo)
      for (const key of Object.keys(form)) data.append(key, form[key])
      data.append('emailProof', proofs.email)
      data.append('phoneProof', proofs.phone)
      /* Sent, and recorded — see the candidate form for what this was doing
         before, which was nothing. */
      data.append('consent', 'true')
      if (demoSearchToken) data.append('demoSearchToken', demoSearchToken)

      /*
       * The response carries the company and the contact details the review
       * will answer to, and no session — registering no longer signs anyone in.
       * Passed up rather than dropped so the confirmation page can name them.
       */
      const created = await sendForm('/api/company/register', data)
      onCreated(created)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const bare = chrome === 'bare'

  return (
    <form className={bare ? 'company-signup' : 'panel panel-login company-signup'} onSubmit={submit}>
      {!bare && (
        <>
          {/* §15 — the title welcomes, the subtitle says what the form does. */}
          <h1>Welcome to CURSUS</h1>
          <p className="muted">Create your business account</p>
        </>
      )}

      <p className="muted">
        This creates the company and your administrator account together. Every other recruiter
        account is created by you from the Team tab; nobody can sign themselves up.
      </p>

      <div className="field">
        <label className="field-label" htmlFor="company-name">Company name<Req /></label>
        <input
          id="company-name" required value={form.companyName}
          onChange={(e) => update('companyName', e.target.value)}
        />
      </div>

      {/*
        §15 removed the sign-up secret and §16 removed the "Your administrator
        account" heading that used to divide the company's fields from the
        person's. With both gone, Company name sat directly above First name
        with nothing marking the change of subject — this rule does that job.
      */}
      <div className="form-divider" />

      {/*
        Who you are, and who you are from — side by side, left-aligned with the
        fields underneath.

        Two controls rather than one because they are two different pictures
        with two different owners: the portrait is this administrator's and
        follows them, the logo is the company's and every colleague will see
        it. The rectangle is not decoration — a wordmark in a circle loses its
        ends, which is where the name usually is.
      */}
      <div className="identity-pair">
        <PhotoUploader
          photoUrl={photoPreview}
          onChoose={choosePhoto}
          onRemove={() => { setPhoto(null); setPhotoPreview(null) }}
          disabled={busy}
        />
        <PhotoUploader
          label="Company logo"
          shape="rect"
          noun="company logo"
          photoUrl={logoPreview}
          onChoose={chooseLogo}
          onRemove={() => { setLogo(null); setLogoPreview(null) }}
          disabled={busy}
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="field-label" htmlFor="admin-first">First name<Req /></label>
          <input
            id="admin-first" required value={form.firstName}
            onChange={(e) => update('firstName', e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="admin-last">Last name<Req /></label>
          <input
            id="admin-last" required value={form.lastName}
            onChange={(e) => update('lastName', e.target.value)}
          />
        </div>
      </div>

      {/*
        §17 — email, phone and website, all mandatory, after last name so the
        identity fields group together. The first two are proved with a code,
        exactly as the candidate's are: this is the account that reaches
        candidate profiles, and these details are also what a human reads when
        deciding whether to approve the company.
      */}
      <VerifiedField
        channel="email"
        id="admin-email"
        label="Email"
        type="email"
        autoComplete="email"
        value={form.email}
        proof={proofs.email}
        onChange={(value) => update('email', value)}
        onProof={(proof) => setProofs((prev) => ({ ...prev, email: proof }))}
        disabled={busy}
      />

      <VerifiedField
        channel="phone"
        id="admin-phone"
        label="Phone number"
        type="tel"
        autoComplete="tel"
        value={form.phone}
        proof={proofs.phone}
        onChange={(value) => update('phone', value)}
        onProof={(proof) => setProofs((prev) => ({ ...prev, phone: proof }))}
        disabled={busy}
      />

      <div className="field">
        <label className="field-label" htmlFor="admin-website">Website<Req /></label>
        <input
          id="admin-website" required type="text" placeholder="acme.com" value={form.website}
          onChange={(e) => update('website', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="admin-password">Password<Req /></label>
        <input
          id="admin-password" required type="password" autoComplete="new-password"
          value={form.password}
          onChange={(e) => update('password', e.target.value)}
        />
        {/*
          §17 — the four rules as a checklist that ticks off while you type. One
          sentence under the field could only report a failure after a submit,
          which is the point at which knowing is least use.
        */}
        <ul className="rule-list">
          {PASSWORD_RULES.map(({ key, label, test }) => (
            <li key={key} className={test(form.password) ? 'rule-met' : undefined}>{label}</li>
          ))}
        </ul>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="admin-confirm">Confirm password<Req /></label>
        <input
          id="admin-confirm" required type="password" autoComplete="new-password"
          value={form.confirmPassword}
          onChange={(e) => update('confirmPassword', e.target.value)}
        />
        {/* The other half of the same problem: whether the two agree was only
            answerable by submitting. */}
        {form.confirmPassword && (
          <p className={`match-line ${form.password === form.confirmPassword ? 'match-ok' : 'match-bad'}`}>
            {form.password === form.confirmPassword ? 'Passwords match' : 'Passwords do not match yet'}
          </p>
        )}
      </div>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      {/* Directly above the button it gates. The id differs from the candidate
          form's because both can be mounted on the landing page across a role
          switch, and two labels pointing at one id would tick the wrong box. */}
      <LegalConsent
        id="company-consent"
        checked={agreed}
        onChange={(next) => {
          setAgreed(next)
          if (next) setConsentError(false)
        }}
        showError={consentError}
      />

      {/* §18 — "Create Account". The Back to sign in link below it is gone, so
          the header's Sign in dropdown is the way out. Left enabled when the
          box is unticked so that pressing it can say why. */}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Creating…' : 'Create Account'}
      </button>
    </form>
  )
}
