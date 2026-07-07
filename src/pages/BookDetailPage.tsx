import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getItem, libraryKeys } from '@/api/libraries'
import { getFinishedBy, getListeningNow, socialKeys } from '@/api/social'
import { getMe, meKeys } from '@/api/me'
import { NotesSection } from '@/components/social/NotesSection'
import { ClubCard } from '@/components/social/ClubCard'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { useMarkFinished } from '@/hooks/useMarkFinished'
import { usePlayer } from '@/hooks/usePlayer'
import { usePlayerStore } from '@/store/playerStore'
import { useAuthStore } from '@/store/authStore'
import { useSettingsStore } from '@/store/settingsStore'
import { formatDuration, formatTimestamp, stripHtml } from '@/lib/format'
import type { ABSLibraryItemDetail } from '@/api/types'
import { Cover, tintFor } from '@/components/common/Cover'
import { Avatar } from '@/components/common/Avatar'
import { ImageZoomViewer } from '@/components/common/ImageZoomViewer'
import { Icon } from '@/components/common/Icon'
import { Stars } from '@/components/common/Stars'
import { Dropdown, MItem } from '@/components/common/Dropdown'
import { ItemEditModal } from '@/components/library/ItemEditModal'
import { AddToListMenu } from '@/components/library/AddToListMenu'
import { ChapterEditorModal } from '@/components/library/ChapterEditorModal'
import { useToast } from '@/hooks/useToast'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

type DetailTab = 'chapters' | 'tracks' | 'ebook' | 'files'

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(1)} MB`
}

// Deep links to external book sites, built from real ISBN/ASIN metadata, with
// a title+author search fallback. Which providers appear is a per-user choice
// (Settings -> Library), each defaulting to on.
function externalLinks(
  book: ABSLibraryItemDetail,
  enabled: { goodreads: boolean; audible: boolean; hardcover: boolean },
) {
  const m = book.media.metadata
  const author = m.authors[0]?.name ?? ''
  const q = encodeURIComponent(`${m.title ?? ''} ${author}`.trim())
  const links: { key: string; icon: string; label: string; href: string }[] = []
  if (enabled.goodreads) {
    links.push({
      key: 'goodreads',
      icon: 'menu_book',
      label: 'Goodreads',
      href: m.isbn
        ? `https://www.goodreads.com/search?q=${m.isbn}`
        : `https://www.goodreads.com/search?q=${q}`,
    })
  }
  if (enabled.audible) {
    links.push({
      key: 'audible',
      icon: 'headphones',
      label: 'Audible',
      href: m.asin
        ? `https://www.audible.com/pd/${m.asin}`
        : `https://www.audible.com/search?keywords=${q}`,
    })
  }
  if (enabled.hardcover) {
    links.push({
      key: 'hardcover',
      icon: 'auto_stories',
      label: 'Hardcover',
      href: `https://hardcover.app/search?q=${q}`,
    })
  }
  return links
}

