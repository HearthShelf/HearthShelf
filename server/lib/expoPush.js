// Minimal Expo push sender. Posts to Expo's push API; no SDK dependency (one
// fetch). Handles chunking (Expo caps ~100 messages/request) and reports back
// tokens Expo rejected as DeviceNotRegistered so the caller can prune them.
//
// A message is { to, title, body, data }. `to` is an ExponentPushToken[...].
// See https://docs.expo.dev/push-notifications/sending-notifications/

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const CHUNK = 100

/**
 * Send push messages. Returns { sent, invalidTokens } where invalidTokens are
 * the `to` values Expo reported as DeviceNotRegistered (prune these). Never
 * throws for the caller - a transport failure just yields sent:0.
 */
export async function sendPushMessages(messages) {
  const list = (messages ?? []).filter((m) => m && typeof m.to === 'string' && m.to)
  if (list.length === 0) return { sent: 0, invalidTokens: [] }

  let sent = 0
  const invalidTokens = []
  for (let i = 0; i < list.length; i += CHUNK) {
    const batch = list.slice(i, i + CHUNK)
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      })
      if (!res.ok) continue
      const body = await res.json()
      const tickets = Array.isArray(body?.data) ? body.data : []
      tickets.forEach((t, idx) => {
        if (t?.status === 'ok') {
          sent++
        } else if (t?.details?.error === 'DeviceNotRegistered') {
          const to = batch[idx]?.to
          if (to) invalidTokens.push(to)
        }
      })
    } catch {
      // Transport failure for this batch; skip it.
    }
  }
  return { sent, invalidTokens }
}
