// The registry of scheduled jobs. Adding a job = push one entry here; the runner
// (runner.js) schedules it and the admin Jobs panel lists it. Each job is
// { id, name, description, defaultIntervalMs, run(logger) -> summary string }.

import { runSeriesRoster } from './seriesRoster.js'
import { runReleaseNotify } from './releaseNotify.js'
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
