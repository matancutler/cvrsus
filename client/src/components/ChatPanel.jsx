import { useEffect, useRef, useState } from 'react'
import { SendIcon } from './CommentsPopover.jsx'
import { DATE_LOCALE } from '../dates.js'

/**
 * One conversation. `meSender` says which side "you" are, so the same component
 * renders correctly for the candidate and for the recruiter.
 */
export default function ChatPanel({
  messages = [],
  meSender,
  onSend,
  sending = false,
  emptyText = 'No messages yet.',
  placeholder = 'Write a message…',
  disabled = false,
}) {
  const [draft, setDraft] = useState('')
  const logRef = useRef(null)

  /*
   * Keep the newest message in view as the thread grows — and nothing else.
   *
   * This used to be scrollIntoView on a marker at the foot of the log. That
   * scrolls every scrollable ancestor, not just the one the element sits in,
   * so opening a candidate whose thread had messages in it hauled the whole
   * dialog down to the conversation: the profile arrived already scrolled past
   * the name, the contact details and the folder it was filed under.
   *
   * Setting scrollTop on the log itself moves the log and stops there.
   */
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages.length])

  async function submit(event) {
    event.preventDefault()
    const body = draft.trim()
    if (!body || sending) return

    await onSend(body)
    setDraft('')
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && <p className="muted chat-empty">{emptyText}</p>}

        {messages.map((message) => (
          <div
            key={message.id}
            className={message.sender === meSender ? 'bubble bubble-mine' : 'bubble bubble-theirs'}
          >
            <p>{message.body}</p>
            <time dateTime={message.created_at}>
              {new Date(message.created_at).toLocaleString(DATE_LOCALE, {
                dateStyle: 'medium', timeStyle: 'short',
              })}
            </time>
          </div>
        ))}
      </div>

      {!disabled && (
        <form className="chat-compose" onSubmit={submit}>
          <textarea
            rows={2}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter makes a new line.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(e)
              }
            }}
          />
          {/* The mark, not the word: a paper plane is what every messaging
              product sends with, and it leaves the width for the message. */}
          <button
            type="submit"
            className="btn btn-primary chat-send"
            disabled={sending || draft.trim() === ''}
            aria-label={sending ? 'Sending' : 'Send'}
            title="Send"
          >
            <SendIcon size={17} />
          </button>
        </form>
      )}
    </div>
  )
}
