import { useState, useEffect } from 'react'
import type { ABSLibraryItem } from '@/api/types'
import { Icon } from '@/components/common/Icon'
import {
  FILTER_GROUPS,
  FILTER_FLAGS,
  filterLabel,
  SORT_COMMON,
  SORT_MORE,
  type LibrarySort,
} from '@/lib/libraryFilters'

function FilterItem({
  label,
  check,
  arrow,
  onClick,
}: {
  label: string
  check?: boolean
  arrow?: boolean
  onClick: () => void
}) {
  return (
    <button className={'mp-item' + (check ? ' on' : '')} onClick={onClick}>
      {label}
      {arrow && (
        <Icon
          name="arrow_right"
          style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}
        />
      )}
      {check && (
        <Icon name="check" style={{ marginLeft: 'auto', color: 'var(--accent)' }} />
      )}
    </button>
  )
}

// Nested filter menu: top level lists categories (drill in with a back button)
// plus standalone flag toggles. Mirrors the design reference.
export function LibraryFilterMenu({
  items,
  filter,
  setFilter,
}: {
  items: ABSLibraryItem[]
  filter: string
  setFilter: (f: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  const group = sub ? FILTER_GROUPS.find((g) => g.id === sub) : null

  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        className={'pill' + (filter !== 'all' ? ' on' : '')}
        onClick={() => {
          setOpen((o) => !o)
          setSub(null)
        }}
      >
        <Icon name="filter_list" /> {filterLabel(filter)}
      </button>
      {open && (
        <div className="menu-pop left">
          {!group && (
            <>
              <div className="mp-label">Filter by</div>
              <FilterItem
                label="All"
                check={filter === 'all'}
                onClick={() => {
                  setFilter('all')
                  setOpen(false)
                }}
              />
              {FILTER_GROUPS.filter((g) => g.values(items).length > 0).map((g) => (
                <FilterItem key={g.id} label={g.label} arrow onClick={() => setSub(g.id)} />
              ))}
              <div className="mp-sep" />
              {FILTER_FLAGS.map(([id, label]) => (
                <FilterItem
                  key={id}
                  label={label}
                  check={filter === id}
                  onClick={() => {
                    setFilter(id)
                    setOpen(false)
                  }}
                />
              ))}
            </>
          )}
          {group && (
            <>
              <button
                className="mp-item"
                onClick={() => setSub(null)}
                style={{ color: 'var(--text-muted)' }}
              >
                <Icon name="arrow_left" /> Back
              </button>
              <div className="mp-sep" />
              <div className="mp-label">{group.label}</div>
              {group.values(items).map((v) => {
                const key = `${group.id}|${v}`
                return (
                  <FilterItem
                    key={v}
                    label={v}
                    check={filter === key}
                    onClick={() => {
                      setFilter(key)
                      setOpen(false)
                    }}
                  />
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function LibrarySortMenu({
  sort,
  desc,
  setSort,
  toggleDesc,
}: {
  sort: LibrarySort
  desc: boolean
  setSort: (s: LibrarySort) => void
  toggleDesc: () => void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  const Row = (s: LibrarySort) => (
    <button
      key={s}
      className={'mp-item' + (s === sort ? ' on' : '')}
      onClick={() => {
        if (s === sort) toggleDesc()
        else {
          setSort(s)
          setOpen(false)
        }
      }}
    >
      {s}
      {s === sort && (
        <Icon
          name={desc ? 'expand_more' : 'expand_less'}
          style={{ marginLeft: 'auto', color: 'var(--accent)' }}
        />
      )}
    </button>
  )

  return (
    <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className={'pill' + (open ? ' on' : '')} onClick={() => setOpen((o) => !o)}>
        <Icon name="swap_vert" /> {sort}
      </button>
      {open && (
        <div className="menu-pop left">
          <div className="mp-label">Sort by</div>
          {SORT_COMMON.map(Row)}
          <div className="mp-sep" />
          <div className="mp-label">More</div>
          {SORT_MORE.map(Row)}
        </div>
      )}
    </div>
  )
}
