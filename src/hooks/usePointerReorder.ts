import { useCallback, useRef, useState } from 'react'

// Vertical list reorder driven by Pointer Events, so it works with both mouse
// and touch (the HTML5 drag-and-drop API doesn't fire on touchscreens). The
// whole row is the drag handle - spread getRowProps(i) onto each row.
//
// It snapshots row midpoints on grab and, as the pointer moves, computes which
// row the pointer is over. The reorder is committed once on release (not live),
// so the snapshot stays valid for the whole drag. `dragIndex` is the row being
// dragged (for styling); `overIndex` is the row it would drop onto.
export function usePointerReorder(count: number, onReorder: (from: number, to: number) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)
  // Row DOM nodes, so we can read their live positions during a drag.
  const rowRefs = useRef<(HTMLElement | null)[]>([])
  // Midpoints (client-Y) of each row, snapshotted at grab time.
  const midpoints = useRef<number[]>([])
  const fromIndex = useRef<number | null>(null)

  const setRowRef = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      rowRefs.current[i] = el
    },
    [],
  )

  const onPointerDown = useCallback(
    (i: number) => (e: React.PointerEvent) => {
      // Left mouse button only; touch/pen always start.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      fromIndex.current = i
      setDragIndex(i)
      setOverIndex(i)
      // Snapshot each row's vertical midpoint for hit-testing during the drag.
      midpoints.current = rowRefs.current
        .slice(0, count)
        .map((el) => (el ? el.getBoundingClientRect().top + el.offsetHeight / 2 : Infinity))
      // Route all subsequent pointer moves to this element even if the finger
      // slides off it as the list reflows.
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [count],
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const from = fromIndex.current
    if (from === null) return
    const y = e.clientY
    // The row the pointer is over = how many row-midpoints sit above it. This
    // lands the dragged item at that row's position on release. Crucially, while
    // the pointer stays within its own row's band the result equals `from`, so a
    // small nudge is a no-op (not an accidental one-slot move).
    let target = 0
    for (let j = 0; j < midpoints.current.length; j++) {
      if (y > midpoints.current[j]) target = j + 1
    }
    // Dragging down past your own row counts your (now-removed) row among the
    // "above" rows, overshooting by one - correct for it.
    if (target > from) target -= 1
    if (target > midpoints.current.length - 1) target = midpoints.current.length - 1
    setOverIndex(target)
  }, [])

  const finish = useCallback(() => {
    const from = fromIndex.current
    const to = overIndex
    if (from !== null && to !== null && from !== to) onReorder(from, to)
    fromIndex.current = null
    setDragIndex(null)
    setOverIndex(null)
  }, [overIndex, onReorder])

  // Spread onto each row. `touchAction: none` stops the browser from scrolling
  // the page instead of letting us drag on touchscreens.
  const getRowProps = useCallback(
    (i: number) => ({
      ref: setRowRef(i),
      onPointerDown: onPointerDown(i),
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      style: { touchAction: 'none' as const, cursor: 'grab' },
    }),
    [setRowRef, onPointerDown, onPointerMove, finish],
  )

  return { dragIndex, overIndex, getRowProps, containerRef }
}
