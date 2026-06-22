// Samples a representative accent colour from a book's real cover artwork.
//
// The signature cover-glow blooms behind the now-playing book; this is what
// makes that bloom come from the artwork itself rather than a typeset fallback.
// Covers are served same-origin through the /abs-api proxy, so the canvas is
// never tainted and getImageData works without CORS gymnastics.
//
// Strategy: downscale the cover to a tiny canvas, then average its pixels with
// a weighting that favours saturated, mid-bright pixels. A plain mean tends to
// collapse to muddy grey/brown; weighting by saturation lets a cover's actual
// signature hue win while still ignoring near-black/near-white borders.

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return '#' + h(r) + h(g) + h(b)
}

// Saturation of an sRGB pixel in [0,1] (HSL-style: (max-min)/(1-|2L-1|)).
function saturationOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b) / 255
  const mn = Math.min(r, g, b) / 255
  const l = (mx + mn) / 2
  const d = mx - mn
  if (d === 0) return 0
  return d / (1 - Math.abs(2 * l - 1))
}

function extractFromImage(img: HTMLImageElement): string | null {
  const S = 24 // downsample target; small is plenty for an average
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, S, S)

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, S, S).data
  } catch {
    // Tainted canvas (shouldn't happen same-origin) - bail to fallback.
    return null
  }

  let wr = 0, wg = 0, wb = 0, wsum = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
    if (a < 200) continue // skip transparent
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    if (lum < 0.08 || lum > 0.95) continue // skip near-black / near-white
    // Weight by saturation (squared, to strongly prefer colourful pixels) with
    // a small floor so an entirely muted cover still yields its average tone.
    const sat = saturationOf(r, g, b)
    const w = sat * sat + 0.05
    wr += r * w; wg += g * w; wb += b * w; wsum += w
  }
  if (wsum === 0) return null

  let r = wr / wsum, g = wg / wsum, b = wb / wsum

  // Nudge very dark or very desaturated results toward a usable glow tone so
  // the bloom stays visible against the dark UI.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  if (lum < 0.22) {
    const boost = 0.22 / Math.max(lum, 0.02)
    r = Math.min(255, r * boost); g = Math.min(255, g * boost); b = Math.min(255, b * boost)
  }

  return rgbToHex(r, g, b)
}

// Resolve the dominant accent colour for a cover URL. Returns null if the image
// can't be loaded or read (callers fall back to the typeset tint). Results are
// cached per URL; concurrent calls share one in-flight load.
export function coverAccent(src: string): Promise<string | null> {
  if (cache.has(src)) return Promise.resolve(cache.get(src) ?? null)
  const existing = inflight.get(src)
  if (existing) return existing

  const p = new Promise<string | null>((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      const hex = extractFromImage(img)
      cache.set(src, hex)
      inflight.delete(src)
      resolve(hex)
    }
    img.onerror = () => {
      cache.set(src, null)
      inflight.delete(src)
      resolve(null)
    }
    img.src = src
  })
  inflight.set(src, p)
  return p
}
