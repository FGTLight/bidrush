import { type PointerEvent, useState } from 'react'

const W = 240
const H = 48
const PAD = 2

/**
 * A single-series trend line for a stat tile: 2px line, no axes, and a
 * crosshair that snaps to the nearest sample with a tooltip. The tile's
 * label names the series, so there is no legend.
 */
export function Sparkline({
  values,
  sampleMs,
  unit,
  label,
}: {
  values: number[]
  /** Time between samples, for the tooltip ("6 s ago"). */
  sampleMs: number
  unit: string
  label: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (values.length < 2) return <div className="h-12" aria-hidden />

  const max = Math.max(1, ...values)
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - PAD * 2)
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2)
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - box.left) / box.width
    setHover(Math.min(values.length - 1, Math.max(0, Math.round(ratio * (values.length - 1)))))
  }

  const value = hover === null ? undefined : values[hover]
  const point =
    hover === null || value === undefined
      ? null
      : {
          x: x(hover),
          y: y(value),
          value,
          agoS: Math.round(((values.length - 1 - hover) * sampleMs) / 1000),
        }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-12 w-full touch-none"
        role="img"
        aria-label={`${label}, last ${Math.round((values.length * sampleMs) / 1000)} s; latest ${values.at(-1) ?? 0} ${unit}`}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null)
        }}
      >
        <polyline
          points={points}
          fill="none"
          className="stroke-brand-500"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {point && (
          <>
            <line
              x1={point.x}
              x2={point.x}
              y1={0}
              y2={H}
              className="stroke-ink-muted"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={3}
              className="fill-brand-500 stroke-surface"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      {point && (
        <div
          role="tooltip"
          className="pointer-events-none absolute -top-9 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-1 text-xs shadow"
          style={{ left: `${(point.x / W) * 100}%` }}
        >
          <strong className="text-ink">
            {point.value} {unit}
          </strong>{' '}
          <span className="text-ink-muted">{point.agoS === 0 ? 'now' : `${point.agoS} s ago`}</span>
        </div>
      )}
    </div>
  )
}
