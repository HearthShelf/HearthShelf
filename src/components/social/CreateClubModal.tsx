import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createClub, clubsKeys, type ClubVisibility } from '@/api/clubs'
import type { HSClub } from '@hearthshelf/core'
import { Modal } from '@/components/common/Modal'
import { Icon } from '@/components/common/Icon'

// Create-club modal. Seeds this book as the club's first current book, so the
// club opens already reading it. The creator becomes the owner.
export function CreateClubModal({
  libraryItemId,
  bookTitle,
  onClose,
  onCreated,
}: {
  libraryItemId: string
  bookTitle: string
  onClose: () => void
  onCreated?: (club: HSClub) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<ClubVisibility>('closed')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => createClub(name.trim(), libraryItemId, visibility),
    onSuccess: (club) => {
      qc.invalidateQueries({ queryKey: clubsKeys.forItem(libraryItemId) })
      onCreated?.(club)
      onClose()
    },
    onError: () => setError('Could not create the club. Try again.'),
  })

  const foot = (
    <>
      <div style={{ flex: 1 }} />
      <button className="btn-sm btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <button
        className="btn-sm btn-green"
        disabled={!name.trim() || create.isPending}
        onClick={() => {
          setError(null)
          create.mutate()
        }}
      >
        <Icon name="group_add" /> Create club
      </button>
    </>
  )

  return (
    <Modal title="Start a book club" onClose={onClose} foot={foot}>
      <div className="field full">
        <label>Club name</label>
        <input
          className="fld"
          placeholder="e.g. Thursday Night Listens"
          value={name}
          maxLength={120}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field full">
        <label>Who can join?</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {(['closed', 'public'] as const).map((choice) => (
            <button
              type="button"
              key={choice}
              className={visibility === choice ? 'btn-sm btn-green' : 'btn-sm btn-ghost'}
              onClick={() => setVisibility(choice)}
              aria-pressed={visibility === choice}
              style={{ minHeight: 44 }}
            >
              <Icon name={choice === 'closed' ? 'lock' : 'public'} />{' '}
              {choice === 'closed' ? 'Closed' : 'Public'}
            </button>
          ))}
        </div>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)', margin: '12px 0 0' }}>
        Your club starts by reading <b>{bookTitle}</b>. Members see each other's progress and can
        chat about the book as they listen.{' '}
        {visibility === 'closed'
          ? 'Readers join by invitation.'
          : 'Anyone on the server can find and join.'}
      </p>
      {error && (
        <div className="banner info" style={{ marginTop: 'var(--s4)' }}>
          <Icon name="error" /> {error}
        </div>
      )}
    </Modal>
  )
}
