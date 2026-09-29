// Shared handle to the <audio> element AudioEngine is currently playing through
// (it alternates between two across track changes). Lets the sleep timer ramp
// volume for a fade-out and the media session act on it without prop-drilling.
let el: HTMLAudioElement | null = null

export function setAudioElement(node: HTMLAudioElement | null): void {
  el = node
}

export function getAudioElement(): HTMLAudioElement | null {
  return el
}
