import { Icon } from '@/components/common/Icon'
import {
  READER_THEMES,
  READER_SIZE_MIN,
  READER_SIZE_MAX,
  type ReaderPrefs,
  type ReaderTheme,
} from '@/store/readerPrefsStore'

interface Props {
  prefs: ReaderPrefs
  setPref: <K extends keyof ReaderPrefs>(k: K, v: ReaderPrefs[K]) => void
  onClose: () => void
}

interface SegOpt<V extends string> {
  v: V
  l: string
}

// Segmented control bound to one reader-pref key. Hoisted to module scope (not
// declared inside the panel) so it isn't recreated each render.
function Seg<K extends keyof ReaderPrefs>({
  k,
  options,
  prefs,
  setPref,
}: {
  k: K
  options: SegOpt<Extract<ReaderPrefs[K], string>>[]
  prefs: ReaderPrefs
  setPref: <KK extends keyof ReaderPrefs>(kk: KK, v: ReaderPrefs[KK]) => void
}) {
  return (
    <div className="rd-seg">
      {options.map((o) => (
        <button
          key={o.v}
          className={prefs[k] === o.v ? 'on' : ''}
          onClick={() => setPref(k, o.v as ReaderPrefs[K])}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

// Ported from Rev 4 reader.jsx ReaderPanel: reading theme, type size stepper,
// typeface / spacing / margins / alignment / layout segments, and brightness.
export function ReaderSettingsPanel({ prefs, setPref }: Props) {
  return (
    <div className="rd-panel" onClick={(e) => e.stopPropagation()}>
      <div className="rp-sec">Reading theme</div>
      <div className="rd-themes">
        {(Object.keys(READER_THEMES) as ReaderTheme[]).map((k) => {
          const th = READER_THEMES[k]
          return (
            <button
              key={k}
              className={'rd-theme' + (prefs.theme === k ? ' on' : '')}
              style={{
                background: th.bg,
                color: th.ink,
                boxShadow: `inset 0 0 0 1px ${th.line}`,
              }}
              onClick={() => setPref('theme', k)}
              title={k}
            >
              <b style={{ fontFamily: '"Libre Baskerville", serif', fontSize: 17 }}>
                Aa
              </b>
              <span style={{ textTransform: 'capitalize' }}>{k}</span>
            </button>
          )
        })}
      </div>

      <div className="rp-sec">Type size</div>
      <div className="rd-stepper">
        <button
          onClick={() => setPref('size', Math.max(READER_SIZE_MIN, prefs.size - 1))}
          title="Smaller"
        >
          <Icon name="text_decrease" />
        </button>
        <span className="rs-val">{prefs.size}px</span>
        <button
          onClick={() => setPref('size', Math.min(READER_SIZE_MAX, prefs.size + 1))}
          title="Larger"
        >
          <Icon name="text_increase" />
        </button>
      </div>

      <div className="rd-panel-grid" style={{ marginTop: 12 }}>
        <div>
          <div className="rp-sec" style={{ marginTop: 0 }}>
            Typeface
          </div>
          <Seg
            k="font"
            options={[
              { v: 'serif', l: 'Serif' },
              { v: 'sans', l: 'Sans' },
              { v: 'dyslexic', l: 'Dyslexic' },
            ]}
            prefs={prefs}
            setPref={setPref}
          />
        </div>
        <div>
          <div className="rp-sec" style={{ marginTop: 4 }}>
            Line spacing
          </div>
          <Seg
            k="lh"
            options={[
              { v: 'compact', l: 'Tight' },
              { v: 'normal', l: 'Normal' },
              { v: 'relaxed', l: 'Roomy' },
            ]}
            prefs={prefs}
            setPref={setPref}
          />
        </div>
        <div>
          <div className="rp-sec" style={{ marginTop: 4 }}>
            Margins
          </div>
          <Seg
            k="width"
            options={[
              { v: 'narrow', l: 'Narrow' },
              { v: 'medium', l: 'Medium' },
              { v: 'wide', l: 'Wide' },
            ]}
            prefs={prefs}
            setPref={setPref}
          />
        </div>
        <div>
          <div className="rp-sec" style={{ marginTop: 4 }}>
            Alignment
          </div>
          <Seg
            k="align"
            options={[
              { v: 'left', l: 'Left' },
              { v: 'justify', l: 'Justify' },
            ]}
            prefs={prefs}
            setPref={setPref}
          />
        </div>
        <div>
          <div className="rp-sec" style={{ marginTop: 4 }}>
            Layout
          </div>
          <Seg
            k="layout"
            options={[
              { v: 'scroll', l: 'Scroll' },
              { v: 'paged', l: 'Pages' },
            ]}
            prefs={prefs}
            setPref={setPref}
          />
        </div>
      </div>

      <div className="rp-sec">Brightness</div>
      <div className="rd-row">
        <Icon name="brightness_low" />
        <input
          className="rd-range"
          type="range"
          min={35}
          max={100}
          value={prefs.brightness}
          onChange={(e) => setPref('brightness', Number(e.target.value))}
        />
        <Icon name="brightness_high" />
      </div>
    </div>
  )
}
