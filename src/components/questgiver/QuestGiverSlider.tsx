interface QuestGiverSliderProps {
  label: string
  sub?: string
  value: number
  onChange: (v: number) => void
  dim?: boolean
}

// Weighted 0-10 slider row used in the QuestGiver weights + fine-tune steps.
export function QuestGiverSlider({ label, sub, value, onChange, dim }: QuestGiverSliderProps) {
  return (
    <div className={'qg-wrow' + (dim ? ' dim' : '')}>
      <div className="qg-wmeta">
        <div className="qg-wlabel">{label}</div>
        {sub && <div className="qg-wsub">{sub}</div>}
      </div>
      <div className="qg-wctrl">
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          value={value}
          onChange={(e) => onChange(+e.target.value)}
          style={{ ['--qgfill' as string]: value * 10 + '%' }}
        />
        <span className="qg-wval" data-zero={value === 0}>
          {value}
        </span>
      </div>
    </div>
  )
}
