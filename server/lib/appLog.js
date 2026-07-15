// Small in-process HearthShelf log ring for Admin > Logs. Container stdout remains
// the durable/operator log; this feed makes recent integration failures visible
// in the UI without persisting secrets or request payloads.
const MAX_ENTRIES = 500
const entries = []

function write(level, source, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    source,
    message: String(message).slice(0, 1000),
    level,
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)

  const line = `[${source}] ${entry.message}`
  if (level >= 4) console.error(line)
  else if (level === 3) console.warn(line)
  else console.log(line)
}

export const appLog = {
  info(source, message) {
    write(2, source, message)
  },
  warn(source, message) {
    write(3, source, message)
  },
  error(source, message) {
    write(4, source, message)
  },
  entries() {
    return [...entries]
  },
}
