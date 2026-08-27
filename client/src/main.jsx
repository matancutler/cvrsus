import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App.jsx'
/*
 * The type, bundled rather than fetched: no third-party request to render a
 * page, and no flash of unstyled text when that third party is slow.
 *
 * Instrument Sans carries the interface. Instrument Serif appears only as an
 * italic accent inside display type and one or two emphasis paragraphs — the
 * same move the reference makes, and the single detail that reads as designed
 * rather than defaulted.
 */
import '@fontsource-variable/instrument-sans'
import '@fontsource/instrument-serif/400-italic.css'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
