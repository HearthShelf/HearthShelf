import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from '@/components/common/Modal'
import { Icon } from '@/components/common/Icon'
import { useSubmitRequest, useRmabEnabled } from '@/hooks/useRmab'
import { audibleStoreUrl } from '@/api/audible'
import type { RmabRequest } from '@/api/requests'
import type { CatalogResult } from '@/components/requests/RequestTile'

interface RequestConfirmModalProps {
  book: CatalogResult
  // Whether the request backend can fulfill this book. Gates the Request action.
  // Defaults to the live RMAB status when the caller doesn't pass it.
  canRequest?: boolean
  // Open on a "you don't own this book" step (Close / Open Audible / Request)
  // before the request confirm. Series-missing rows use this; search surfaces,
  // where the user already tapped "Request", skip straight to confirm.
  intro?: boolean
  onClose: () => void
}

// Maps RMAB's POST /api/requests outcome to a human line. A request either auto-
// approves (status downloading/searching/pending) or needs an admin (awaiting_
// approval), so we branch the success copy on the returned request status.
function isAwaitingApproval(req?: RmabRequest): boolean {
  return req?.status === 'awaiting_approval'
}

const ERROR_COPY: Record<string, string> = {
  AlreadyAvailable: 'That title is already in your library.',
  BeingProcessed: 'That title is already being processed.',
  DuplicateRequest: "You've already requested that title.",
  Ignored: 'That title is on your ignore list.',
  UserNotFound: "Couldn't find the requesting account on ReadMeABook.",
}

export function RequestConfirmModal({
  book,
  canRequest: canRequestProp,
  intro = false,
  onClose,
}: RequestConfirmModalProps) {
  const navigate = useNavigate()
  const rmabEnabled = useRmabEnabled()
  const canRequest = canRequestProp ?? rmabEnabled
  const submit = useSubmitRequest()
  const [phase, setPhase] = useState<'intro' | 'confirm'>(intro ? 'intro' : 'confirm')
  const [result, setResult] = useState<RmabRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  const confirm = () => {
    setError(null)
    submit.mutate(
      {
        asin: book.asin,
        title: book.title,
        author: book.author,
        narrator: book.narrator,
        description: book.description,
        coverArtUrl: book.coverArtUrl,
      },
      {
        onSuccess: (res) => {
          if (res.success && res.request) setResult(res.request)
          else setError(ERROR_COPY[res.error ?? ''] ?? 'Request failed. Please try again.')
        },
        onError: (e) => {
          // rmabFetch throws "RMAB <status>"; surface a mapped message when we can.
          const code = String(e)
            .replace(/^Error:\s*/, '')
            .replace('RMAB ', '')
          setError(ERROR_COPY[code] ?? "Couldn't reach ReadMeABook. Please try again.")
        },
      },
    )
  }

  const approved = !isAwaitingApproval(result ?? undefined)

  const bookHead = (note?: string) => (
    <div className="rc-top">
      {book.coverArtUrl ? (
        <img className="cover" src={book.coverArtUrl} alt="" />
      ) : (
        <div className="cover" style={{ background: 'var(--c-highest)' }} />
      )}
      <div style={{ minWidth: 0 }}>
        <h2 className="rc-h">{book.title}</h2>
        <div className="rc-sub">{book.author}</div>
        {book.narrator && (
          <div className="rc-sub" style={{ marginTop: 2 }}>
            Narrated by {book.narrator}
          </div>
        )}
        {note && (
          <div className="rmab-via" style={{ marginTop: 10 }}>
            <Icon name="bolt" fill /> {note}
          </div>
        )}
      </div>
    </div>
  )

  // Result phase: request submitted.
  if (result) {
    return (
      <Modal
        title={approved ? 'Requested' : 'Waiting for approval'}
        onClose={onClose}
        foot={
          <>
            <button className="req-btn ghost" onClick={onClose}>
              Done
            </button>
            <button
              className="req-btn"
              onClick={() => {
                onClose()
                navigate('/requests')
              }}
            >
              <Icon name="receipt_long" /> View requests
            </button>
          </>
        }
      >
        <div className="rc-success">
          <div
            className="ok"
            style={{
              background: `color-mix(in oklab, ${approved ? '#5a9c52' : '#d9a45a'} 20%, transparent)`,
              color: approved ? '#5a9c52' : '#d9a45a',
            }}
          >
            <Icon name={approved ? 'cloud_download' : 'schedule'} fill />
          </div>
          <h3>{approved ? 'Requested' : 'Waiting for approval'}</h3>
          <p>
            {approved
              ? `We'll add ${book.title} to your library when it's ready.`
              : `Your request for ${book.title} was sent - an admin needs to approve it before it downloads.`}
          </p>
        </div>
      </Modal>
    )
  }

  // Confirm phase: reached only via Request.
  if (phase === 'confirm') {
    return (
      <Modal
        title="Request audiobook"
        onClose={onClose}
        foot={
          <>
            <button
              className="req-btn ghost"
              onClick={() => (intro ? setPhase('intro') : onClose())}
              disabled={submit.isPending}
            >
              {intro ? 'Back' : 'Cancel'}
            </button>
            <button className="req-btn" onClick={confirm} disabled={submit.isPending}>
              <Icon name="add" /> {submit.isPending ? 'Requesting...' : 'Request'}
            </button>
          </>
        }
      >
        {bookHead('via ReadMeABook')}
        <p className="rc-note">
          ReadMeABook will search for it, download it, and add it to your HearthShelf library
          automatically. You'll see live status under Requests.
        </p>
        {error && (
          <div className="rr-err" style={{ marginTop: 12 }}>
            <Icon name="error" fill /> {error}
          </div>
        )}
      </Modal>
    )
  }

  // Intro phase: "you don't own this book".
  return (
    <Modal
      title="You don't own this book"
      onClose={onClose}
      foot={
        <>
          <button className="req-btn ghost" onClick={onClose}>
            Close
          </button>
          <a
            className="req-btn ghost"
            href={audibleStoreUrl(book)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="open_in_new" /> Open Audible
          </a>
          {canRequest && (
            <button className="req-btn" onClick={() => setPhase('confirm')}>
              <Icon name="bolt" fill /> Request
            </button>
          )}
        </>
      }
    >
      {bookHead()}
      <p className="rc-note">
        {book.title} isn't in your library yet.
        {canRequest
          ? ' Request it through ReadMeABook, or open it on Audible.'
          : ' You can open it on Audible.'}
      </p>
    </Modal>
  )
}
