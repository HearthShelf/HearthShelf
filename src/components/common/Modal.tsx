import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/common/Icon'

interface ModalProps {
  title: string
  onClose: () => void
  tabs?: string[]
  tab?: string
  setTab?: (t: string) => void
  foot?: ReactNode
  onPrev?: () => void
  onNext?: () => void
  children: ReactNode
}

// The shared overlay shell. Renders through a portal above the routed page so
// the router never changes and the PlayerBar/AudioEngine stay mounted. Enters
// on the next frame; Escape / backdrop / close button dismiss after the 250ms
// exit transition.
export function Modal({
  title,
  onClose,
  tabs,
  tab,
  setTab,
  foot,
  onPrev,
  onNext,
  children,
}: ModalProps) {
  const [open, setOpen] = useState(false)

  const close = useCallback(() => {
    setOpen(false)
    window.setTimeout(onClose, 250)
  }, [onClose])

  useEffect(() => {
    const r = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(r)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return createPortal(
    <div className={'modal-scrim' + (open ? ' open' : '')} onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {onPrev && (
            <button className="modal-nav-btn" onClick={onPrev}>
              <Icon name="chevron_left" />
            </button>
          )}
          <h2>{title}</h2>
          {onNext && (
            <button className="modal-nav-btn" onClick={onNext}>
              <Icon name="chevron_right" />
            </button>
          )}
          <button className="modal-nav-btn" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        {tabs && setTab && (
          <div className="modal-tabs">
            {tabs.map((t) => (
              <button
                key={t}
                className={'modal-tab' + (tab === t ? ' on' : '')}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body
  )
}
