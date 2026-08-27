/**
 * Internal Slack notifications.
 *
 * The brief's dividing line, kept here so it is one decision rather than
 * fifteen: Slack is for acquisition, revenue, churn, safety and operational
 * failure. It is not an activity feed. Every routine product action — a search,
 * a message, a profile edit, the fourth reveal of the afternoon — goes to
 * analytics and nowhere else, because a channel that reports everything is a
 * channel nobody reads and the payment failure scrolls past unseen.
 *
 * Posted to SLACK_WEBHOOK_URL when one is configured, and written to the
 * console when not — the same shape the email side has, so the whole
 * notification surface is visible in development without any provider.
 */
const WEBHOOK = process.env.SLACK_WEBHOOK_URL ?? ''

/**
 * Fire and forget, deliberately.
 *
 * Nothing here is allowed to fail a request. A recruiter's purchase must not
 * roll back because Slack was slow, and a candidate must not fail to sign up
 * because a webhook URL was mistyped — so the promise is never awaited by
 * callers, every error is swallowed here, and a timeout gives up rather than
 * holding a connection open.
 */
export function notifySlack(title, fields = []) {
  const lines = [title, ...fields.filter((line) => line !== null && line !== undefined && line !== '')]
  const text = lines.join('\n')

  if (!WEBHOOK) {
    console.log('')
    console.log('  ┌─ slack ──────────────────────────────────────────────')
    for (const line of lines) console.log(`  │  ${line}`)
    console.log('  └──────────────────────────────────────────────────────')
    console.log('')
    return Promise.resolve({ delivered: 'console' })
  }

  return fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5000),
  })
    .then(() => ({ delivered: 'slack' }))
    .catch((error) => {
      /* Logged rather than raised. A notification that failed to send is worth
         knowing about; it is not worth undoing what it was reporting. */
      console.warn(`  Slack notification failed: ${error.message}`)
      return { delivered: 'failed' }
    })
}

/** The timestamp every message ends on, in one format. */
export function stamp(at = new Date()) {
  return at.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}
