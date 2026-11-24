import type { ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { BreakdownItem, SensitivityBar, Snapshot } from '@/lib/cbam-api'
import { VIZ_VARS, fmt } from './format'

const AXIS = { fontSize: 12, fill: 'var(--muted-foreground)' }

function TooltipBox({ children }: { children: ReactNode }) {
  return (
    <div className='rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md'>
      {children}
    </div>
  )
}

/** Horizontal bars: one measure (allocated tCO2) per source, largest first. */
export function BreakdownChart({ items }: { items: BreakdownItem[] }) {
  const data = items.map((item) => ({
    ...item,
    pct: `${fmt(item.share * 100, 1)}%`,
  }))
  return (
    <div
      className={VIZ_VARS}
      style={{ height: Math.max(160, data.length * 56 + 40) }}
    >
      <ResponsiveContainer width='100%' height='100%'>
        <BarChart
          data={data}
          layout='vertical'
          margin={{ top: 4, right: 64, bottom: 4, left: 8 }}
          barCategoryGap={14}
        >
          <CartesianGrid horizontal={false} stroke='var(--viz-grid)' />
          <XAxis
            type='number'
            tick={AXIS}
            axisLine={false}
            tickLine={false}
            unit=' t'
          />
          <YAxis
            type='category'
            dataKey='label'
            width={170}
            tick={AXIS}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
            content={({ active, payload }) => {
              const item = active && payload?.[0]?.payload
              if (!item) return null
              return (
                <TooltipBox>
                  <p className='font-semibold'>{item.label}</p>
                  <p>
                    {fmt(item.tco2, 2)} tCO₂ · {item.pct} of total
                  </p>
                  <p>{fmt(item.see_contribution, 4)} tCO₂ per t of product</p>
                  {item.fallback_based && (
                    <p className='text-muted-foreground'>
                      Uses a register fallback
                    </p>
                  )}
                </TooltipBox>
              )
            }}
          />
          <Bar
            dataKey='tco2'
            fill='var(--viz-1)'
            radius={[0, 4, 4, 0]}
            maxBarSize={28}
          >
            <LabelList
              dataKey='pct'
              position='right'
              style={{ fontSize: 12, fill: 'var(--foreground)' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Tornado: change in SEE when each input moves down or up by the swing. */
export function TornadoChart({
  bars,
  base,
  swingPct,
}: {
  bars: SensitivityBar[]
  base: number
  swingPct: number
}) {
  const data = bars.map((bar) => ({
    label: bar.label,
    low: bar.see_low - base,
    high: bar.see_high - base,
    bar,
  }))
  return (
    <div className={VIZ_VARS}>
      <div className='mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground'>
        <span className='flex items-center gap-1.5'>
          <span className='inline-block size-3 rounded-sm bg-[var(--viz-1)]' />{' '}
          Input −{swingPct}%
        </span>
        <span className='flex items-center gap-1.5'>
          <span className='inline-block size-3 rounded-sm bg-[var(--viz-2)]' />{' '}
          Input +{swingPct}%
        </span>
      </div>
      <div style={{ height: data.length * 34 + 50 }}>
        <ResponsiveContainer width='100%' height='100%'>
          <BarChart
            data={data}
            layout='vertical'
            stackOffset='sign'
            margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
          >
            <CartesianGrid horizontal={false} stroke='var(--viz-grid)' />
            <XAxis
              type='number'
              tick={AXIS}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) =>
                v > 0 ? `+${fmt(v, 3)}` : fmt(v, 3)
              }
            />
            <YAxis
              type='category'
              dataKey='label'
              width={190}
              tick={AXIS}
              axisLine={false}
              tickLine={false}
            />
            <ReferenceLine
              x={0}
              stroke='var(--foreground)'
              strokeOpacity={0.5}
            />
            <Tooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
              content={({ active, payload }) => {
                const row = active && payload?.[0]?.payload
                if (!row) return null
                const bar = row.bar as SensitivityBar
                return (
                  <TooltipBox>
                    <p className='font-semibold'>{bar.label}</p>
                    <p>
                      Base {fmt(bar.base_value, 4)} {bar.unit}
                    </p>
                    <p>
                      −{swingPct}% → SEE {fmt(bar.see_low, 4)} · +{swingPct}% →
                      SEE {fmt(bar.see_high, 4)}
                    </p>
                    {bar.note && (
                      <p className='text-muted-foreground'>{bar.note}</p>
                    )}
                  </TooltipBox>
                )
              }}
            />
            <Bar
              dataKey='low'
              stackId='s'
              fill='var(--viz-1)'
              radius={2}
              maxBarSize={20}
              stroke='var(--background)'
              strokeWidth={1}
            />
            <Bar
              dataKey='high'
              stackId='s'
              fill='var(--viz-2)'
              radius={2}
              maxBarSize={20}
              stroke='var(--background)'
              strokeWidth={1}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/** Baseline vs scenario: SEE point on its P5-P95 band, one shared axis. */
export function BandComparison({
  baseline,
  scenario,
}: {
  baseline: Snapshot
  scenario: Snapshot
}) {
  const rows = [
    {
      name: 'Baseline',
      s: baseline,
      tone: 'bg-muted-foreground/40',
      dot: 'bg-foreground',
    },
    {
      name: 'Scenario',
      s: scenario,
      tone: 'bg-[var(--viz-1)]/50',
      dot: 'bg-[var(--viz-1)]',
    },
  ]
  const lo = Math.min(baseline.band.p5, scenario.band.p5)
  const hi = Math.max(baseline.band.p95, scenario.band.p95)
  const pad = (hi - lo) * 0.08 || 0.05
  const min = lo - pad
  const span = hi + pad - min
  const pos = (v: number) => `${((v - min) / span) * 100}%`
  return (
    <div className={`space-y-4 ${VIZ_VARS}`}>
      {rows.map((row) => (
        <div
          key={row.name}
          className='grid grid-cols-[80px_1fr_150px] items-center gap-3'
        >
          <span className='text-sm text-muted-foreground'>{row.name}</span>
          <div
            className='relative h-6'
            title={`P5 ${fmt(row.s.band.p5, 4)} · P95 ${fmt(row.s.band.p95, 4)}`}
          >
            <div className='absolute inset-x-0 top-1/2 h-px bg-border' />
            <div
              className={`absolute top-1/2 h-3 -translate-y-1/2 rounded-full ${row.tone}`}
              style={{
                left: pos(row.s.band.p5),
                width: `calc(${pos(row.s.band.p95)} - ${pos(row.s.band.p5)})`,
              }}
            />
            <div
              className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background ${row.dot}`}
              style={{ left: pos(row.s.see_tco2_per_t) }}
            />
          </div>
          <span className='text-sm tabular-nums'>
            <strong>{fmt(row.s.see_tco2_per_t, 4)}</strong>{' '}
            <span className='text-xs text-muted-foreground'>
              ({fmt(row.s.band.p5, 3)}–{fmt(row.s.band.p95, 3)})
            </span>
          </span>
        </div>
      ))}
      <p className='text-xs text-muted-foreground'>
        Dot = SEE (tCO₂e/t). Bar = P5–P95 Monte Carlo band, same seed for both
        runs.
      </p>
    </div>
  )
}
