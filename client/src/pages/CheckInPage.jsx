import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { post } from '../api.js'

/**
 * Where the monthly email's yes/no links land.
 *
 * No sign-in: the emailed token is the credential. When the link already
 * carries an answer the page submits it on arrival, so the candidate's single
 * click is the whole interaction — asking them to click twice is how a
 * check-in goes unanswered.
 */
export default function CheckInPage() {
  const { token } = useParams()
  const [params] = useSearchParams()
  const asked = params.get('answer')

  const [state, setState] = useState(asked ? 'sending' : 'asking')
  const [answer, setAnswer] = useState(null)
  const [error, setError] = useState('')

  const submit = useCallback(async (value) => {
    setState('sending')
    setError('')
    try {
      const result = await post(`/api/checkin/${encodeURIComponent(token)}`, { answer: value })
      setAnswer(result.answer)
      setState('done')
    } catch (err) {
      setError(err.message)
      setState('failed')
    }
  }, [token])

  useEffect(() => {
    if (asked === 'yes' || asked === 'no') submit(asked)
  }, [asked, submit])

  if (state === 'done') {
    return (
      <div className="panel panel-narrow">
        <h1>{answer === 'yes' ? 'Thanks, you are all set' : 'Your profile is now hidden'}</h1>
        {answer === 'yes' ? (
          <p className="muted">
            Your profile is confirmed as open to opportunities, and recruiters can see that it is
            current. We will check again in a month.
          </p>
        ) : (
          <p className="muted">
            Recruiters can no longer find your profile, and the monthly emails have stopped.
            Nothing has been deleted. Sign in whenever you want to turn it back on.
          </p>
        )}
        <Link className="btn btn-primary btn-self-start" to="/account">Go to my account</Link>
      </div>
    )
  }

  if (state === 'failed') {
    return (
      <div className="panel panel-narrow">
        <h1>That link did not work</h1>
        <p className="alert alert-error">{error}</p>
        <p className="muted">
          Each link works once and expires after a month. You can always set your status from your
          account instead.
        </p>
        <Link className="btn btn-primary btn-self-start" to="/account">Sign in to my account</Link>
      </div>
    )
  }

  return (
    <div className="panel panel-narrow">
      <h1>Are you still open to job opportunities?</h1>
      <p className="muted">
        Answering keeps your profile current for recruiters. It takes one click and there is
        nothing to sign in to.
      </p>

      <div className="convo-confirm-actions">
        <button
          type="button" className="btn btn-primary"
          disabled={state === 'sending'}
          onClick={() => submit('yes')}
        >
          {state === 'sending' ? 'Saving…' : 'Yes, still looking'}
        </button>
        <button
          type="button" className="btn btn-secondary"
          disabled={state === 'sending'}
          onClick={() => submit('no')}
        >
          No, hide my profile
        </button>
      </div>
    </div>
  )
}
