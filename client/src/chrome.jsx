import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Whether the site's own chrome — marketing header, legal footer — is showing.
 *
 * Signed out, every route is part of a website: someone is deciding whether to
 * use this, so About, Pricing, Contact and Sign in are the most useful things
 * on the screen. Signed in, none of that is true any more. A recruiter working
 * through a shortlist is not shopping, and a nav bar offering to sell them the
 * product they are already inside is noise wrapped around their workspace.
 *
 * So the shell is a function of session, not of route: /hr and /account each
 * render a public sign-in screen first and a portal afterwards, and only the
 * page itself knows which it is currently showing. It declares that with
 * usePortalChrome, and App reads it here.
 */
const ChromeContext = createContext({ portal: false, setPortal: () => {} })

export function ChromeProvider({ children }) {
  const [portal, setPortal] = useState(false)
  return (
    <ChromeContext.Provider value={{ portal, setPortal }}>
      {children}
    </ChromeContext.Provider>
  )
}

export function useChrome() {
  return useContext(ChromeContext)
}

/**
 * Declares that this page is currently a portal, and stops on the way out.
 *
 * The cleanup is what matters: signing out, or navigating from the workspace to
 * the public site, has to bring the header back. Tying that to unmount rather
 * than to a sign-out handler means it cannot be forgotten at a new exit.
 */
export function usePortalChrome(active) {
  const { setPortal } = useChrome()

  useEffect(() => {
    setPortal(active)
    return () => setPortal(false)
  }, [active, setPortal])
}
