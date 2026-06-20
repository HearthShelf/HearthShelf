import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { WatchAuthorButton } from '@/components/requests/WatchButton'
import { getAuthor } from '@/api/libraries'
import { useAuthStore } from '@/store/authStore'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { formatDuration } from '@/lib/format'
import { tintFor } from '@/components/common/Cover'
import { initialsOf } from '@/components/library/AuthorCard'
import { BookTile } from '@/components/library/BookTile'
import { SectionHead } from '@/components/common/SectionHead'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ErrorState } from '@/components/common/ErrorState'

export function AuthorDetailPage() {
  const { authorId } = useParams()
  const token = useAuthStore((s) => s.token)
  const progressById = useMediaProgress()
  const [imgOk, setImgOk] = useState(true)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['author', authorId],
    queryFn: () => getAuthor(authorId as string),
    enabled: Boolean(authorId),
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="page">
        <LoadingSpinner className="py-12" label="Loading author..." />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="page">
        <ErrorState message="Could not load this author." onRetry={refetch} />
      </div>
    )
  }

  const books = data.libraryItems ?? []
  const totalH = books.reduce((s, b) => s + (b.media.duration ?? 0), 0)
  const cv = tintFor(data.name)
  const params = token ? `?token=${encodeURIComponent(token)}` : ''
  const hasImg = imgOk && Boolean(data.imagePath)

  return (
    <div className="page fade-in" style={{ ['--glow-accent' as string]: cv }}>
      <div className="crumb">
        <Link className="lnk" to="/authors">
          Authors
        </Link>
        <Icon name="chevron_right" />
        {data.name}
      </div>

      <div className="author-hero">
        <div
          className="author-av"
          style={{
            background: `linear-gradient(150deg, ${cv}, color-mix(in oklab, ${cv} 45%, #000))`,
            overflow: 'hidden',
          }}
        >
          {hasImg ? (
            <img
              src={`/abs-api/api/authors/${data.id}/image${params}`}
              alt={data.name}
              onError={() => setImgOk(false)}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            initialsOf(data.name)
          )}
        </div>
        <div>
          <div className="eyebrow">Author</div>
          <h1>{data.name}</h1>
          <div className="page-sub" style={{ marginTop: 6 }}>
            {books.length} {books.length === 1 ? 'book' : 'books'} ·{' '}
            {formatDuration(totalH)} total
          </div>
          {data.description && <p className="bio">{data.description}</p>}
          <div style={{ marginTop: 12 }}>
            <WatchAuthorButton asin={data.asin} name={data.name} />
          </div>
        </div>
      </div>

      <div className="section">
        <SectionHead icon="auto_stories" title="Books" />
        <div className="lib-grid">
          {books.map((b) => {
            const p = progressById.get(b.id)
            return (
              <BookTile
                key={b.id}
                item={b}
                progress={p?.progress ?? 0}
                finished={p?.isFinished}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
