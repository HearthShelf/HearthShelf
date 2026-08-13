import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getAllLibraryItems, libraryKeys } from '@/api/libraries'
import { useActiveLibrary } from '@/hooks/useActiveLibrary'
import { useMediaProgress } from '@/hooks/useMediaProgress'
import { usePlayer } from '@/hooks/usePlayer'
import { Icon } from '@/components/common/Icon'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { QuestGiverChoice } from '@/components/questgiver/QuestGiverChoice'
import { QuestGiverPicker } from '@/components/questgiver/QuestGiverPicker'
import { QuestGiverSlider } from '@/components/questgiver/QuestGiverSlider'
import { QuestGiverResultCard } from '@/components/questgiver/QuestGiverResultCard'
import { useQgConfig } from '@/hooks/useQuestGiver'
import { useIgnoredItemIds } from '@/hooks/useIgnoredItemIds'
import { useRmabEnabled } from '@/hooks/useRmab'
import {
  qgBooks,
  qgBuildProfile,
  qgLibraryCandidates,
  qgExternalSearchTerms,
  qgExternalCandidates,
  qgResolvePicks,
  qgRunLabel,
  QG_EXPLORE_GENRES,
  type QgAnswers,
  type QgCandidate,
  type QgRenderedPick,
  type QgExternalHit,
} from '@/lib/questgiver'
import {
  qgRecommend,
  getRuns,
  saveRun,
  fetchServerRuns,
  getFeedback,
  setFeedback as persistFeedback,
  type QgRun,
  type QgFeedback,
} from '@/api/questgiver'
import { searchCatalog } from '@/api/requests'
import { useSubmitRequest } from '@/hooks/useRmab'

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
  const rmabEnabled = useRmabEnabled()

  const allItems = useMemo(() => itemsData?.results ?? [], [itemsData])
  const books = useMemo(() => qgBooks(allItems, progressById), [allItems, progressById])
  // Books in series the listener ignored - kept out of the candidate pool and
  // out of resolved picks, so a saved run never replays one either.
  const ignoredIds = useIgnoredItemIds()

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
  // "Look beyond my library" is always available - it surfaces books to buy on
  // Audible, or (when RMAB is connected) to request. RMAB only gates the request
  // ACTION, never the recommendation.
  const [lookBeyond, setLookBeyond] = useState(false)
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
  // Per-pick request state, keyed by pick.key.
  const [requesting, setRequesting] = useState<Record<string, 'pending' | 'done'>>({})

  // Hydrate run history from the server (cross-device); localStorage seeded the
  // initial state for an instant first paint.
  useEffect(() => {
    let cancelled = false
    fetchServerRuns().then((serverRuns) => {
      if (!cancelled) setRuns(serverRuns)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // profile recomputes from history OR the hand-picked list
  const profile = useMemo(() => {
    if (basis === 'list' && picked.size)
      return qgBuildProfile(books.filter((b) => picked.has(b.id)))
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

  const aiLabel = config?.enabled ? (config.provider ?? 'AI') : 'AI'
  const exhausted = config?.limit != null && config.remaining != null && config.remaining <= 0

  const setVote = (key: string, vote: 1 | -1 | 0) => {
    const fb: QgFeedback = vote === 0 ? {} : { vote }
    setFeedback(persistFeedback(key, fb))
  }
  const setNote = (key: string, note: string) => {
    setFeedback(persistFeedback(key, { note: note || undefined }))
  }

  // Queue an external pick as a ReadMeABook request. itemId carries the asin.
  const requestPick = async (pick: QgRenderedPick): Promise<boolean> => {
    if (!pick.itemId) return false
    setRequesting((r) => ({ ...r, [pick.key]: 'pending' }))
    try {
      await submitRequest.mutateAsync({
        asin: pick.itemId,
        title: pick.title,
        author: pick.author,
      })
      setRequesting((r) => ({ ...r, [pick.key]: 'done' }))
      return true
    } catch {
      setRequesting((r) => {
        const next = { ...r }
        delete next[pick.key]
        return next
      })
      return false
    }
  }

  const submitRequest = useSubmitRequest()

  // Search the external catalog across several terms and flatten to hits. Each
  // search is best-effort; a failed term is skipped so one bad query can't sink
  // the whole run. Caps the pool so the AI prompt stays small.
  const fetchExternalHits = async (terms: string[]): Promise<QgExternalHit[]> => {
    const results = await Promise.allSettled(terms.map((t) => searchCatalog(t)))
    const hits: QgExternalHit[] = []
    const seen = new Set<string>()
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const c of r.value.results ?? []) {
        if (!c.asin || seen.has(c.asin)) continue
        seen.add(c.asin)
        hits.push({
          id: c.asin,
          title: c.title,
          author: c.author,
          hours: c.durationMinutes ? Math.round((c.durationMinutes / 60) * 10) / 10 : 0,
        })
        if (hits.length >= 30) break
      }
      if (hits.length >= 30) break
    }
    return hits
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
      includeRequest: lookBeyond,
      count: lookBeyond ? 5 : 4,
    }

    // Library pool always; external pool (catalog search) when looking beyond.
    let candidates: QgCandidate[] = qgLibraryCandidates(books, ignoredIds)
    const externalById = new Map<string, QgCandidate>()
    if (lookBeyond) {
      const terms = qgExternalSearchTerms(profile, books, weights ?? {})
      const hits = await fetchExternalHits(terms)
      const ext = qgExternalCandidates(hits, books)
      ext.forEach((c) => externalById.set(c.id, c))
      candidates = [...candidates, ...ext]
    }

    const out = await qgRecommend(profile, answers, candidates)

    // Resolving picks (owned vs external, dedupe, repeat counts) is shared with
    // the hosted app and mobile so all three agree on what a pick becomes.
    const top = qgResolvePicks({
      result: out,
      books,
      externalById,
      priorPicks: runs.flatMap((r) => r.picks),
      canRequest: rmabEnabled,
      ignoredIds,
      count: answers.count ?? 4,
    })

    // stamp a label + timestamp and persist the run
    const now = new Date()
    const runRec: QgRun = {
      id: 'run' + now.getTime(),
      label: qgRunLabel(direction, mood, weights ?? {}),
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
          <Icon name="favorite" fill style={{ fontSize: 15, color: 'var(--accent)' }} /> QuestGiver
        </div>
        <h1 className="title-xl">Find your next listen</h1>
        {config?.limit != null && config.remaining != null && (
          <div className="qg-limit-note">
            <Icon name="bolt" fill /> {config.remaining} of {config.limit}{' '}
            {config.remaining === 1 ? 'match' : 'matches'} left
            {config.period === 'week'
              ? ' this week'
              : config.period === 'month'
                ? ' this month'
                : ' today'}
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
        <div
          key={s}
          className={'qg-step' + (i === stepIdx ? ' on' : '') + (i < stepIdx ? ' done' : '')}
        >
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
                        onRequest={rmabEnabled ? requestPick : undefined}
                        requestState={requesting[p.key] ?? 'idle'}
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
                <QuestGiverPicker
                  books={books}
                  picked={picked}
                  onToggle={(id) =>
                    setPicked((s) => {
                      const n = new Set(s)
                      if (n.has(id)) n.delete(id)
                      else n.add(id)
                      return n
                    })
                  }
                />
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
                      , while your <b>{profile.cold.genre}</b> shelf ({profile.cold.owned} titles)
                      has gone quiet
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

              {/* Explore: genres the listener may not own yet. Dialing one up
                  steers the match toward fresh territory (and, with "look beyond"
                  on, toward external picks). */}
              <div className="qg-explore">
                <div className="qg-explore-head">
                  <Icon name="explore" />
                  <span>Explore something new</span>
                  <span className="qg-explore-sub">Genres outside your usual shelf</span>
                </div>
                <div className="qg-weights">
                  {QG_EXPLORE_GENRES.filter((g) => !profile.stat[g]?.owned).map((g) => (
                    <QuestGiverSlider
                      key={g}
                      label={g}
                      sub="Not in your library yet"
                      value={weights[g] ?? 0}
                      onChange={(v) => setW(g, v)}
                    />
                  ))}
                </div>
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

              <div className="qg-tune-block">
                <label className="qg-toggle-row">
                  <div>
                    <div className="qg-wlabel">Look beyond my library</div>
                    <div className="qg-wsub">
                      {rmabEnabled
                        ? 'Suggest titles you can request via ReadMeABook, or buy on Audible.'
                        : 'Suggest great titles to buy on Audible, not just what you own.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={'qg-switch' + (lookBeyond ? ' on' : '')}
                    onClick={() => setLookBeyond((v) => !v)}
                  >
                    <span />
                  </button>
                </label>
              </div>

              {exhausted && (
                <div className="qg-limit-note" role="alert">
                  <Icon name="bolt" fill /> You're out of matches
                  {config?.period === 'week'
                    ? ' for this week'
                    : config?.period === 'month'
                      ? ' for this month'
                      : ' for today'}
                  . Check back later to find your next listen.
                </div>
              )}
              <div className="qg-foot">
                <button className="qg-btn ghost" type="button" onClick={() => setStep(2)}>
                  <Icon name="arrow_back" /> Back
                </button>
                <button className="qg-btn qg-go" type="button" onClick={run} disabled={exhausted}>
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
                {mood.trim() && (
                  <span className="qg-craft-chip">&ldquo;{mood.trim().slice(0, 40)}&rdquo;</span>
                )}
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
                      onRequest={rmabEnabled ? requestPick : undefined}
                      requestState={requesting[p.key] ?? 'idle'}
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
