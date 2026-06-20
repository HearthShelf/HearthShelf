// A tiny side-by-side illustration of the two cover styles, shown in a hover
// popover next to the "Cover style" setting so the choice is self-explanatory.
export function CoverStyleDemo() {
  return (
    <div className="cs-demo">
      <div className="cs-col">
        <div className="cs-stage cs-floating">
          <div className="cs-mini-cv" />
          <div className="cs-cap">
            <i style={{ width: 34 }} />
            <i style={{ width: 22 }} />
          </div>
        </div>
        <span>Floating - artwork sits on the page</span>
      </div>
      <div className="cs-col">
        <div className="cs-stage">
          <div className="cs-card">
            <div className="cs-mini-cv" />
            <div className="cs-cap">
              <i style={{ width: 34 }} />
              <i style={{ width: 22 }} />
            </div>
          </div>
        </div>
        <span>Cards - artwork sits on a surface</span>
      </div>
    </div>
  )
}
