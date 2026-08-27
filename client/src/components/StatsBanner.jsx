import { useEffect, useState } from 'react'

import { get } from '../api.js'

/**
 * How many people have joined, and how many companies are hiring here.
 *
 * The figures are real and read live. Two rules follow from that:
 *
 * It renders nothing until the server says the numbers are worth showing.
 * Social proof is a factual claim to everyone who reads it, and "3 candidates"
 * is proof of the opposite — a marketplace advertising that it is empty. Better
 * to say nothing than to say something discouraging or, worse, to invent a
 * number a visitor could disprove the moment they join.
 *
 * And it fails silently. A stats endpoint that is down is not a reason to put
 * an error where the reassurance was meant to go.
 */
export default function StatsBanner() {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    let live = true
    get('/api/stats')
      .then((data) => { if (live) setStats(data) })
      .catch((error) => {
        // Still nothing on screen — a down endpoint must not put an error where
        // the reassurance goes. But it says so in the console: swallowing this
        // entirely made "the banner is missing" impossible to tell apart from
        // "the banner is hidden on purpose".
        console.warn(`Cursus: stats unavailable, banner hidden — ${error.message}`)
      })
    return () => { live = false }
  }, [])

  // The server decides when the numbers are worth showing, so the threshold can
  // move without rebuilding this page. `ready` is false until then.
  if (!stats?.ready) {
    if (stats) {
      console.info(
        `Cursus: stats banner hidden — ${stats.candidates} candidate(s), `
        + `${stats.companies} company(ies), minimum ${stats.minimum}. `
        + 'Set STATS_MIN in server/.env to change this.',
      )
    }
    return null
  }

  const format = (n) => Number(n).toLocaleString()

  return (
    <section className="stats-banner" aria-label="Cursus in numbers">
      <div className="stat-figure">
        <span className="stat-number">{format(stats.candidates)}</span>
        <span className="stat-caption">
          {stats.candidates === 1 ? 'person has joined' : 'people have joined'} and uploaded a CV
        </span>
      </div>

      <div className="stat-figure">
        <span className="stat-number">{format(stats.companies)}</span>
        <span className="stat-caption">
          {stats.companies === 1 ? 'company is hiring' : 'companies are hiring'} on Cursus
        </span>
      </div>
    </section>
  )
}
