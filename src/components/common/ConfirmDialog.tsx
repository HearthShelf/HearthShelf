import { Modal } from '@/components/common/Modal'
import { Icon } from '@/components/common/Icon'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

// A small confirmation overlay for state-changing admin actions. Destructive
// actions use the danger button styling.
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const foot = (
    <>
      <div style={{ flex: 1 }} />
      <button className="btn-sm btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <button
        className={'btn-sm ' + (danger ? 'btn-danger' : 'btn-green')}
        onClick={() => {
          onConfirm()
          onClose()
        }}
      >
        {danger && <Icon name="warning" />} {confirmLabel}
      </button>
    </>
  )
  return (
    <Modal title={title} onClose={onClose} foot={foot}>
      <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-muted)', margin: 0 }}>
        {message}
      </p>
    </Modal>
  )
}
