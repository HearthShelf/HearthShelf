import { useState } from 'react'
import { Icon } from '@/components/common/Icon'
import { Cover } from '@/components/common/Cover'
import type { QgFeedback } from '@/api/questgiver'
import type { QgRenderedPick } from '@/lib/questgiver'

interface QuestGiverResultCardProps {
  pick: QgRenderedPick
  onPlay: (itemId: string) => void
  onDetails: (itemId: string) => void
  feedback?: QgFeedback
  onVote: (key: string, vote: 1 | -1 | 0) => void
  onNote: (key: string, note: string) => void
}

export function QuestGiverResultCard({
  pick,
  onPlay,
  onDetails,
  feedback,
  onVote,
  onNote,
}: QuestGiverResultCardProps) {
  const fb = feedback ?? {}
  const [noteOpen, setNoteOpen] = useState(false)
  const [draft, setDraft] = useState(fb.note ?? '')

  return (
    <div className="qg-rcard">
      <div className="qg-rglow" />
      <Cover
        itemId={pick.itemId ?? ''}
        title={pick.title}
        author={pick.author}
        kicker={pick.genre}
        fs={8}
        className="qg-rcover"
      />
      <div className="qg-rbody">
        <div className="qg-rkind">
          {pick.kind === 'library' && (
            <span className="qg-tag lib">
              <Icon name="library_books" /> In your library
            </span>
          )}
          {pick.kind === 'request' && (
            <span className="qg-tag req">
              <Icon name="bolt" fill /> Add via ReadMeABook
            </span>
          )}
          {pick.kind === 'new' && (
            <span className="qg-tag new">
              <Icon name="auto_awesome" fill /> New to your shelf
            </span>
          )}
          <span className="qg-rgenre">{pick.genre}</span>
          {pick.priorCount > 0 && (
            <span className="qg-rep" title="Recommended in earlier runs">
              <Icon name="history" /> {pick.priorCount}x before
            </span>
          )}
        </div>
        <div className="qg-rtitle">{pick.title}</div>
        <div className="qg-rauthor">
          {pick.author}
          {pick.hours ? ' · ' + pick.hours + 'h' : ''}
        </div>
        <p className="qg-rwhy">{pick.reason}</p>
        {pick.kind === 'library' && pick.itemId && (
          <div className="qg-ractions">
            <button className="qg-btn" onClick={() => onPlay(pick.itemId as string)} type="button">
              <Icon name="play_arrow" fill /> Start listening
            </button>
            <button
              className="qg-btn ghost"
              onClick={() => onDetails(pick.itemId as string)}
              type="button"
            >
              <Icon name="info" /> Details
            </button>
          </div>
        )}
        <div className="qg-feedback">
          <button
            className={'qg-vote' + (fb.vote === 1 ? ' up' : '')}
            title="Good pick"
            onClick={() => onVote(pick.key, fb.vote === 1 ? 0 : 1)}
            type="button"
          >
            <Icon name="thumb_up" fill={fb.vote === 1} />
          </button>
          <button
            className={'qg-vote' + (fb.vote === -1 ? ' down' : '')}
            title="Not for me"
            onClick={() => onVote(pick.key, fb.vote === -1 ? 0 : -1)}
            type="button"
          >
            <Icon name="thumb_down" fill={fb.vote === -1} />
          </button>
          <button
            className="qg-note-btn"
            onClick={() => {
              setDraft(fb.note ?? '')
              setNoteOpen((o) => !o)
            }}
            type="button"
          >
            <Icon name="edit_note" /> {fb.note ? 'Edit note' : 'Add note'}
          </button>
        </div>
        {noteOpen && (
          <div className="qg-note-edit">
            <textarea
              className="qg-note-field"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What worked, or why this isn't for you..."
              rows={2}
            />
            <button
              className="qg-btn ghost"
              onClick={() => {
                onNote(pick.key, draft.trim())
                setNoteOpen(false)
              }}
              type="button"
            >
              <Icon name="check" /> Save note
            </button>
          </div>
        )}
        {!noteOpen && fb.note && (
          <div
            className="qg-note-saved"
            onClick={() => {
              setDraft(fb.note ?? '')
              setNoteOpen(true)
            }}
          >
            <Icon name="sticky_note_2" fill /> &ldquo;{fb.note}&rdquo;
          </div>
        )}
      </div>
    </div>
  )
}
