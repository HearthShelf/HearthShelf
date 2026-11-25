import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/store/authStore'
import { searchCovers, updateItemCover, libraryKeys } from '@/api/libraries'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { SelectField } from '@/components/common/SelectField'

interface ItemCoverTabProps {
  itemId: string
  defaultTitle: string
  defaultAuthor: string
  onApplied: (msg: string) => void
}

// Current cover preview + provider cover search; clicking a result sets it.
export function ItemCoverTab({
  itemId,
  defaultTitle,
  defaultAuthor,
  onApplied,
}: ItemCoverTabProps) {
  const qc = useQueryClient()
  const token = useAuthStore((s) => s.token)
  const [provider, setProvider] = useState('audible')
  const [title, setTitle] = useState(defaultTitle)
  const [covers, setCovers] = useState<string[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setSearching(true)
    setError(null)
    try {
      const res = await searchCovers(provider, title, defaultAuthor)
      setCovers(res.results)
    } catch {
      setError("Couldn't search for covers. Try again.")
    } finally {
      setSearching(false)
    }
  }

  const apply = async (url: string) => {
    setApplying(url)
    setError(null)
    try {
      await updateItemCover(itemId, url)
      qc.invalidateQueries({ queryKey: libraryKeys.item(itemId) })
      onApplied('Cover updated')
    } catch {
      setError("Couldn't set that cover. Try another picture or link.")
    } finally {
      setApplying(null)
    }
  }

  const params = token ? `?token=${encodeURIComponent(token)}&ts=${Date.now()}` : ''

  return (
    <div className="cover-tab">
      <div className="cur" style={{ width: 140, flex: 'none' }}>
        <img
          src={`/abs-api/api/items/${itemId}/cover${params}`}
          alt="Current cover"
          style={{ width: 140, height: 140, borderRadius: 10, objectFit: 'cover' }}
        />
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Current</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            className="fld"
            placeholder="https://…/cover.jpg"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
          />
          <button
            className="btn-sm btn-ghost"
            style={{ flex: 'none' }}
            disabled={!urlInput.trim() || applying !== null}
            onClick={() => void apply(urlInput.trim())}
          >
            Add URL
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <SelectField
            style={{ flex: 'none', width: 130 }}
            value={provider}
            onChange={setProvider}
            options={[
              { value: 'audible', label: 'Audible' },
              { value: 'google', label: 'Google' },
              { value: 'itunes', label: 'iTunes' },
              { value: 'openlibrary', label: 'Open Library' },
            ]}
          />
          <input
            className="fld"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
          />
          <button
            className="btn-sm btn-accent"
            style={{ flex: 'none' }}
            disabled={searching}
            onClick={() => void run()}
          >
            <Icon name="search" /> Search
          </button>
        </div>

        {error && (
          <div style={{ fontSize: 13, color: 'var(--danger, #e5484d)', marginBottom: 10 }}>
            {error}
          </div>
        )}
        {searching && <LoadingSpinner className="py-8" label="Searching..." />}
        {covers && covers.length === 0 && <div className="pop-empty">No covers found.</div>}
        {covers && covers.length > 0 && (
          <div className="cover-search-grid">
            {covers.map((url) => (
              <button
                key={url}
                onClick={() => void apply(url)}
                disabled={applying !== null}
                style={{
                  border: 'none',
                  padding: 0,
                  background: 'none',
                  cursor: 'pointer',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <img
                  src={url}
                  alt=""
                  style={{
                    width: '100%',
                    aspectRatio: '1',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
