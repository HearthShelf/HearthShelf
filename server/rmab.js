// ReadMeABook (RMAB) proxy. RMAB is HearthShelf's optional audiobook-acquisition
// backend - an internal-only service. HearthShelf holds a single RMAB API token
// (rmab_ prefixed) server-side and forwards the small allowlisted surface RMAB
// exposes to API tokens:
//   GET  /api/audiobooks/search   - catalog search
//   POST /api/requests            - submit an acquisition request
//   GET  /api/requests            - list requests + status
//   GET  /api/requests/:id        - single request status
//
// The token never reaches the browser. The caller is already identified by their
// ABS token upstream (see authUser in index.js); RMAB sees one service account.
//
// Env: RMAB_URL (e.g. http://rmab:3030), RMAB_TOKEN (rmab_... API token).

const TIMEOUT_MS = 20000

function rmabUrl() {
  return (process.env.RMAB_URL || '').replace(/\/$/, '')
}

export function isRmabConfigured() {
  return Boolean(rmabUrl() && process.env.RMAB_TOKEN)
}

export function rmabInfo() {
  return { configured: isRmabConfigured() }
}

// Forward a request to RMAB with the service token. Returns { status, body }.
// `body` is parsed JSON (or null). Throws only on network/timeout.
export async function rmabFetch(method, path, body) {
  if (!isRmabConfigured()) throw new Error('rmab_not_configured')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${rmabUrl()}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RMAB_TOKEN}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
    })
    let parsed = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  } finally {
    clearTimeout(t)
  }
}
