import { useState, useEffect, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/common/Icon'
import { useActiveLibrary, libraryIcon } from '@/hooks/useActiveLibrary'

function LibrarySwitcher() {
  const { libraries, active, activeId, select } = useActiveLibrary()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  if (!active) return <div className="lib-switch" />

  return (
    <div className="lib-switch" onClick={(e) => e.stopPropagation()}>
      <button className="lib-btn" onClick={() => setOpen((o) => !o)}>
        <span className="lib-ico">
          <Icon name={libraryIcon(active)} fill />
        </span>
        <span className="lib-name">{active.name}</span>
        <Icon name="unfold_more" />
      </button>
      {open && (
        <div className="lib-menu">
          <div className="lm-label">Your libraries</div>
          {libraries.map((l) => (
            <button
              key={l.id}
              className={'lm-item' + (l.id === activeId ? ' on' : '')}
              onClick={() => {
                select(l.id)
                setOpen(false)
              }}
            >
              <span className="lib-ico">
                <Icon name={libraryIcon(l)} fill={l.id === activeId} />
              </span>
              <span className="lm-meta">
                <span className="lm-name">{l.name}</span>
                <span className="lm-sub">
                  {l.mediaType === 'podcast' ? 'Podcasts' : 'Audiobooks'}
                </span>
              </span>
              {l.id === activeId && <Icon name="check" className="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function AppBar() {
  const navigate = useNavigate()
  const { active } = useActiveLibrary()
  const [q, setQ] = useState('')

  const submit = (e?: FormEvent) => {
    if (e) e.preventDefault()
    const v = q.trim()
    if (v) navigate(`/search?q=${encodeURIComponent(v)}`)
  }

  return (
    <header className="appbar">
      <LibrarySwitcher />
      <form className="ab-search" onSubmit={submit}>
        <span
          onClick={() => submit()}
          style={{ display: 'grid', placeItems: 'center', cursor: 'pointer' }}
        >
          <Icon name="search" />
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${active?.name ?? 'library'}…`}
          aria-label="Search"
        />
        <kbd>/</kbd>
      </form>
      <div className="ab-spacer" />
      <div className="ab-actions">
        <button className="ab-ico" title="Cast">
          <Icon name="cast" />
        </button>
        <button
          className="ab-ico"
          title="Upload"
          onClick={() => navigate('/upload')}
        >
          <Icon name="upload" />
        </button>
      </div>
    </header>
  )
}
