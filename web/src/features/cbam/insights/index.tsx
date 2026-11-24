import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AlertOctagon,
  ArrowRight,
  Calculator,
  FlaskConical,
  Lightbulb,
  Loader2,
  PieChart,
  Sigma,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ApiError,
  estimateCost,
  getCostParameters,
  getInsights,
  runScenario,
  type CostEstimate,
  type CostParameters,
  type Gap,
  type Insights,
  type ScenarioResult,
  type ScenarioSpec,
} from '@/lib/cbam-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Main } from '@/components/layout/main'
import { CbamTopBar } from '../components/cbam-top-bar'
import { PageHeader } from '../components/page-header'
import { StatusBadge } from '../components/status-badge'
import { useServerWorkspace } from '../lib/use-server-workspace'
import { BandComparison, BreakdownChart, TornadoChart } from './charts'
import { fmt } from './format'

const FUELS = [
  { value: 'none', label: 'No change' },
  { value: 'natural_gas', label: 'Natural gas' },
  { value: 'diesel', label: 'Diesel (HSD)' },
  { value: 'lpg', label: 'LPG' },
  { value: 'furnace_oil', label: 'Furnace oil' },
]

type ScenarioForm = {
  name: string
  electricity_cut_pct: string
  ppa_share_pct: string
  ppa_ef: string
  fuel_cut_pct: string
  fuel_switch_to: string
  precursor_see: string
  precursor_cut_pct: string
}

const EMPTY_FORM: ScenarioForm = {
  name: 'My scenario',
  electricity_cut_pct: '',
  ppa_share_pct: '',
  ppa_ef: '0',
  fuel_cut_pct: '',
  fuel_switch_to: 'none',
  precursor_see: '',
  precursor_cut_pct: '',
}

const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

function toSpec(form: ScenarioForm): ScenarioSpec {
  return {
    name: form.name || 'Custom scenario',
    electricity_cut_pct: num(form.electricity_cut_pct) ?? 0,
    ppa_share_pct: num(form.ppa_share_pct) ?? 0,
    ppa_ef: num(form.ppa_ef) ?? 0,
    fuel_cut_pct: num(form.fuel_cut_pct) ?? 0,
    fuel_switch_to: form.fuel_switch_to === 'none' ? null : form.fuel_switch_to,
    precursor_see: num(form.precursor_see) ?? null,
    precursor_cut_pct: num(form.precursor_cut_pct) ?? 0,
  }
}

function fromSpec(spec: ScenarioSpec): ScenarioForm {
  const s = (v?: number | null) => (v ? String(Number(v.toFixed(4))) : '')
  return {
    name: spec.name ?? 'Scenario',
    electricity_cut_pct: s(spec.electricity_cut_pct),
    ppa_share_pct: s(spec.ppa_share_pct),
    ppa_ef: String(spec.ppa_ef ?? 0),
    fuel_cut_pct: s(spec.fuel_cut_pct),
    fuel_switch_to: spec.fuel_switch_to ?? 'none',
    precursor_see: s(spec.precursor_see),
    precursor_cut_pct: s(spec.precursor_cut_pct),
  }
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className='text-xs text-muted-foreground'>{hint}</p>}
    </div>
  )
}

