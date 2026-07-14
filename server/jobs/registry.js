// The registry of scheduled jobs. Adding a job = push one entry here; the runner
// (runner.js) schedules it and the admin Jobs panel lists it. Each job is
// { id, name, description, defaultIntervalMs, run(logger) -> summary string }.

import { runSeriesRoster } from './seriesRoster.js'
import { runReleaseNotify } from './releaseNotify.js'
import { runStatsSnapshot } from './statsSnapshot.js'
import { runAbsFinishBackfill } from './absFinishBackfill.js'
import { runQueueRecompute } from './queueRecompute.js'
import { runBackupJob } from '../lib/backup.js'
import { getBackupConfig } from '../backupConfig.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

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
      'Checks the books and series people are following and sends a push notification when a book is available in the library, on its release day, or a few days before.',
    defaultIntervalMs: 6 * HOUR_MS,
    run: runReleaseNotify,
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
    defaultIntervalMs: DAY_MS, // nightly
    run: runQueueRecompute,
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
