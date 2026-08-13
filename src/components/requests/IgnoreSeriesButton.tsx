import { useState } from 'react'
import { Icon } from '@/components/common/Icon'
import { useDismissalsStore } from '@/store/dismissalsStore'

interface IgnoreSeriesButtonProps {
  // ABS series id - what a series ignore keys on. Unlike a follow (which needs
  // an Audible ASIN), ignoring works on any series in the library, including one
  // that never resolved against Audible.
  seriesId: string | undefined
  // The series name, cached as a label so the Settings restore list can show a
  // real name instead of a bare id.
  seriesName?: string
  // Icon-only rendering for tight rows, where the label would not fit. The
  // tooltip and aria-label still carry the meaning.
  compact?: boolean
}

// Ignore a series: "no interest". It stops being suggested - the Auto queue,
// Continue Series, Discover, and QuestGiver all skip it - but it stays in the
// library and in search. The paired control to Follow, and rendered beside it.
export function IgnoreSeriesButton({ seriesId, seriesName, compact }: IgnoreSeriesButtonProps) {
  const ignored = useDismissalsStore((s) => (seriesId ? s.seriesIds.includes(seriesId) : false))
  const dismiss = useDismissalsStore((s) => s.dismiss)
  const restore = useDismissalsStore((s) => s.restore)
  const [busy, setBusy] = useState(false)

  if (!seriesId) return null

  const label = ignored ? 'Ignored' : 'Ignore series'
  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (ignored) await restore('series', seriesId)
      else await dismiss('series', seriesId, seriesName)
    } catch {
      // The store already rolled back; the button reflects the real state.
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      className={'pill' + (ignored ? ' on' : '')}
      onClick={() => void onClick()}
      disabled={busy}
      title={
        ignored
          ? 'Not suggested to you. Still in your library - click to un-ignore'
          : 'Stop suggesting this series. It stays in your library'
      }
      aria-pressed={ignored}
      aria-label={label}
    >
      <Icon name={ignored ? 'visibility_off' : 'visibility'} fill={ignored} />
      {!compact && ' ' + label}
    </button>
  )
}
