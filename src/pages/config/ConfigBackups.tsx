import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getBackups, runBackup, adminKeys } from '@/api/admin'
import { Icon } from '@/components/common/Icon'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

function fmtBytes(b: number): string {
  const mb = b / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

export function ConfigBackups() {
  const qc = useQueryClient()
  const [confirmRun, setConfirmRun] = useState(false)
  const [running, setRunning] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: adminKeys.backups,
    queryFn: getBackups,
    staleTime: 60 * 1000,
  })

  const backups = data?.backups ?? []

  const doRun = async () => {
    setRunning(true)
    try {
      await runBackup()
      qc.invalidateQueries({ queryKey: adminKeys.backups })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="page-head-row">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="title-xl">Backups</h1>
        </div>
        <button
          className="btn-sm btn-accent"
          disabled={running}
          onClick={() => setConfirmRun(true)}
        >
          <Icon name="cloud_sync" /> {running ? 'Backing up…' : 'Back up now'}
        </button>
      </div>

      {isLoading && <LoadingSpinner className="py-12" label="Loading backups..." />}
      {isError && <ErrorState message="Could not load backups." onRetry={refetch} />}

      {data && (
        <>
          {data.backupLocation && (
            <p
              className="page-sub"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
            >
              {data.backupLocation}
            </p>
          )}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Backup</th>
                  <th>Server</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 600 }}>{b.datePretty}</td>
                    <td className="num">{b.serverVersion}</td>
                    <td className="num">{fmtBytes(b.fileSize)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirmRun && (
        <ConfirmDialog
          title="Run a backup"
          message="Create a new backup of your AudiobookShelf data now? This may take a moment."
          confirmLabel="Back up now"
          onConfirm={() => void doRun()}
          onClose={() => setConfirmRun(false)}
        />
      )}
    </>
  )
}
