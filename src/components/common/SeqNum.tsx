// A series row's number column. Omnibus ranges ("1-3.5") and half-steps ("10.5")
// don't fit the column at full size, so longer labels step down a size.
export function SeqNum({ label }: { label: string }) {
  return <div className={'sl-num' + (label.length > 2 ? ' long' : '')}>{label}</div>
}
