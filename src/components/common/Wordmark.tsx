interface WordmarkProps {
  className?: string
}

export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={`font-brand font-bold tracking-tight ${className ?? ''}`}>
      <span className="text-hearth">Hearth</span>
      <span className="text-shelf">Shelf</span>
    </span>
  )
}
