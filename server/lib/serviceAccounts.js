// HearthShelf-tracked service accounts (instance-wide, single row id=1).
//
// A "service account" is just an ABS admin/root user - ABS has no native concept
// of one. HearthShelf frames a subset of ABS users as machine accounts in its
// Config UI: the auto-created service root (provisioning.root_username) plus any
// account an admin explicitly creates from the Service Accounts page. This module
// persists that second set - the list of ABS user ids HearthShelf minted as
// service accounts - so they stay out of the human Users list and grouped under
// Service Accounts across devices and restarts.
//
// It stores only ids. The accounts themselves (and their API keys) live in ABS;
// HearthShelf never duplicates that data.

import { db, initDb } from '../db.js'

let ready = null
async function ensureRow() {
  if (ready) return ready
  ready = (async () => {
    await initDb()
    const r = await db.execute('SELECT id FROM service_accounts WHERE id = 1')
    if (r.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO service_accounts (id, ids_json, updated_at) VALUES (1, '[]', ?)`,
        args: [Date.now()],
      })
    }
  })()
  return ready
}

// The tracked ABS user ids, as a string array (never the auto-created root - that
// one is implied by provisioning.root_username and handled by the caller).
export async function getServiceAccountIds() {
  await ensureRow()
  const r = await db.execute('SELECT ids_json FROM service_accounts WHERE id = 1')
  try {
    const parsed = JSON.parse(r.rows[0]?.ids_json ?? '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

async function writeIds(ids) {
  await ensureRow()
  // De-dupe and drop falsy ids defensively before persisting.
  const unique = Array.from(new Set(ids.filter(Boolean).map(String)))
  await db.execute({
    sql: `UPDATE service_accounts SET ids_json = ?, updated_at = ? WHERE id = 1`,
    args: [JSON.stringify(unique), Date.now()],
  })
  return unique
}

export async function addServiceAccountId(userId) {
  const cur = await getServiceAccountIds()
  return writeIds([...cur, userId])
}

export async function removeServiceAccountId(userId) {
  const cur = await getServiceAccountIds()
  return writeIds(cur.filter((id) => id !== String(userId)))
}
