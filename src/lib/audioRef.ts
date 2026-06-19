// Shared handle to the single persistent <audio> element owned by AudioEngine.
// Lets the sleep timer ramp volume for a fade-out without prop-drilling the ref.
let el: HTMLAudioElement | null = null

export function setAudioElement(node: HTMLAudioElement | null): void {
  el = node
}

export function getAudioElement(): HTMLAudioElement | null {
  return el
}
