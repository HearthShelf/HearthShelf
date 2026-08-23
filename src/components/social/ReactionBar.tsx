/**
 * The reaction control under a comment: existing tallies, a quick-pick row, and
 * a picker for everything else.
 *
 * Reactions are stored as the emoji itself (see core lib/noteReactions.ts), so
 * this renders any kind any client sends without an icon table - and a kind
 * added by a newer client is never invisible here.
 *
 * Recently-used emoji are per-browser and never synced: which emoji someone
 * reaches for is a personal habit, not something the club needs to agree on.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HSNote } from '@hearthshelf/core'
import { quickReactions, reactionGlyph, reactionLabel, rememberReaction } from '@hearthshelf/core'

const RECENTS_KEY = 'hs.reactionRecents.v1'

/** Roughly the popover's tallest rendered height, in px. Used only to decide
 *  whether it opens up or down; it mirrors the max-height in design.css, so
 *  keep the two in step. */
const POPOVER_MAX_H = 360

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const saved = raw ? JSON.parse(raw) : null
    return Array.isArray(saved) ? saved.filter((k) => typeof k === 'string') : []
  } catch {
    // A corrupt list just means a default quick row - never worth failing over.
    return []
  }
}

/** Emoji offered in the picker, grouped the way a reader thinks about them
 *  rather than by Unicode block. Keywords drive the search box. */
const GROUPS: Array<{ title: string; emoji: Array<[string, string]> }> = [
  {
    title: 'Reactions',
    emoji: [
      ['\u{1F44D}', 'thumbs up like yes'],
      ['\u{1F44E}', 'thumbs down dislike no'],
      ['\u{2764}\u{FE0F}', 'heart love red'],
      ['\u{1F525}', 'fire hot lit'],
      ['\u{1F44F}', 'clap applause bravo'],
      ['\u{1F64C}', 'raised hands praise celebrate'],
      ['\u{1F4AF}', 'hundred perfect score'],
      ['\u{2728}', 'sparkles shiny nice'],
      ['\u{1F389}', 'party tada celebrate'],
      ['\u{1F440}', 'eyes looking watching'],
      ['\u{1F91D}', 'handshake agree deal'],
      ['\u{270A}', 'fist solidarity'],
    ],
  },
  {
    title: 'Faces',
    emoji: [
      ['\u{1F602}', 'laugh joy crying laughing'],
      ['\u{1F923}', 'rofl rolling laughing'],
      ['\u{1F60D}', 'heart eyes love adore'],
      ['\u{1F60E}', 'cool sunglasses'],
      ['\u{1F914}', 'thinking hmm curious'],
      ['\u{1F62E}', 'surprised wow open mouth'],
      ['\u{1F631}', 'scream shocked fear'],
      ['\u{1F622}', 'cry sad tear'],
      ['\u{1F62D}', 'sobbing bawling sad'],
      ['\u{1F621}', 'angry mad rage'],
      ['\u{1F644}', 'eye roll whatever'],
      ['\u{1F910}', 'zipper mouth no spoilers secret'],
      ['\u{1F92F}', 'mind blown exploding head'],
      ['\u{1F971}', 'yawn bored tired sleepy'],
      ['\u{1F60F}', 'smirk knowing'],
      ['\u{1F495}', 'hearts love'],
    ],
  },
  {
    title: 'Books and story',
    emoji: [
      ['\u{1F4D6}', 'book open reading'],
      ['\u{1F4DA}', 'books library series'],
      ['\u{1F516}', 'bookmark save'],
      ['\u{1F3A7}', 'headphones audiobook listening'],
      ['\u{1F5E3}\u{FE0F}', 'narrator voice speaking'],
      ['\u{1F4DD}', 'note writing memo'],
      ['\u{1F52E}', 'crystal ball prediction theory'],
      ['\u{1F5DD}\u{FE0F}', 'key clue answer'],
      ['\u{1F480}', 'skull death died dead'],
      ['\u{1F494}', 'broken heart heartbreak sad'],
      ['\u{1F91B}', 'punch fight action'],
      ['\u{1F3C6}', 'trophy win victory'],
    ],
  },
  {
    title: 'Everything else',
    emoji: [
      ['\u{1F4A9}', 'poop crap bad'],
      ['\u{1F346}', 'eggplant aubergine'],
      ['\u{1F351}', 'peach butt'],
      ['\u{1F355}', 'pizza food'],
      ['\u{2615}', 'coffee tea drink'],
      ['\u{1F37F}', 'popcorn drama watching'],
      ['\u{1F308}', 'rainbow pride'],
      ['\u{1F30D}', 'earth world globe'],
      ['\u{1F3B5}', 'music note song'],
      ['\u{1F680}', 'rocket fast launch'],
      ['\u{1F41B}', 'bug glitch problem'],
      ['\u{1F42C}', 'dolphin so long thanks'],
    ],
  },
]

