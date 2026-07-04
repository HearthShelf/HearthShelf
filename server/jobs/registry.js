// The registry of scheduled jobs. Adding a job = push one entry here; the runner
// (runner.js) schedules it and the admin Jobs panel lists it. Each job is
// { id, name, description, defaultIntervalMs, run(logger) -> summary string }.

import { runSeriesRoster } from './seriesRoster.js'

const DAY_MS = 24 * 60 * 60 * 1000

export const JOBS = [
  {
    id: 'series-roster',
    name: 'Series roster refresh',
    description:
      'Resolves every series in your library against Audible and records which books you own, so missing-book lists load instantly and accurately.',
    defaultIntervalMs: DAY_MS, // nightly
    run: runSeriesRoster,
  },
]

export function getJob(id) {
  return JOBS.find((j) => j.id === id) ?? null
}
