/**
 * Loads server/.env whatever directory the script was started from.
 *
 * `import 'dotenv/config'` reads .env relative to process.cwd(), which is
 * right for the server — `npm start` runs it as `npm run start -w server`, so
 * the working directory is server/ and server/.env is found. It is wrong for
 * every script in this folder, because those are run from the repository
 * root, where there is no .env at all.
 *
 * The symptom is not an error. dotenv finding nothing is silent, so the
 * script runs with an empty environment and reports whatever an empty
 * environment implies: `npm run ai:eval` said "No ANTHROPIC_API_KEY" with the
 * key sitting in the file beside it, which reads as a missing key rather than
 * a missing file and sends you to the Console to check a key that was fine.
 *
 * Resolved from this module's own location, so it does not matter where the
 * script is invoked from or which package manager invoked it.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))

dotenv.config({ path: path.join(here, '..', '.env') })

/* And the repository root, if anything is kept there — loaded second so a
   value already set by server/.env wins, which is dotenv's own rule. */
dotenv.config({ path: path.join(here, '..', '..', '.env') })
