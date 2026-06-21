// First-letter bucket for a name, used by the A-Z jump rail. Anything not
// starting A-Z (digits, symbols, quotes) buckets under '#'.
export function letterOf(name: string): string {
  const c = (name.trim()[0] ?? '').toUpperCase()
  return c >= 'A' && c <= 'Z' ? c : '#'
}
