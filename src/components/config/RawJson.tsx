import { useState } from 'react'
import { Icon } from '@/components/common/Icon'

// A collapsed raw-JSON dump for debug surfaces.
//
// Every debugger renders a curated view, and a curated view is a guess about
// which fields matter. When the guess is wrong the raw payload is the only way
// to see how the data actually hangs together - so each debug page ends with
// one of these, copyable in a click for pasting into an issue.
//
// Collapsed by default: these payloads run to hundreds of lines and would bury
// the readable report above them.
export function RawJson({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = JSON.stringify(value, null, 2)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard is unavailable over plain http on a LAN address; the payload
      // is still selectable by hand, so this needs no error surface.
    }
  }

  return (
    <section className="cfg-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          className="btn-sm btn-ghost"
          onClick={() => setOpen((v) => !v)}
          style={{ flex: 1, justifyContent: 'flex-start' }}
        >
          <Icon name={open ? 'expand_less' : 'expand_more'} /> {label}
        </button>
        <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
          {(text.length / 1024).toFixed(1)} KB
        </span>
        <button className="btn-sm btn-ghost" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'content_copy'} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {open && (
        <pre
          style={{
            marginTop: 10,
            marginBottom: 0,
            maxHeight: 460,
            overflow: 'auto',
            fontSize: 11.5,
            lineHeight: 1.5,
            background: 'var(--bg-sunken, rgba(0,0,0,.18))',
            borderRadius: 8,
            padding: 12,
          }}
        >
          {text}
        </pre>
      )}
    </section>
  )
}
