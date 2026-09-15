/**
 * Which roles the "is there a session" hint cookie says are signed in.
 *
 * The hint used to hold a single role — `recruiter` or `candidate` — so signing
 * into one role overwrote the other, and refreshing the other role's page found
 * no session and showed the sign-in card without asking the server. It now holds
 * a comma-separated list.
 *
 * A single role is a one-item list, so every browser already holding the old
 * value keeps working unchanged; nobody is signed out by this format changing.
 *
 * Plain JavaScript with no browser globals, so the server tests can import the
 * same parser the page uses rather than a copy that might disagree with it.
 */
export const ROLES = ['candidate', 'recruiter']

export function rolesInHint(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    /* Only real roles. The hint is readable and forgeable by design — it is
       never a credential — but it should only ever be able to name a role that
       exists, not smuggle a new one into the UI's decisions. */
    .filter((part, index, all) => ROLES.includes(part) && all.indexOf(part) === index)
}