export function ReactionBar({
  note,
  onReact,
  disabled,
}: {
  note: HSNote
  onReact: (note: HSNote, kind: string, on: boolean) => void
  /** True for a reader who cannot react (not a member); tallies still render. */
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<string[]>(loadRecents)
  // Which way the popover opens. It prefers upward (a comment usually has more
  // room above it than below in a scrolled thread), but the first comments in a
  // thread sit near the top of the viewport, where opening up would clip it.
  const [dropDown, setDropDown] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  const quick = useMemo(() => quickReactions(recents), [recents])

  // Close the picker on an outside click or Escape, the two ways anyone expects
  // to dismiss a popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const react = (kind: string) => {
    const mine = (note.reactions ?? []).some((r) => r.kind === kind && r.mine)
    if (!mine) {
      // Only a reaction being ADDED earns a place in the quick row - removing
      // one is not "using" it.
      const next = rememberReaction(recents, kind)
      if (next !== recents) {
        setRecents(next)
        try {
          localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
        } catch {
          // A full or blocked store just means the row resets next visit.
        }
      }
    }
    setOpen(false)
    setQuery('')
    onReact(note, kind, !mine)
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return GROUPS
    return GROUPS.map((g) => ({
      title: g.title,
      emoji: g.emoji.filter(([glyph, words]) => words.includes(q) || glyph === q),
    })).filter((g) => g.emoji.length > 0)
  }, [query])

  return (
    <span className="note-reactions">
      {/* One chip per kind that has at least one reactor, so a reaction from a
          client this build has never seen still shows its count. */}
      {(note.reactions ?? []).map((r) => (
        <button
          key={r.kind}
          type="button"
          className={'note-react' + (r.mine ? ' on' : '')}
          disabled={disabled}
          onClick={() => react(r.kind)}
          aria-pressed={r.mine}
          title={`${r.count} ${reactionLabel(r.kind)}${r.mine ? ', including you' : ''}`}
        >
          <span aria-hidden="true">{reactionGlyph(r.kind)}</span>
          <span>{r.count}</span>
        </button>
      ))}
      {!disabled && (
        <span className="note-react-picker" ref={popRef}>
          {/* The accessible name rides on aria-label rather than a visually
              hidden span - this codebase has no .sr-only utility, so such a
              span would simply render as stray text next to the glyph. */}
          <button
            type="button"
            className="note-react note-react-add"
            ref={btnRef}
            onClick={() => {
              // Decide the direction from the space actually available at the
              // moment of opening, not from a guess baked into the CSS.
              const top = btnRef.current?.getBoundingClientRect().top ?? 0
              setDropDown(top < POPOVER_MAX_H)
              setOpen((v) => !v)
            }}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label="Add a reaction"
            title="Add a reaction"
          >
            <span aria-hidden="true">{'\u{1F642}'}</span>
            <span aria-hidden="true">+</span>
          </button>
          {open && (
            <div
              className={'note-react-pop' + (dropDown ? ' down' : '')}
              role="dialog"
              aria-label="Pick a reaction"
            >
              <div className="note-react-quick">
                {quick.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="note-react-cell"
                    onClick={() => react(kind)}
                    title={reactionLabel(kind)}
                  >
                    {reactionGlyph(kind)}
                  </button>
                ))}
              </div>
              <input
                type="search"
                className="note-react-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search reactions"
                aria-label="Search reactions"
              />
              <div className="note-react-grid-scroll">
                {groups.length === 0 && <p className="note-react-empty">Nothing matches that.</p>}
                {groups.map((group) => (
                  <div key={group.title}>
                    <h4 className="note-react-group">{group.title}</h4>
                    <div className="note-react-grid">
                      {group.emoji.map(([glyph, words]) => (
                        <button
                          key={glyph}
                          type="button"
                          className="note-react-cell"
                          onClick={() => react(glyph)}
                          title={words.split(' ')[0]}
                        >
                          {glyph}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </span>
      )}
    </span>
  )
}