export function BookDetailPage() {
  const { itemId } = useParams()
  const navigate = useNavigate()
  const { playItem, seek } = usePlayer()
  const progressById = useMediaProgress()
  const { markFinished, isPending: marking } = useMarkFinished()
  const sessionItemId = usePlayerStore((s) => s.libraryItemId)
  const token = useAuthStore((s) => s.token)
  const extGoodreads = useSettingsStore((s) => s.externalLinkGoodreads)
  const extAudible = useSettingsStore((s) => s.externalLinkAudible)
  const extHardcover = useSettingsStore((s) => s.externalLinkHardcover)
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<DetailTab>('chapters')
  const [editing, setEditing] = useState(false)
  const [editingChapters, setEditingChapters] = useState(false)
  const [zoomCover, setZoomCover] = useState(false)
  const { toast, show } = useToast()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: libraryKeys.item(itemId ?? ''),
    queryFn: () => getItem(itemId as string),
    enabled: Boolean(itemId),
    staleTime: 10 * 60 * 1000,
  })

  // Who finished this book (HearthShelf backend, reads ABS's db, privacy-
  // filtered). Degrades to unavailable when ABS's db isn't mapped, in which case
  // we hide the row entirely.
  const { data: finishedBy } = useQuery({
    queryKey: socialKeys.finishedBy(itemId ?? ''),
    queryFn: () => getFinishedBy(itemId as string),
    enabled: Boolean(itemId),
    staleTime: 5 * 60 * 1000,
  })

  // Who's recently listening to this book (privacy-filtered, default OFF). Hidden
  // when the ABS db isn't mapped or nobody's sharing. Short stale time - presence
  // is time-sensitive.
  const { data: listeningNow } = useQuery({
    queryKey: socialKeys.listeningNow(itemId ?? ''),
    queryFn: () => getListeningNow(itemId as string),
    enabled: Boolean(itemId),
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  })

  // The caller's ABS user id, for delete-own on notes and for filtering out
  // "myself" from the listening-now chips.
  const { data: me } = useQuery({
    queryKey: meKeys.me,
    queryFn: getMe,
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="page">
        <LoadingSpinner className="py-12" label="Loading book..." />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load this book." onRetry={refetch} />
      </div>
    )
  }

  const m = data.media.metadata
  const title = m.title ?? 'Untitled'
  const cv = tintFor(title)
  const author = m.authors[0]?.name ?? ''
  const authorId = m.authors[0]?.id
  const narrator = m.narrators[0] ?? ''
  const series = m.series[0]
  const chapters = data.media.chapters ?? []
  const tracks = data.media.audioFiles ?? []
  const duration = tracks.reduce((s, t) => s + (t.duration ?? 0), 0)
  const rating = m.rating ?? null
  // The expanded item detail carries the ebook as `ebookFile` (object), not the
  // flat `ebookFormat` string used on minified list items.
  const hasEbook = !!data.media.ebookFile || !!data.media.ebookFormat
  const ebookOnly = hasEbook && tracks.length === 0

  const progress = progressById.get(data.id)
  const pct = progress?.progress ?? 0
  const finished = progress?.isFinished ?? false
  const chaptersLeft = Math.round(chapters.length * (1 - pct))

  const playLabel = finished ? 'Listen again' : pct > 0 ? 'Resume' : 'Start listening'

  const description = m.description ? stripHtml(m.description) : ''
  const links = externalLinks(data, {
    goodreads: extGoodreads,
    audible: extAudible,
    hardcover: extHardcover,
  })

  // Finished-by chips: only render when the backend served real data and at
  // least one (privacy-filtered) user finished the book.
  const finishers = finishedBy?.available ? finishedBy.users : []
  // Listening-recently chips: same gate. The label is deliberately "recently".
  const listeners = listeningNow?.available ? listeningNow.users : []
  // The reader's position + finished state drive the notes spoiler gate.
  const notePosition = progress?.currentTime ?? 0

  const playChapter = async (start: number) => {
    if (sessionItemId === data.id) {
      seek(start)
    } else {
      await playItem(data.id)
      seek(start)
    }
  }

  return (
    <div className="page fade-in" style={{ ['--glow-accent' as string]: cv }}>
      <div className="crumb">
        <Link className="lnk" to="/library">
          Library
        </Link>
        <Icon name="chevron_right" />
        {title}
      </div>

      <div className="detail-top">
        <div className="detail-cover" data-cv={cv}>
          <Cover
            itemId={data.id}
            title={title}
            author={author}
            fs={18}
            className="dc-zoomable"
            onClick={() => setZoomCover(true)}
            overlay={
              <span className="dc-zoom-hint" aria-hidden>
                <Icon name="zoom_in" />
              </span>
            }
          />
          {pct > 0 && !finished && (
            <>
              <div className="prog-line">
                <i style={{ width: pct * 100 + '%' }} />
              </div>
              <div className="dc-prog-cap">
                {Math.round(pct * 100)}% · {chaptersLeft} chapters left
              </div>
            </>
          )}
          {finished && (
            <div className="dc-prog-cap" style={{ color: '#a7c896' }}>
              <Icon name="check_circle" fill style={{ fontSize: 14, verticalAlign: '-2px' }} />{' '}
              Finished
            </div>
          )}
        </div>

        <div className="detail-main">
          <h1>
            {title}
            {rating != null && rating >= 4.7 && (
              <span className="badges">
                <span className="badge-pill abridged">Top rated</span>
              </span>
            )}
          </h1>
          {m.subtitle && <div className="d-sub">{m.subtitle}</div>}
          {series && (
            <div className="detail-series-links">
              <span className="d-series-chip" onClick={() => navigate(`/series/${series.id}`)}>
                {series.name}
                {series.sequence && ` #${series.sequence}`}
              </span>
            </div>
          )}
          <div className="d-sub" style={{ marginTop: 8 }}>
            By{' '}
            {authorId ? (
              <span
                className="d-author-link"
                style={{ color: 'var(--text)', fontWeight: 600, cursor: 'pointer' }}
                onClick={() => navigate(`/author/${authorId}`)}
              >
                {author}
              </span>
            ) : (
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{author}</span>
            )}
          </div>

          <dl className="meta-rows">
            {narrator && (
              <>
                <dt>Narrator</dt>
                <dd>
                  <Link className="lnk" to={`/library?narrator=${encodeURIComponent(narrator)}`}>
                    {narrator}
                  </Link>
                </dd>
              </>
            )}
            {m.publishedYear && (
              <>
                <dt>Published</dt>
                <dd>{m.publishedYear}</dd>
              </>
            )}
            {m.genres[0] && (
              <>
                <dt>Genre</dt>
                <dd>
                  <Link className="lnk" to={`/library?genre=${encodeURIComponent(m.genres[0])}`}>
                    {m.genres[0]}
                  </Link>
                </dd>
              </>
            )}
            {rating != null && rating > 0 && (
              <>
                <dt>Rating</dt>
                <dd style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Stars rating={rating} />
                  <span className="mono" style={{ fontFamily: 'var(--font-mono)' }}>
                    {rating.toFixed(1)}
                  </span>
                </dd>
              </>
            )}
            <dt>Duration</dt>
            <dd className="mono" style={{ fontFamily: 'var(--font-mono)' }}>
              {formatDuration(duration)} · {chapters.length} chapters
            </dd>
          </dl>

          {finishers.length > 0 && (
            <div
              className="detail-finished-by"
              style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
                <Icon name="check_circle" fill style={{ fontSize: 15, verticalAlign: '-3px' }} />{' '}
                Finished by {finishers.length}
              </span>
              {finishers.map((u) => (
                <span className="chip" key={u.userId} style={{ paddingLeft: 4 }}>
                  <Avatar userId={u.userId} name={u.username} size={24} />
                  {u.username}
                </span>
              ))}
            </div>
          )}

          {listeners.length > 0 && (
            <div
              className="detail-listening-now"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 8,
                marginTop: 10,
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
                <Icon
                  name="graphic_eq"
                  fill
                  style={{ fontSize: 15, verticalAlign: '-3px', color: 'var(--accent)' }}
                />{' '}
                Listening recently
              </span>
              {listeners.map((u) => (
                <span className="chip" key={u.userId} style={{ paddingLeft: 4 }}>
                  <Avatar userId={u.userId} name={u.username} size={24} />
                  {u.username}
                </span>
              ))}
            </div>
          )}

          <div className="detail-actions">
            {ebookOnly ? (
              <button className="btn btn-primary" onClick={() => navigate(`/reader/${data.id}`)}>
                <Icon name="menu_book" fill /> Read
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void playItem(data.id)}>
                <Icon name="play_arrow" fill /> {playLabel}
              </button>
            )}
            {hasEbook && !ebookOnly && (
              <button className="pill" onClick={() => navigate(`/reader/${data.id}`)}>
                <Icon name="menu_book" /> Read
              </button>
            )}
            <AddToListMenu
              libraryItemId={data.id}
              libraryId={data.libraryId}
              title={title}
              author={author}
              onToast={show}
              trigger={(toggle, isOpen) => (
                <button className={'pill' + (isOpen ? ' on' : '')} onClick={toggle}>
                  <Icon name="playlist_add" /> Add to list
                </button>
              )}
            />
            <button
              className={'pill' + (finished ? ' on' : '')}
              disabled={marking}
              onClick={() => void markFinished([data.id], !finished)}
            >
              <Icon name={finished ? 'task_alt' : 'check'} fill={finished} />{' '}
              {finished ? 'Finished' : 'Mark finished'}
            </button>
            <button className="pill" onClick={() => setEditing(true)}>
              <Icon name="edit" /> Edit
            </button>
            <Dropdown icon="more_horiz" label="">
              <MItem
                icon="download"
                label="Download"
                onClick={() => {
                  const ino = tracks[0]?.ino
                  if (ino)
                    window.open(
                      `/abs-api/api/items/${data.id}/file/${ino}?token=${encodeURIComponent(token ?? '')}`,
                      '_blank',
                    )
                }}
              />
              <MItem
                icon="bookmark"
                label="Bookmarks"
                onClick={() => show('Bookmarks are coming soon')}
              />
              <MItem
                icon="share"
                label="Share"
                onClick={() => {
                  void navigator.clipboard.writeText(window.location.href)
                  show('Link copied')
                }}
              />
            </Dropdown>
          </div>

          {links.length > 0 && (
            <div className="detail-ext">
              {links.map((l) => (
                <a
                  key={l.key}
                  className="ext-link"
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open on ${l.label}`}
                >
                  <Icon name={l.icon} /> {l.label}
                  <Icon name="open_in_new" style={{ fontSize: 15, opacity: 0.6 }} />
                </a>
              ))}
            </div>
          )}

          {description && (
            <>
              <div className={'detail-desc' + (expanded ? '' : ' clamp')}>{description}</div>
              <button className="read-more" onClick={() => setExpanded((e) => !e)}>
                {expanded ? 'Read less' : 'Read more'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="detail-section">
        <div className="toolbar2" style={{ marginBottom: 0 }}>
          {(
            [
              ['chapters', 'Chapters', chapters.length],
              ['tracks', 'Audio tracks', tracks.length],
              ...(hasEbook ? [['ebook', 'eBook', 1] as [DetailTab, string, number]] : []),
              ['files', 'Files', tracks.length + 1],
            ] as [DetailTab, string, number][]
          ).map(([id, lbl, n]) => (
            <button
              key={id}
              className={'pill' + (tab === id ? ' on' : '')}
              onClick={() => setTab(id)}
            >
              {lbl} <span style={{ opacity: 0.6 }}>{n}</span>
            </button>
          ))}
          {tab === 'chapters' && chapters.length > 0 && (
            <>
              <div className="tb-spacer" />
              <button className="pill" onClick={() => setEditingChapters(true)}>
                <Icon name="edit" /> Edit chapters
              </button>
            </>
          )}
        </div>

        <div className="tbl-wrap" style={{ marginTop: 16 }}>
          {tab === 'chapters' && (
            <>
              <div className="dt-row chap dt-head">
                <span>#</span>
                <span>Title</span>
                <span>Start</span>
                <span>Length</span>
              </div>
              {chapters.map((c, i) => (
                <div className="dt-row chap" key={c.id} onClick={() => void playChapter(c.start)}>
                  <span className="num">{i + 1}</span>
                  <span>{c.title}</span>
                  <span className="mono">{formatTimestamp(c.start)}</span>
                  <span className="mono">{formatTimestamp(c.end - c.start)}</span>
                </div>
              ))}
            </>
          )}

          {tab === 'tracks' && (
            <>
              <div className="dt-row track dt-head">
                <span>#</span>
                <span>File</span>
                <span>Codec</span>
                <span>Bitrate</span>
                <span>Size</span>
              </div>
              {tracks.map((t) => (
                <div className="dt-row track" key={t.ino}>
                  <span className="num">{t.index}</span>
                  <span>{t.metadata.filename}</span>
                  <span className="num">{(t.codec ?? '').toUpperCase()}</span>
                  <span className="num">
                    {t.bitRate ? `${Math.round(t.bitRate / 1000)} kbps` : '—'}
                  </span>
                  <span className="num">{formatBytes(t.metadata.size)}</span>
                </div>
              ))}
            </>
          )}

          {tab === 'ebook' && (
            <>
              <div className="dt-row file dt-head">
                <span />
                <span>File</span>
                <span>Format</span>
                <span>Size</span>
                <span />
              </div>
              <div
                className="dt-row file"
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/reader/${data.id}`)}
                title="Open in reader"
              >
                <Icon name="menu_book" style={{ fontSize: 18, color: 'var(--accent)' }} fill />
                <span>{data.media.ebookFile?.metadata?.filename ?? 'ebook'}</span>
                <span className="num">
                  {(
                    data.media.ebookFile?.ebookFormat ??
                    data.media.ebookFormat ??
                    ''
                  ).toUpperCase()}
                </span>
                <span className="num">
                  {data.media.ebookFile?.metadata?.size
                    ? formatBytes(data.media.ebookFile.metadata.size)
                    : '—'}
                </span>
                <span className="mono" style={{ color: 'var(--accent)' }}>
                  <Icon name="chevron_right" />
                </span>
              </div>
            </>
          )}

          {tab === 'files' && (
            <>
              <div className="dt-row file dt-head">
                <span />
                <span>File</span>
                <span>Type</span>
                <span>Size</span>
                <span />
              </div>
              <div className="dt-row file">
                <Icon name="image" style={{ fontSize: 18, color: 'var(--text-muted)' }} />
                <span>cover.jpg</span>
                <span className="num">Image</span>
                <span className="num">—</span>
                <span />
              </div>
              {tracks.map((t) => (
                <div className="dt-row file" key={t.ino}>
                  <Icon name="audio_file" style={{ fontSize: 18, color: 'var(--text-muted)' }} />
                  <span>{t.metadata.filename}</span>
                  <span className="num">Audio</span>
                  <span className="num">{formatBytes(t.metadata.size)}</span>
                  <a
                    className="tbl-icon"
                    title="Download"
                    href={`/abs-api/api/items/${data.id}/file/${t.ino}?token=${encodeURIComponent(token ?? '')}`}
                  >
                    <Icon name="download" />
                  </a>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {me && (
        <NotesSection
          libraryItemId={data.id}
          chapters={chapters}
          meId={me.id}
          position={notePosition}
          finished={finished}
        />
      )}

      <ClubCard libraryItemId={data.id} bookTitle={title} onToast={show} />

      {zoomCover && (
        <ImageZoomViewer
          src={`/abs-api/api/items/${data.id}/cover${token ? `?token=${encodeURIComponent(token)}` : ''}`}
          alt={title}
          onClose={() => setZoomCover(false)}
        />
      )}
      {editing && <ItemEditModal item={data} onClose={() => setEditing(false)} />}
      {editingChapters && (
        <ChapterEditorModal
          itemId={data.id}
          chapters={chapters}
          duration={duration}
          onClose={() => setEditingChapters(false)}
        />
      )}
      {toast && (
        <div className="p-toast">
          <Icon name="check_circle" fill /> {toast}
        </div>
      )}
    </div>
  )
}
