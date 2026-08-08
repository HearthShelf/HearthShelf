// Discover backend logic: builds the monthly AI shelf prompt from a client-
// supplied history summary + candidate pool, applies the user's stored feedback
// and star ratings (drop not_interested/dislike, favor likes and 4-5 stars), and
// provides a deterministic
// heuristic fallback when no AI is configured.
//
// The server holds no ABS data of its own - the client posts the summary +
// candidates, the server only adds the persisted feedback and the AI call.

// A candidate: { id, title, author, genre, hours }
// Summary: { totalFinished, dominant, topAuthors[], topNarrators[], recentFinishes[] }
// Feedback: { [itemKey]: { vote? } }
// Ratings:  { [itemKey]: 1-5 } - a separate map, since star ratings are
//           site-wide (book_ratings) and outlive Discover being switched off.

const SHELF_SIZE = 8

// Filter the candidate pool by the user's feedback: never resurface things they
// said they're not interested in or disliked.
export function filterByFeedback(candidates, feedback) {
  return candidates.filter((c) => {
    const fb = feedback[c.id]
    if (!fb) return true
    return fb.vote !== 'not_interested' && fb.vote !== 'dislike'
  })
}

// Liked / highly-rated item ids, to nudge the model toward similar picks. Votes
// and ratings arrive separately: ratings are a site-wide signal (book_ratings),
// not part of Discover's own feedback.
function likedIds(feedback, ratings) {
  const ids = new Set()
  for (const [id, fb] of Object.entries(feedback)) {
    if (fb.vote === 'like') ids.add(id)
  }
  for (const [id, rating] of Object.entries(ratings)) {
    if (rating >= 4) ids.add(id)
  }
  return [...ids]
}

export function craftDiscoverPrompt(summary, candidates, feedback, ratings, month) {
  const liked = likedIds(feedback, ratings)
  const pool = candidates
    .map((c) => `${c.id} | ${c.title} - ${c.author} | ${c.genre} | ${c.hours}h`)
    .join('\n')
  return [
    'You are QuestGiver, curating ONE themed shelf of audiobooks for a listener inside HearthShelf.',
    `This is their pick for ${month} - a single cohesive shelf, not a grab-bag.`,
    '',
    'LISTENER:',
    `- Finished ${summary.totalFinished ?? 0} books; lately mostly ${summary.dominant || 'varied'}.`,
    summary.topAuthors?.length ? `- Returns to authors: ${summary.topAuthors.join(', ')}.` : '',
    summary.topNarrators?.length ? `- Favors narrators: ${summary.topNarrators.join(', ')}.` : '',
    summary.recentFinishes?.length
      ? `- Recently finished: ${summary.recentFinishes.join('; ')}.`
      : '',
    liked.length
      ? `- Has liked these candidate ids before (lean toward their vibe): ${liked.join(', ')}.`
      : '',
    '',
    'CANDIDATES (id | title - author | genre | length) - pick ONLY from these ids:',
    pool,
    '',
    `Choose ${SHELF_SIZE} that hang together as one shelf with a clear through-line`,
    '(a mood, a theme, a thread from their history). Order best-first.',
    'Write a short shelf "intro" (one sentence, warm, names the through-line) and a',
    'one-sentence reason per pick in a calm librarian voice.',
    'Return ONLY JSON: {"intro":"...","picks":[{"id":"...","reason":"..."}]}',
  ]
    .filter(Boolean)
    .join('\n')
}

// Deterministic fallback shelf when AI is unavailable. Leans on the dominant
// genre + liked patterns, then fills with the rest of the (feedback-filtered)
// pool. Stable for a given month/input.
export function heuristicShelf(summary, candidates, feedback, ratings) {
  const pool = filterByFeedback(candidates, feedback)
  const dominant = summary.dominant || null
  const scored = pool
    .map((c, i) => {
      let s = 0
      if (dominant && c.genre === dominant) s += 5
      if (feedback[c.id]?.vote === 'like') s += 4
      s += (ratings[c.id] ?? 0) * 0.5
      // gentle deterministic spread by index so ties don't all clump
      s += ((i * 7) % 5) * 0.1
      return { c, s }
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, SHELF_SIZE)
  const intro = dominant
    ? `A fresh ${dominant} shelf pulled from books you haven't started yet.`
    : 'A fresh shelf pulled from books you haven’t started yet.'
  return {
    intro,
    picks: scored.map((x) => ({
      id: x.c.id,
      reason:
        dominant && x.c.genre === dominant
          ? `Right in your ${dominant} lane.`
          : 'Worth a look from your shelf.',
    })),
  }
}
