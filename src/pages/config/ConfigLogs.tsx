// UNIFIED admin page (POC for the admin-surface unification).
//
// This file is byte-identical in the self-hosted SPA and the hosted WebApp. It
// reaches its server ONLY through useAdminDataSource(), so it carries no
// app-specific fetch layer: the self-hosted app binds the hook to a same-origin
// request, the hosted app binds it to the active linked server. To share this
// page, the two apps keep an identical copy (a future @hearthshelf/admin-ui
// package would host the single copy); the seam that makes that possible is the
// data-source hook, not the page.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import type { ABSLogEntry, ABSLoggerData, HSAppLogResponse } from '@hearthshelf/core'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useAdminDataSource } from '@/admin/adminDataSource'

const LEVEL_LABEL: Record<number, string> = {
  0: 'TRACE',
  1: 'DEBUG',
  2: 'INFO',
  3: 'WARN',
  4: 'ERROR',
  5: 'FATAL',
}

// Trim the date off an ISO-ish timestamp so the column stays narrow - the log is
// one day's worth, and the header already says which. Falls back to the raw
// value for anything that isn't the expected shape.
function clockOf(timestamp: string): string {
  const m = /\d{2}:\d{2}:\d{2}(?:\.\d+)?/.exec(timestamp)
  return m ? m[0] : timestamp
}

function LogView({ logs, className }: { logs: ABSLogEntry[]; className?: string }) {
  return (
    <div className={'log-box' + (className ? ' ' + className : '')}>
      {logs.map((l, i) => {
        const level = l.level != null ? (LEVEL_LABEL[l.level] ?? String(l.level)) : ''
        return (
          <div className="log-line" key={i}>
            <span className="ts" title={l.timestamp}>
              {clockOf(l.timestamp)}
            </span>
            <span className={'lv ' + level.toLowerCase()}>{level}</span>
            <span className="src" title={l.source ?? undefined}>
              {l.source ?? ''}
            </span>
            <span className="msg">{l.message}</span>
          </div>
        )
      })}
    </div>
  )
}

// Flatten the log lines to plain text and hand the browser a .log download.
function downloadLogs(logs: ABSLogEntry[]) {
  const text = logs
    .map((l) => {
      const lvl = l.level != null ? ` [${LEVEL_LABEL[l.level] ?? l.level}]` : ''
      const source = l.source ? ` [${l.source}]` : ''
      return `${l.timestamp}${lvl}${source} ${l.message}`
    })
    .join('\n')
  const date = new Date().toISOString().slice(0, 10)
  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `hearthshelf-${date}.log`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function ConfigLogs() {
  const { request } = useAdminDataSource()
  const { data } = useQuery({
    queryKey: ['admin', 'logs'],
    queryFn: () => request<ABSLoggerData>('/api/logger-data'),
    staleTime: 10 * 1000,
  })
  // HearthShelf's own app-log ring (backend warnings/errors surfaced in the UI).
  // Kept in a separate query so an older server without /hs/logs still shows the
  // ABS logs. Best-effort: a failure yields no HS lines rather than an error.
  const { data: hearthShelfData } = useQuery({
    queryKey: ['admin', 'hearthshelf-logs'],
    queryFn: () => request<HSAppLogResponse>('/hs/logs').catch(() => ({ logs: [] })),
    refetchInterval: 10 * 1000,
  })
  const [enlarged, setEnlarged] = useState(false)

  const logs = [...(data?.currentDailyLogs ?? []), ...(hearthShelfData?.logs ?? [])].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  )

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Admin</div>
        <h1 className="title-xl">Logs</h1>
        {data && <p className="page-sub">AudiobookShelf + HearthShelf logs · {logs.length} lines</p>}
      </div>

      {!data ? (
        <LoadingSpinner className="py-12" label="Loading logs..." />
      ) : (
        <>
          <div className="log-toolbar">
            <button
              className="btn-sm btn-ghost"
              disabled={!logs.length}
              onClick={() => downloadLogs(logs)}
            >
              <Icon name="download" /> Download
            </button>
            <button className="btn-sm btn-ghost" onClick={() => setEnlarged(true)}>
              <Icon name="open_in_full" /> Enlarge
            </button>
          </div>
          <LogView logs={logs} />
        </>
      )}

      {/* Portalled to <body> deliberately. This page renders inside
          .page.config-wrap.fade-in, whose `animation: fadeIn ... both` leaves a
          transform applied for good - and a transformed ancestor becomes the
          containing block for position:fixed. Rendered inline, the scrim would
          size to .config-wrap's 1180px max-width instead of the viewport and
          the enlarged log would sit off-screen. */}
      {enlarged &&
        createPortal(
          <div className="modal-scrim open" onClick={() => setEnlarged(false)}>
            <div className="modal modal-xl" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <Icon name="terminal" />
                <h2>Server log · {logs.length} lines</h2>
                <button
                  className="btn-sm btn-ghost"
                  disabled={!logs.length}
                  onClick={() => downloadLogs(logs)}
                >
                  <Icon name="download" /> Download
                </button>
                <button className="modal-nav-btn" onClick={() => setEnlarged(false)}>
                  <Icon name="close" />
                </button>
              </div>
              <div className="modal-body">
                <LogView logs={logs} className="log-box-fill" />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
