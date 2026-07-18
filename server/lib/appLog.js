// Small in-process HearthShelf log ring for Admin > Logs. Container stdout remains
// the durable/operator log; this feed makes recent integration failures visible
// in the UI without persisting secrets or request payloads.
const MAX_ENTRIES = 500
const entries = []

// Set true while write() is emitting to console, so the console-capture backstop
// (installConsoleCapture) doesn't re-ingest our own mirrored line into the ring
// and loop forever. Module-scoped because both live in this file.
let emitting = false

function push(level, source, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    source,
    message: String(message).slice(0, 1000),
    level,
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  return entry
}

function write(level, source, message) {
  const entry = push(level, source, message)
  const line = `[${source}] ${entry.message}`
  emitting = true
  try {
    if (level >= 4) console.error(line)
    else if (level === 3) console.warn(line)
    else console.log(line)
  } finally {
    emitting = false
  }
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

// A leading "[tag]" in a raw console line is a source; pull it out so captured
// lines show a clean [tag] source in the UI instead of a generic 'stdout'. Most
// of our modules already prefix their logs this way (e.g. "[hosted] ...").
function splitTag(message) {
  const m = /^\[([a-z0-9_-]{1,24})\]\s*(.*)$/is.exec(String(message))
  if (m) return { source: m[1], text: m[2] }
  return { source: 'stdout', text: String(message) }
}

// Fold a console.* argument list into one string the way console does (space
// separated), so captured entries read like the stdout line. Errors keep their
// message + stack; objects are JSON where possible, else String()'d.
function stringifyArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

// Mirror every console.warn/console.error into the ring so the Web UI log view
// and container stdout can never silently diverge again. Only warn+ is captured:
// info/debug chatter would flood the 500-entry ring and isn't operator-relevant.
// Modules that want a clean source label + INFO level should still call appLog
// directly; this is the backstop for the ~all raw console.* sites (and any future
// or third-party ones). Idempotent - installing twice is a no-op.
let installed = false
export function installConsoleCapture() {
  if (installed) return
  installed = true
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)

  console.warn = (...args) => {
    if (!emitting) {
      const { source, text } = splitTag(stringifyArgs(args))
      push(3, source, text)
    }
    origWarn(...args)
  }
  console.error = (...args) => {
    if (!emitting) {
      const { source, text } = splitTag(stringifyArgs(args))
      push(4, source, text)
    }
    origError(...args)
  }
}
