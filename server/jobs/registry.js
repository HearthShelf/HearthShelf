// The registry of scheduled jobs. Adding a job = push one entry here; the runner
// (runner.js) schedules it and the admin Jobs panel lists it. Each job is
// { id, name, description, defaultIntervalMs, run(logger) -> summary string }.

import { runSeriesRoster } from './seriesRoster.js'
import { runReleaseNotify } from './releaseNotify.js'
import { runStatsSnapshot } from './statsSnapshot.js'
import { runRatingPrompt } from './ratingPrompt.js'
import { runAbsFinishBackfill } from './absFinishBackfill.js'
import { runQueueRecompute } from './queueRecompute.js'
import { runClubAutoAdvance } from './clubAutoAdvance.js'
import { runBackupJob } from '../lib/backup.js'
import { getBackupConfig } from '../backupConfig.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// When the nightly Auto-queue catch-up runs (local server time). Exported so the
// queue route can tell users when the next rebuild lands without re-deriving it.
export const QUEUE_RECOMPUTE_CRON = '0 3 * * *'

export const JOBS = [
  {
    id: 'series-roster',
    name: 'Series roster refresh',
    description:
      'Resolves every series in your library against Audible and records which books you own, so missing-book lists load instantly and accurately.',
    defaultIntervalMs: DAY_MS, // nightly
    run: runSeriesRoster,
  },
  {
    id: 'release-notify',
    name: 'Release notifications',
    description:
      'Checks followed books and series and sends in-app, email, or mobile alerts when a book is available, on release day, or a few days before.',
    defaultIntervalMs: 6 * HOUR_MS,
    run: runReleaseNotify,
  },
  {
    id: 'rating-prompt',
    name: 'Finished-book rating prompts',
    description:
      "Asks how a book was shortly after you finish it, so the prompt arrives while it's still fresh. Runs hourly; it only looks at books finished recently, so it stays cheap.",
    // Hourly, unlike the nightly snapshot that also detects completions. Kept
    // separate precisely so this can run often: the snapshot scans ABS's
    // unindexed session table and re-evaluates achievements, which is far too
    // heavy to repeat 24x a day for one cheap signal.
    defaultIntervalMs: HOUR_MS,
    run: runRatingPrompt,
  },
  {
    id: 'stats-snapshot',
    name: 'Listening history snapshot',
    description:
      "Records each person's daily listening so HearthShelf keeps a lasting history AudiobookShelf never saves - powering the listening heatmap, long-term trends, and best-ever streaks.",
    defaultIntervalMs: DAY_MS, // nightly
    run: runStatsSnapshot,
  },
  {
    id: 'abs-finish-backfill',
    name: 'Reading-history backfill',
    description:
      "Marks books from your imported reading history as finished in your library once they're added, using the date you read them - so your Stats page reflects books you finished before you owned them here.",
    defaultIntervalMs: DAY_MS, // nightly
    run: runAbsFinishBackfill,
  },
  {
    id: 'queue-recompute',
    name: 'Up-next queue refresh',
    description:
      'Rebuilds your Auto up-next list overnight so new books in series you are reading show up on their own, without you having to open the app.',
    // Cron-scheduled at 3am rather than interval-from-boot: users are shown a
    // countdown to this run (see /hs/queue/status), and "tonight at 3am" is only
    // truthful if it fires at a fixed hour. An interval from boot would drift to
    // whatever time the box last restarted. defaultIntervalMs stays as the
    // fallback the runner uses if the cron is ever cleared.
    defaultIntervalMs: DAY_MS,
    cronSchedule: async () => QUEUE_RECOMPUTE_CRON,
    run: runQueueRecompute,
  },
  {
    id: 'club-auto-advance',
    name: 'Book club auto-advance',
    description:
      'Moves a book club on to its next book once everyone who started the current one has finished it, for clubs whose owner turned that on. Only runs for those clubs, so it costs nothing otherwise.',
    // Hourly: the club should move on the same evening the last member finishes,
    // not the next morning. The pass reads only clubs with the switch on, so a
    // server with none does a single indexed query and stops.
    defaultIntervalMs: HOUR_MS,
    run: runClubAutoAdvance,
  },
  {
    id: 'hs-backup',
    name: 'HearthShelf backup',
    description:
      "Snapshots HearthShelf's own data (settings, clubs, notes, reading history, profile photos, integration config) to a downloadable backup file. Runs on the schedule set on the Backups page.",
    // Cron-scheduled, not interval-scheduled: the runner reads cronSchedule()
    // each minute instead of using defaultIntervalMs. Kept for the "Run now"
    // path and as a fallback if the cron is cleared.
    defaultIntervalMs: DAY_MS,
    cronSchedule: async () => (await getBackupConfig()).schedule,
    run: runBackupJob,
  },
]

export function getJob(id) {
  return JOBS.find((j) => j.id === id) ?? null
}
