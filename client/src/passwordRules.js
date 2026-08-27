/**
 * §17 — the password rules, as a checklist.
 *
 * Mirrors PASSWORD_RULES in server/src/index.js, which is what actually decides
 * whether a password is accepted; this copy exists so the rules can be shown
 * ticking off while somebody types rather than reported after a rejected
 * submit. The two must be changed together — the server is the authority, and
 * a client that drifted would promise something the server then refuses.
 */
export const PASSWORD_RULES = [
  { key: 'length', label: 'At least 8 characters', test: (value) => value.length >= 8 },
  { key: 'upper', label: 'One uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { key: 'digit', label: 'One number', test: (value) => /\d/.test(value) },
  {
    key: 'symbol',
    label: 'One special character',
    test: (value) => /[^A-Za-z0-9\s]/.test(value),
  },
]

export function passwordMeetsRules(value) {
  return PASSWORD_RULES.every((rule) => rule.test(String(value ?? '')))
}
