interface IconProps {
  name: string
  fill?: boolean
  className?: string
  style?: React.CSSProperties
  title?: string
}

// Material Symbols Rounded - ligature-based icon font. The glyph name is the
// text content; `fill` swaps to the filled variant via font-variation-settings.
export function Icon({ name, fill, className, style, title }: IconProps) {
  return (
    <span
      className={'ms' + (fill ? ' fill' : '') + (className ? ' ' + className : '')}
      style={style}
      title={title}
      aria-hidden
    >
      {name}
    </span>
  )
}
