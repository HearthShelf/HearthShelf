import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getAllLibraryItems, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { usePlayer } from '@/hooks/usePlayer'
import { Icon } from '@/components/common/Icon'
import { Cover } from '@/components/common/Cover'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { QuestGiverChoice } from '@/components/questgiver/QuestGiverChoice'
import { QuestGiverSlider } from '@/components/questgiver/QuestGiverSlider'
import { QuestGiverResultCard } from '@/components/questgiver/QuestGiverResultCard'
import { useQgConfig } from '@/hooks/useQuestGiver'
import {
  qgBooks,
  qgBuildProfile,
  qgLibraryCandidates,
  QG_EXPLORE_GENRES,
  type QgAnswers,
  type QgRenderedPick,
} from '@/lib/questgiver'
import {
  qgRecommend,
  getRuns,
  saveRun,
  getFeedback,
  setFeedback as persistFeedback,
  type QgRun,
  type QgFeedback,
} from '@/api/questgiver'

type Direction = 'more' | 'switch' | 'new'
type Length = 'any' | 'short' | 'standard' | 'epic'
type Basis = 'history' | 'list'

const STEP_LABELS = ['Basis', 'Direction', 'Weights', 'Fine-tune']

export function QuestGiverPage() {
  const navigate = useNavigate()
  const { activeId } = useActiveLibrary()
  const progressById = useMediaProgress()
  const { playItem } = usePlayer()

  const { data: itemsData, isLoading } = useQuery({
    queryKey: libraryKeys.allItems(activeId ?? ''),
    queryFn: () => getAllLibraryItems(activeId as string),
    enabled: activeId !== null,
  })
  const { data: config } = useQgConfig()

  const allItems = useMemo(() => itemsData?.results ?? [], [itemsData])
  const books = useMemo(() => qgBooks(allItems, progressById), [allItems, progressById])

  // wizard state
  const [step, setStep] = useState(0)
  const [basis, setBasis] = useState<Basis>('history')
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [direction, setDirection] = useState<Direction>('more')
  const [mood, setMood] = useState('')
  const [weights, setWeights] = useState<Record<string, number> | null>(null)
  const [length, setLength] = useState<Length>('any')
  const [familiarity, setFamiliarity] = useState(4)
  const [narratorAffinity, setNarratorAffinity] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{
    intro: string
    engine: 'ai' | 'heuristic'
    picks: QgRenderedPick[]
  } | null>(null)
  const [runs, setRuns] = useState<QgRun[]>(() => getRuns())
  const [feedback, setFeedback] = useState<Record<string, QgFeedback>>(() => getFeedback())
  const [view, setView] = useState<'flow' | 'history'>('flow')
  const [openRun, setOpenRun] = useState<string | null>(null)

  // profile recomputes from history OR the hand-picked list
  const profile = useMemo(() => {
    if (basis === 'list' && picked.size) return qgBuildProfile(books.filter((b) => picked.has(b.id)))
    return qgBuildProfile(books)
  }, [basis, picked, books])

  // seed weights from the profile when first reaching the weights step
  useEffect(() => {
    if (step === 2 && !weights) {
      const w: Record<string, number> = {}
      profile.listened.forEach((x) => {
        w[x.genre] = x.weight
      })
      QG_EXPLORE_GENRES.forEach((g) => {
        if (w[g] == null) w[g] = 0
      })
      setWeights(w)
    }
  }, [step, weights, profile])

  // basis/list changes invalidate the seeded weights so they re-seed
  useEffect(() => {
    setWeights(null)
  }, [basis, picked])

  const setW = (g: string, v: number) => setWeights((w) => ({ ...(w ?? {}), [g]: v }))

  const aiLabel = config?.enabled ? config.provider ?? 'AI' : 'AI'

  const setVote = (key: string, vote: 1 | -1 | 0) => {
    const fb: QgFeedback = vote === 0 ? {} : { vote }
    setFeedback(persistFeedback(key, fb))
  }
  const setNote = (key: string, note: string) => {
    setFeedback(persistFeedback(key, { note: note || undefined }))
  }

  const run = async () => {
    setStep(4)
    setLoading(true)
    setView('flow')
    const answers: QgAnswers = {
      direction,
      mood: mood.trim(),
      weights: weights ?? {},
      length,
      familiarity,
      narratorAffinity,
      count: 4,
    }
    const candidates = qgLibraryCandidates(books)
    const out = await qgRecommend(profile, answers, candidates)

    const byId = new Map(books.map((b) => [b.id, b]))
    const priorKeys = new Map<string, number>()
    runs.forEach((r) => r.picks.forEach((p) => priorKeys.set(p.key, (priorKeys.get(p.key) ?? 0) + 1)))

    const seen = new Set<string>()
    const picks: QgRenderedPick[] = []
    for (const p of out.picks) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      const b = byId.get(p.id)
      if (!b) continue
      const key = (b.title + '|' + b.author).toLowerCase()
      picks.push({
        key,
        kind: 'library',
        itemId: b.id,
        title: b.title,
        author: b.author,
        genre: b.genre,
        hours: b.hours,
        reason: p.reason,
        priorCount: priorKeys.get(key) ?? 0,
      })
    }
    const top = picks.slice(0, 4)

    // stamp a label + timestamp and persist the run
    const topGenre = Object.entries(weights ?? {})
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])[0]
    const dirLabel =
      direction === 'more' ? 'More like this' : direction === 'switch' ? 'Switch it up' : 'Something new'
    const label =
      dirLabel +
      (mood.trim() ? ' · "' + mood.trim().slice(0, 28) + '"' : topGenre ? ' · ' + topGenre[0] : '')
    const now = new Date()
    const runRec: QgRun = {
      id: 'run' + now.getTime(),
      label,
      when: now.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
      engine: out.engine,
      intro: out.intro,
      picks: top,
    }
    setRuns(saveRun(runRec))
    setResult({ intro: out.intro, engine: out.engine, picks: top })
    setLoading(false)
    setStep(5)
  }

  const restart = () => {
    setStep(0)
    setResult(null)
    setWeights(null)
    setMood('')
    setPicked(new Set())
    setBasis('history')
    setDirection('more')
    setLength('any')
    setView('flow')
    setOpenRun(null)
  }

  const stepIdx = Math.min(step, 3)

  if (isLoading) return <LoadingSpinner />

  const header = (
    <div className="qg-head-row">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="explore" fill style={{ fontSize: 15, color: 'var(--accent)' }} /> QuestGiver
        </div>
        <h1 className="title-xl">Find your next listen</h1>
        {config?.limit != null && config.remaining != null && (
          <div className="qg-limit-note">
            <Icon name="bolt" fill /> {config.remaining} of {config.limit}{' '}
            {config.remaining === 1 ? 'match' : 'matches'} left
            {config.period === 'week' ? ' this week' : config.period === 'month' ? ' this month' : ' today'}
          </div>
        )}
      </div>
      {runs.length > 0 && (
        <button
          className="qg-btn ghost"
          type="button"
          onClick={() => {
            setView((v) => (v === 'history' ? 'flow' : 'history'))
            setOpenRun(null)
          }}
        >
          <Icon name={view === 'history' ? 'arrow_back' : 'history'} />{' '}
          {view === 'history' ? 'Back to QuestGiver' : 'Past runs · ' + runs.length}
        </button>
      )}
    </div>
  )

  const stepper = step <= 3 && (
    <div className="qg-steps">
      {STEP_LABELS.map((s, i) => (
        <div key={s} className={'qg-step' + (i === stepIdx ? ' on' : '') + (i < stepIdx ? ' done' : '')}>
          <span className="qg-step-n">{i < stepIdx ? <Icon name="check" /> : i + 1}</span>
          {s}
        </div>
      ))}
    </div>
  )

  return (
    <div className="page fade-in qg-page">
      {header}

      {view === 'history' ? (
        <div className="qg-history">
          {runs.length === 0 ? (
            <div className="empty-state">
              <Icon name="history" />
              <h3>No past runs yet</h3>
              <p>Run QuestGiver once and your history shows up here.</p>
            </div>
          ) : (
            runs.map((r) => (
              <div className="qg-run" key={r.id}>
                <button
                  className="qg-run-head"
                  type="button"
                  onClick={() => setOpenRun((o) => (o === r.id ? null : r.id))}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="qg-run-title">{r.label}</div>
                    <div className="qg-run-sub">
                      {r.when} · {r.picks.length} books ·{' '}
                      {r.engine === 'ai' ? 'Matched by ' + aiLabel : 'Matched to weights'}
                    </div>
                  </div>
                  <Icon name={openRun === r.id ? 'expand_less' : 'expand_more'} />
                </button>
                {openRun === r.id && (
                  <div className="qg-result-grid">
                    {r.picks.map((p) => (
                      <QuestGiverResultCard
                        key={p.key}
                        pick={p}
                        onPlay={playItem}
                        onDetails={(id) => navigate('/book/' + id)}
                        feedback={feedback[p.key]}
                        onVote={setVote}
                        onNote={setNote}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          {stepper}

          {step === 0 && (
            <div className="qg-card">
              <h2 className="qg-h">What should I base your match on?</h2>
              <p className="qg-sub">
                I read your library and play stats either way - this just sets the starting point.
              </p>
              <div className="qg-choices">
                <QuestGiverChoice
                  icon="history"
                  title="My listening history"
                  tag="Recommended"
                  desc={`Weighs everything you've finished - ${profile.totalFin} books analyzed.`}
                  on={basis === 'history'}
                  onClick={() => setBasis('history')}
                />
                <QuestGiverChoice
                  icon="checklist"
                  title="A list I pick"
                  desc="Choose a few books and I'll match the vibe of just those."
                  on={basis === 'list'}
                  onClick={() => setBasis('list')}
                />
              </div>
              {basis === 'list' && (
                <div className="qg-pick">
                  <div className="qg-pick-head">
                    Pick a few books to match <span>{picked.size} selected</span>
                  </div>
                  <div className="qg-pick-grid">
                    {books.slice(0, 18).map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className={'qg-pick-item' + (picked.has(b.id) ? ' on' : '')}
                        onClick={() =>
                          setPicked((s) => {
                            const n = new Set(s)
                            if (n.has(b.id)) n.delete(b.id)
                            else n.add(b.id)
                            return n
                          })
                        }
                      >
                        <Cover itemId={b.id} title={b.title} author={b.author} fs={4} />
                        <span className="qg-pick-check">
                          <Icon name="check_circle" fill />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="qg-foot">
                <span />
                <button
                  className="qg-btn"
                  type="button"
                  disabled={basis === 'list' && picked.size === 0}
                  onClick={() => setStep(1)}
                >
                  Continue <Icon name="arrow_forward" />
                </button>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="qg-card">
              <h2 className="qg-h">Where to next?</h2>
              {profile.dominant ? (
                <p className="qg-sub">
                  You've been deep in <b>{profile.dominant}</b> lately
                  {profile.cold ? (
                    <>
                      , while your <b>{profile.cold.genre}</b> shelf ({profile.cold.owned} titles) has gone
                      quiet
                    </>
                  ) : (
                    ''
                  )}
                  .
                </p>
              ) : (
                <p className="qg-sub">Tell me the direction and I'll do the rest.</p>
              )}
              <div className="qg-choices">
                <QuestGiverChoice
                  icon="repeat"
                  title="More like what I love"
                  desc={
                    profile.dominant
                      ? 'Stay in the ' + profile.dominant + ' lane with fresh picks.'
                      : 'Stay close to your recent listens.'
                  }
                  on={direction === 'more'}
                  onClick={() => setDirection('more')}
                />
                <QuestGiverChoice
                  icon="swap_horiz"
                  title="Switch it up"
                  desc={
                    profile.cold
                      ? 'Pull you back into ' +
                        profile.cold.genre +
                        ' - you have ' +
                        profile.cold.owned +
                        ' waiting.'
                      : 'Revive a genre you have drifted from.'
                  }
                  on={direction === 'switch'}
                  onClick={() => setDirection('switch')}
                />
                <QuestGiverChoice
                  icon="auto_awesome"
                  title="Something totally new"
                  desc="Stretch into a genre you don't really own yet."
                  on={direction === 'new'}
                  onClick={() => setDirection('new')}
                />
              </div>
              <div className="qg-mood">
                <label className="qg-wlabel" style={{ marginBottom: 8, display: 'block' }}>
                  Anything specific in mind?{' '}
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>optional</span>
                </label>
                <input
                  className="fld"
                  value={mood}
                  onChange={(e) => setMood(e.target.value)}
                  placeholder="e.g. something propulsive for a long drive, or a slow cozy read..."
                />
              </div>
              <div className="qg-foot">
                <button className="qg-btn ghost" type="button" onClick={() => setStep(0)}>
                  <Icon name="arrow_back" /> Back
                </button>
                <button className="qg-btn" type="button" onClick={() => setStep(2)}>
                  Continue <Icon name="arrow_forward" />
                </button>
              </div>
            </div>
          )}

          {step === 2 && weights && (
            <div className="qg-card">
              <h2 className="qg-h">Weight your genres</h2>
              <p className="qg-sub">
                I pre-set these from what you actually listen to. Nudge each dial toward what you're
                hungry for - <b>0 means skip it</b>.
              </p>
              <div className="qg-weights">
                {profile.listened
                  .filter((x) => x.owned > 0)
                  .map((x) => (
                    <QuestGiverSlider
                      key={x.genre}
                      label={x.genre}
                      sub={
                        (x.finished ? x.finished + ' finished' : x.owned + ' in library') +
                        (x.hours ? ' · ' + Math.round(x.hours) + 'h listened' : '')
                      }
                      value={weights[x.genre] ?? 0}
                      onChange={(v) => setW(x.genre, v)}
                    />
                  ))}
              </div>
              <div className="qg-foot">
                <button className="qg-btn ghost" type="button" onClick={() => setStep(1)}>
                  <Icon name="arrow_back" /> Back
                </button>
                <button className="qg-btn" type="button" onClick={() => setStep(3)}>
                  Continue <Icon name="arrow_forward" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="qg-card">
              <h2 className="qg-h">A few finishing touches</h2>
              <p className="qg-sub">All inferred from your stats - change only what you want.</p>

              <div className="qg-tune-block">
                <div className="qg-wlabel">Length sweet spot</div>
                <div className="qg-chiprow">
                  {(
                    [
                      ['any', 'Surprise me'],
                      ['short', 'Short · under 8h'],
                      ['standard', 'Standard · 8-15h'],
                      ['epic', 'Epic · 15h+'],
                    ] as [Length, string][]
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      className={'qg-chip' + (length === v ? ' on' : '')}
                      onClick={() => setLength(v)}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              <div className="qg-tune-block">
                <QuestGiverSlider
                  label="New voices vs. authors I know"
                  sub="0 = stick with my authors · 10 = all fresh discoveries"
                  value={familiarity}
                  onChange={setFamiliarity}
                />
              </div>

              <div className="qg-tune-block">
                <label className="qg-toggle-row">
                  <div>
                    <div className="qg-wlabel">Favor narrators I trust</div>
                    <div className="qg-wsub">Lean toward the voices you finish most.</div>
                  </div>
                  <button
                    type="button"
                    className={'qg-switch' + (narratorAffinity ? ' on' : '')}
                    onClick={() => setNarratorAffinity((v) => !v)}
                  >
                    <span />
                  </button>
                </label>
              </div>

              <div className="qg-foot">
                <button className="qg-btn ghost" type="button" onClick={() => setStep(2)}>
                  <Icon name="arrow_back" /> Back
                </button>
                <button className="qg-btn qg-go" type="button" onClick={run}>
                  <Icon name="explore" fill /> Find my next listen
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="qg-card qg-loading">
              <div className="qg-craft-orb">
                <Icon name="explore" fill />
              </div>
              <h2 className="qg-h" style={{ textAlign: 'center' }}>
                Matching you to your next listen...
              </h2>
              <p
                className="qg-sub"
                style={{ textAlign: 'center', maxWidth: 440, margin: '0 auto 18px' }}
              >
                Reading your weighted genres, length and narrator preferences against your library.
              </p>
              <div className="qg-craft-list">
                {Object.entries(weights ?? {})
                  .filter(([, v]) => v > 0)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 4)
                  .map(([g, v]) => (
                    <span className="qg-craft-chip" key={g}>
                      {g} <b>{v}</b>
                    </span>
                  ))}
                <span className="qg-craft-chip">
                  {direction === 'more'
                    ? 'Stay in lane'
                    : direction === 'switch'
                      ? 'Switch it up'
                      : 'Explore new'}
                </span>
                {mood.trim() && <span className="qg-craft-chip">&ldquo;{mood.trim().slice(0, 40)}&rdquo;</span>}
              </div>
              {loading && (
                <div className="qg-spinner">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
          )}

          {step === 5 && result && (
            <div className="qg-results">
              <div className="qg-result-head">
                <p className="qg-intro">{result.intro}</p>
                <span className="qg-engine">
                  {result.engine === 'ai' ? (
                    <>
                      <Icon name="auto_awesome" fill /> Matched by {aiLabel}
                    </>
                  ) : (
                    <>
                      <Icon name="tune" /> Matched to your weights
                    </>
                  )}
                </span>
              </div>
              {result.picks.length === 0 ? (
                <div className="empty-state">
                  <Icon name="search_off" />
                  <h3>No clean match</h3>
                  <p>Try widening your weights or picking a different direction.</p>
                </div>
              ) : (
                <div className="qg-result-grid">
                  {result.picks.map((p) => (
                    <QuestGiverResultCard
                      key={p.key}
                      pick={p}
                      onPlay={playItem}
                      onDetails={(id) => navigate('/book/' + id)}
                      feedback={feedback[p.key]}
                      onVote={setVote}
                      onNote={setNote}
                    />
                  ))}
                </div>
              )}
              <div className="qg-result-foot">
                <button className="qg-btn ghost" type="button" onClick={() => setStep(3)}>
                  <Icon name="tune" /> Adjust answers
                </button>
                <button className="qg-btn ghost" type="button" onClick={restart}>
                  <Icon name="refresh" /> Start over
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
