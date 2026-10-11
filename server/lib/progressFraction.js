// How far through an item an ABS media-progress row is, 0..1.
//
// ABS keeps the fraction (`progress`, in extraData) apart from the position
// (`currentTime`) and only rewrites it when a writer sends a `progress` value.
// A position-only update moves `currentTime` and leaves `progress` behind, so a
// book 18h in can still report the fraction from where its session started. The
// position is what every writer keeps current, so derive from it when it is
// usable and fall back to the stored fraction only when there is no position.
export function progressFraction(p) {
  if (!p) return 0
  if (p.isFinished) return 1
  const duration = Number(p.duration) || 0
  const position = Number(p.currentTime) || 0
  if (duration > 0 && position > 0) return Math.min(1, position / duration)
  return Math.min(1, Math.max(0, Number(p.progress) || 0))
}

// A progress row with its `progress` replaced by the live fraction.
export function withFreshProgress(p) {
  return p ? { ...p, progress: progressFraction(p) } : p
}