export function InsightsPage() {
  const { workspaceId, state, error, profileMissing } = useServerWorkspace()
  const [insights, setInsights] = useState<Insights | null>(null)
  const [gaps, setGaps] = useState<Gap[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<ScenarioForm>(EMPTY_FORM)
  const [scenario, setScenario] = useState<ScenarioResult | null>(null)
  const [running, setRunning] = useState(false)
  const [params, setParams] = useState<CostParameters | null>(null)
  const [cost, setCost] = useState({
    shipment_tonnes: '25',
    certificate_price_eur: '',
    year: '2026',
    benchmark_tco2_per_t: '0',
    carbon_price_paid_eur_per_t: '0',
    eur_to_inr: '',
    use_scenario: false,
  })
  const [estimate, setEstimate] = useState<CostEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)

  const load = useCallback(async () => {
    if (!workspaceId || !state) return
    setLoading(true)
    try {
      setInsights(await getInsights(workspaceId))
      setGaps(null)
    } catch (cause) {
      setInsights(null)
      if (cause instanceof ApiError && cause.status === 422) {
        setGaps(((cause.body as { gaps?: Gap[] })?.gaps ?? []) as Gap[])
      } else {
        toast.error(
          cause instanceof Error ? cause.message : 'Could not load insights.'
        )
      }
    } finally {
      setLoading(false)
    }
  }, [workspaceId, state])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load])

  useEffect(() => {
    getCostParameters()
      .then(setParams)
      .catch(() => setParams(null))
  }, [])

  const simulate = async (spec: ScenarioSpec = toSpec(form)) => {
    setRunning(true)
    try {
      setScenario(await runScenario(workspaceId, spec))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Scenario failed.')
    } finally {
      setRunning(false)
    }
  }

  const tryTip = (spec: ScenarioSpec) => {
    setForm(fromSpec(spec))
    void simulate(spec)
    document.getElementById('simulator')?.scrollIntoView({ behavior: 'smooth' })
  }

  const runCost = async () => {
    const tonnes = Number(cost.shipment_tonnes)
    if (!(tonnes > 0)) return toast.error('Enter the shipment size in tonnes.')
    setEstimating(true)
    try {
      setEstimate(
        await estimateCost(workspaceId, {
          shipment_tonnes: tonnes,
          certificate_price_eur:
            num(cost.certificate_price_eur) ??
            params?.default_price.eur_per_tco2,
          year: Number(cost.year),
          benchmark_tco2_per_t: num(cost.benchmark_tco2_per_t) ?? 0,
          carbon_price_paid_eur_per_t:
            num(cost.carbon_price_paid_eur_per_t) ?? 0,
          eur_to_inr: num(cost.eur_to_inr) ?? null,
          scenario: cost.use_scenario ? toSpec(form) : null,
        })
      )
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Estimate failed.')
    } finally {
      setEstimating(false)
    }
  }

  const b = insights?.baseline
  const eur = (n: number) => `€${fmt(n, 0)}`

  return (
    <>
      <CbamTopBar />
      <Main>
        <PageHeader
          title='Carbon insights'
          description='Where the emissions come from, what would reduce them, and what CBAM certificates could cost. Every figure is recalculated by the deterministic engine.'
        >
          <Button
            variant='outline'
            onClick={() => void load()}
            disabled={loading || !state}
          >
            {loading && <Loader2 className='size-4 animate-spin' />}
            Refresh
          </Button>
        </PageHeader>

        {error && (
          <Alert variant='destructive' className='mb-4'>
            <AlertTitle>Backend unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {profileMissing.length > 0 ? (
          <Card>
            <CardContent className='py-10 text-center text-sm text-muted-foreground'>
              Complete the{' '}
              <Link to='/workspace' className='text-primary underline'>
                workspace
              </Link>{' '}
              first.
            </CardContent>
          </Card>
        ) : gaps ? (
          <Card className='border-red-300 bg-red-50/60 dark:border-red-500/40 dark:bg-red-500/5'>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <AlertOctagon className='size-5 text-red-600' /> Insights need a
                complete calculation
              </CardTitle>
              <CardDescription>
                {gaps.length} input(s) are missing or waiting for a fallback
                decision. Resolve them on the Passport step.
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-2'>
              <ul className='list-inside list-disc text-sm'>
                {gaps.map((gap) => (
                  <li key={gap.input_key}>{gap.description}</li>
                ))}
              </ul>
              <Button asChild size='sm'>
                <Link to='/passport'>
                  Open passport <ArrowRight className='size-4' />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : !insights || !b ? (
          <Card>
            <CardContent className='flex items-center justify-center gap-3 py-12 text-sm text-muted-foreground'>
              <Loader2 className='size-5 animate-spin' /> Calculating insights…
            </CardContent>
          </Card>
        ) : (
          <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-3'>
              <Card>
                <CardHeader className='pb-2'>
                  <CardDescription>Current SEE</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className='text-3xl font-bold tabular-nums'>
                    {fmt(b.see_tco2_per_t, 4)}
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    tCO₂e/t · P5–P95 {fmt(b.band.p5, 3)}–{fmt(b.band.p95, 3)} ·
                    label {b.data_quality_label}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='pb-2'>
                  <CardDescription>Total embedded emissions</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className='text-3xl font-bold tabular-nums'>
                    {fmt(b.total_tco2, 1)}
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    tCO₂e for {fmt(insights.breakdown.target_production_t, 0)} t
                    of product
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className='pb-2'>
                  <CardDescription>Largest single lever</CardDescription>
                </CardHeader>
                <CardContent>
                  {insights.tips[0] ? (
                    <>
                      <p className='text-lg font-semibold'>
                        {insights.tips[0].title}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        −{fmt(insights.tips[0].tco2_saving, 1)} tCO₂ · SEE −
                        {fmt(insights.tips[0].see_saving, 4)}
                      </p>
                    </>
                  ) : (
                    <p className='text-sm text-muted-foreground'>
                      No levers apply.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* 1. Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className='flex items-center gap-2'>
                  <PieChart className='size-5' /> Emissions breakdown
                </CardTitle>
                <CardDescription>
                  Allocated tCO₂ by source and its share of the total. Hover a
                  bar for the per-tonne contribution.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BreakdownChart items={insights.breakdown.items} />
                <Table className='mt-2'>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead className='text-right'>tCO₂</TableHead>
                      <TableHead className='text-right'>Share</TableHead>
                      <TableHead className='text-right'>
                        tCO₂ per t product
                      </TableHead>
                      <TableHead>Basis</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {insights.breakdown.items.map((item) => (
                      <TableRow key={item.key}>
                        <TableCell>{item.label}</TableCell>
                        <TableCell className='text-right tabular-nums'>
                          {fmt(item.tco2, 2)}
                        </TableCell>
                        <TableCell className='text-right tabular-nums'>
                          {fmt(item.share * 100, 1)}%
                        </TableCell>
                        <TableCell className='text-right tabular-nums'>
                          {fmt(item.see_contribution, 4)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            label={
                              item.fallback_based
                                ? 'fallback-based'
                                : 'measured'
                            }
                            variant={item.fallback_based ? 'human' : 'primary'}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* 2. Tips */}
            <Card>
              <CardHeader>
                <CardTitle className='flex items-center gap-2'>
                  <Lightbulb className='size-5' /> Carbon reduction tips
                </CardTitle>
                <CardDescription>
                  Ranked by tonnes saved. Each saving is a full engine
                  recalculation of your passport with the stated assumption, not
                  an AI estimate.
                </CardDescription>
              </CardHeader>
              <CardContent className='space-y-3'>
                {insights.tips.map((tip) => (
                  <div
                    key={tip.id}
                    className='grid gap-3 rounded-lg border p-4 md:grid-cols-[2.5rem_1fr_auto]'
                  >
                    <span className='flex size-8 items-center justify-center rounded-full bg-muted text-sm font-bold'>
                      {tip.rank}
                    </span>
                    <div className='space-y-1'>
                      <p className='font-semibold'>{tip.title}</p>
                      <p className='text-sm text-muted-foreground'>
                        {tip.action}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        Assumption: {tip.assumption}
                      </p>
                      <div className='mt-2 h-1.5 w-full max-w-md rounded-full bg-muted'>
                        <div
                          className='h-1.5 rounded-full bg-primary'
                          style={{
                            width: `${Math.min(100, (tip.tco2_saving / insights.tips[0].tco2_saving) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className='flex flex-col items-end gap-1 text-right'>
                      <p className='text-lg font-bold tabular-nums'>
                        −{fmt(tip.tco2_saving, 1)} tCO₂
                      </p>
                      <p className='text-xs text-muted-foreground tabular-nums'>
                        SEE −{fmt(tip.see_saving, 4)} → {fmt(tip.see_after, 4)}{' '}
                        ({fmt(tip.saving_pct, 1)}%)
                      </p>
                      <Button
                        size='sm'
                        variant='outline'
                        onClick={() => tryTip(tip.scenario)}
                      >
                        Open in simulator
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* 3. Scenario simulator */}
            <Card id='simulator'>
              <CardHeader>
                <CardTitle className='flex items-center gap-2'>
                  <FlaskConical className='size-5' /> Scenario simulator
                </CardTitle>
                <CardDescription>
                  What if you switch supplier, buy a PPA or cut electricity? The
                  engine recalculates SEE and the uncertainty band. Your
                  passport is not changed.
                </CardDescription>
              </CardHeader>
              <CardContent className='space-y-5'>
                <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                  <Field id='sc-name' label='Scenario name'>
                    <Input
                      id='sc-name'
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field id='sc-elec' label='Cut electricity (%)'>
                    <Input
                      id='sc-elec'
                      type='number'
                      min={0}
                      max={100}
                      value={form.electricity_cut_pct}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          electricity_cut_pct: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field id='sc-ppa' label='PPA share of electricity (%)'>
                    <Input
                      id='sc-ppa'
                      type='number'
                      min={0}
                      max={100}
                      value={form.ppa_share_pct}
                      onChange={(e) =>
                        setForm({ ...form, ppa_share_pct: e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    id='sc-ppa-ef'
                    label='PPA factor (tCO₂/MWh)'
                    hint='0 for solar or wind'
                  >
                    <Input
                      id='sc-ppa-ef'
                      type='number'
                      min={0}
                      step='any'
                      value={form.ppa_ef}
                      onChange={(e) =>
                        setForm({ ...form, ppa_ef: e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    id='sc-see'
                    label='New supplier SEE (tCO₂/t)'
                    hint='Wire rod from another supplier'
                  >
                    <Input
                      id='sc-see'
                      type='number'
                      min={0}
                      step='any'
                      value={form.precursor_see}
                      onChange={(e) =>
                        setForm({ ...form, precursor_see: e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    id='sc-yield'
                    label='Less wire rod per t (%)'
                    hint='Yield improvement'
                  >
                    <Input
                      id='sc-yield'
                      type='number'
                      min={0}
                      max={100}
                      step='any'
                      value={form.precursor_cut_pct}
                      onChange={(e) =>
                        setForm({ ...form, precursor_cut_pct: e.target.value })
                      }
                    />
                  </Field>
                  <Field id='sc-fuel' label='Cut fuel (%)'>
                    <Input
                      id='sc-fuel'
                      type='number'
                      min={0}
                      max={100}
                      value={form.fuel_cut_pct}
                      onChange={(e) =>
                        setForm({ ...form, fuel_cut_pct: e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    id='sc-switch'
                    label='Switch fuel to'
                    hint='Same energy, register factors'
                  >
                    <Select
                      value={form.fuel_switch_to}
                      onValueChange={(v) =>
                        setForm({ ...form, fuel_switch_to: v })
                      }
                    >
                      <SelectTrigger id='sc-switch'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FUELS.map((f) => (
                          <SelectItem key={f.value} value={f.value}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className='flex gap-2'>
                  <Button onClick={() => void simulate()} disabled={running}>
                    {running && <Loader2 className='size-4 animate-spin' />}
                    Run scenario
                  </Button>
                  <Button
                    variant='outline'
                    onClick={() => {
                      setForm(EMPTY_FORM)
                      setScenario(null)
                    }}
                  >
                    Reset
                  </Button>
                </div>

                {scenario && (
                  <div className='space-y-4 rounded-lg border p-4'>
                    <div className='flex flex-wrap items-baseline justify-between gap-3'>
                      <p className='font-semibold'>{scenario.name}</p>
                      <p className='text-sm tabular-nums'>
                        <strong>
                          {scenario.tco2_saving >= 0 ? '−' : '+'}
                          {fmt(Math.abs(scenario.tco2_saving), 1)} tCO₂
                        </strong>{' '}
                        · SEE {fmt(scenario.baseline.see_tco2_per_t, 4)} →{' '}
                        {fmt(scenario.scenario.see_tco2_per_t, 4)} (
                        {scenario.see_change_pct > 0 ? '+' : ''}
                        {fmt(scenario.see_change_pct, 1)}%)
                      </p>
                    </div>
                    <BandComparison
                      baseline={scenario.baseline}
                      scenario={scenario.scenario}
                    />
                    <ul className='list-inside list-disc text-sm text-muted-foreground'>
                      {scenario.changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 4. Sensitivity */}
            <Card>
              <CardHeader>
                <CardTitle className='flex items-center gap-2'>
                  <Sigma className='size-5' /> Sensitivity analysis
                </CardTitle>
                <CardDescription>
                  Each input moved ±{insights.sensitivity.swing_pct}% on its
                  own; bars show the change in SEE from{' '}
                  {fmt(insights.sensitivity.base_see, 4)}. Top rows matter most:
                  check those inputs first.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TornadoChart
                  bars={insights.sensitivity.bars}
                  base={insights.sensitivity.base_see}
                  swingPct={insights.sensitivity.swing_pct}
                />
              </CardContent>
            </Card>

            {/* 5. Cost estimator */}
            <Card>
              <CardHeader>
                <CardTitle className='flex flex-wrap items-center gap-2'>
                  <Calculator className='size-5' /> CBAM cost estimator
                  <StatusBadge label='Estimate' variant='human' />
                </CardTitle>
                <CardDescription>
                  SEE converted to an estimated certificate cost per shipment.
                  Certificates per tonne = SEE − benchmark × CBAM factor; cost =
                  certificates × price − carbon price already paid.
                </CardDescription>
              </CardHeader>
              <CardContent className='space-y-5'>
                <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                  <Field id='c-t' label='Shipment size (t of fasteners)'>
                    <Input
                      id='c-t'
                      type='number'
                      min={0}
                      step='any'
                      value={cost.shipment_tonnes}
                      onChange={(e) =>
                        setCost({ ...cost, shipment_tonnes: e.target.value })
                      }
                    />
                  </Field>
                  <Field
                    id='c-price'
                    label='Certificate price (€/tCO₂)'
                    hint={
                      params
                        ? `Default: ${params.default_price.period} price €${params.default_price.eur_per_tco2} (EU Commission)`
                        : undefined
                    }
                  >
                    <Input
                      id='c-price'
                      type='number'
                      min={0}
                      step='any'
                      placeholder={
                        params ? String(params.default_price.eur_per_tco2) : ''
                      }
                      value={cost.certificate_price_eur}
                      onChange={(e) =>
                        setCost({
                          ...cost,
                          certificate_price_eur: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field
                    id='c-year'
                    label='Import year'
                    hint={
                      params
                        ? `CBAM factor ${params.cbam_factor[cost.year]} (free-allocation phase-out)`
                        : undefined
                    }
                  >
                    <Select
                      value={cost.year}
                      onValueChange={(v) => setCost({ ...cost, year: v })}
                    >
                      <SelectTrigger id='c-year'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 9 }, (_, i) =>
                          String(2026 + i)
                        ).map((y) => (
                          <SelectItem key={y} value={y}>
                            {y}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    id='c-bench'
                    label='CBAM benchmark (tCO₂/t)'
                    hint='From the EU benchmark table; 0 = gross (upper bound)'
                  >
                    <Input
                      id='c-bench'
                      type='number'
                      min={0}
                      step='any'
                      value={cost.benchmark_tco2_per_t}
                      onChange={(e) =>
                        setCost({
                          ...cost,
                          benchmark_tco2_per_t: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field
                    id='c-paid'
                    label='Carbon price paid in India (€/t product)'
                  >
                    <Input
                      id='c-paid'
                      type='number'
                      min={0}
                      step='any'
                      value={cost.carbon_price_paid_eur_per_t}
                      onChange={(e) =>
                        setCost({
                          ...cost,
                          carbon_price_paid_eur_per_t: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field id='c-inr' label='EUR → INR rate (optional)'>
                    <Input
                      id='c-inr'
                      type='number'
                      min={0}
                      step='any'
                      value={cost.eur_to_inr}
                      onChange={(e) =>
                        setCost({ ...cost, eur_to_inr: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <label className='flex items-center gap-2 text-sm'>
                  <Checkbox
                    checked={cost.use_scenario}
                    onCheckedChange={(v) =>
                      setCost({ ...cost, use_scenario: v === true })
                    }
                  />
                  Use the scenario from the simulator ({form.name})
                </label>
                <Button onClick={() => void runCost()} disabled={estimating}>
                  {estimating && <Loader2 className='size-4 animate-spin' />}
                  Estimate cost
                </Button>

                {estimate && (
                  <div className='space-y-3 rounded-lg border-2 border-dashed border-amber-400 p-4'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <StatusBadge
                        label='ESTIMATE – not a CBAM declaration'
                        variant='human'
                      />
                      {estimate.scenario && (
                        <StatusBadge
                          label={`Scenario: ${estimate.scenario}`}
                          variant='neutral'
                        />
                      )}
                    </div>
                    <div className='grid gap-4 sm:grid-cols-3'>
                      <div>
                        <p className='text-xs text-muted-foreground uppercase'>
                          Estimated cost per shipment
                        </p>
                        <p className='text-3xl font-bold tabular-nums'>
                          {eur(estimate.central.cost_eur)}
                        </p>
                        {estimate.central.cost_inr != null && (
                          <p className='text-sm text-muted-foreground tabular-nums'>
                            ≈ ₹{fmt(estimate.central.cost_inr, 0)}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className='text-xs text-muted-foreground uppercase'>
                          Range (SEE P5–P95)
                        </p>
                        <p className='text-xl font-semibold tabular-nums'>
                          {eur(estimate.low.cost_eur)} –{' '}
                          {eur(estimate.high.cost_eur)}
                        </p>
                      </div>
                      <div>
                        <p className='text-xs text-muted-foreground uppercase'>
                          Certificates
                        </p>
                        <p className='text-xl font-semibold tabular-nums'>
                          {fmt(estimate.central.certificates, 2)}
                        </p>
                        <p className='text-xs text-muted-foreground tabular-nums'>
                          {fmt(estimate.central.certificates_per_t, 4)}/t · €
                          {fmt(estimate.central.cost_per_t_eur, 2)}/t
                        </p>
                      </div>
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      SEE {fmt(estimate.central.see_tco2_per_t, 4)} · free
                      allocation {fmt(estimate.free_allocation_per_t, 4)} t/t
                      (benchmark × CBAM factor {estimate.cbam_factor} × CSCF) ·
                      price €{estimate.inputs.certificate_price_eur}
                    </p>
                    <p className='text-xs font-medium'>{estimate.disclaimer}</p>
                    <p className='text-xs text-muted-foreground'>
                      Sources:{' '}
                      {estimate.sources.map((s, i) => (
                        <span key={s.url}>
                          {i > 0 && ' · '}
                          <a
                            href={s.url}
                            target='_blank'
                            rel='noreferrer'
                            className='underline'
                          >
                            {s.title}
                          </a>
                        </span>
                      ))}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </Main>
    </>
  )
}
