import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AlertOctagon,
  ArrowRight,
  Circle,
  ClipboardList,
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Main } from '@/components/layout/main'
import {
  API_URL,
  ApiError,
  calculateWorkspace,
  downloadPassportCsv,
  downloadServerPassportPdf,
  getPassport,
  getPassportHistory,
  saveBlob,
  withdrawAssumption,
  type DeterministicCalculationResult,
  type HistoryRow,
  type PassportState,
  type Priority1Result,
} from '@/lib/cbam-api'
import { useCbamStore, type ReviewStatus } from '@/stores/cbam-store'
import { ActingAs } from '../components/acting-as'
import { CbamTopBar } from '../components/cbam-top-bar'
import { GapChecklist } from '../components/gap-checklist'
import { PageHeader } from '../components/page-header'
import { StatusBadge } from '../components/status-badge'
import { StatusWorkflow } from '../components/status-workflow'
import { StepIndicator } from '../components/step-indicator'
import { useServerWorkspace } from '../lib/use-server-workspace'
import { statusVariant, type MissingInput, type StepRoute } from '../lib/workspace-inputs'

const STEP_NAMES: Record<StepRoute, string> = {
  '/workspace': '1 · Workspace',
  '/upload': '2 · Upload',
  '/allocation': '4 · Allocation',
}

function MissingInputsCard({ items }: { items: MissingInput[] }) {
  const groups = (Object.keys(STEP_NAMES) as StepRoute[])
    .map((step) => ({ step, items: items.filter((item) => item.step === step) }))
    .filter((group) => group.items.length > 0)
  return (
    <Card className='border-amber-300/60 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <ClipboardList className='size-5 text-amber-600 dark:text-amber-400' />
          A few workspace details are still needed
        </CardTitle>
        <CardDescription>
          These identify the workspace on the server. Once they are saved, the server lists any missing
          calculation inputs.
        </CardDescription>
      </CardHeader>
      <CardContent className='grid gap-4 md:grid-cols-3'>
        {groups.map((group) => (
          <div key={group.step} className='rounded-lg border bg-card p-4'>
            <div className='mb-3 flex items-center justify-between gap-2'>
              <p className='text-sm font-semibold'>{STEP_NAMES[group.step]}</p>
              <Button asChild size='sm' variant='outline' className='h-7'>
                <Link to={group.step}>
                  Open <ArrowRight className='size-3.5' />
                </Link>
              </Button>
            </div>
            <ul className='space-y-1.5'>
              {group.items.map((item) => (
                <li key={item.label} className='flex items-start gap-2 text-sm text-muted-foreground'>
                  <Circle className='mt-1 size-2.5 shrink-0 text-amber-500' />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function fmt(value: number, digits = 2) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function UncertaintyBand({ p5, p50, p95, see }: { p5: number; p50: number; p95: number; see: number }) {
  const low = Math.min(p5, p50, p95, see)
  const high = Math.max(p5, p50, p95, see)
  const span = Math.max(high - low, Math.abs(high) * 0.04, 1e-6)
  const clamp = (n: number) => Math.max(0, Math.min(100, n))
  const pos = (v: number) => clamp(((v - low) / span) * 100)
  return (
    <div className='space-y-3'>
      <div className='relative h-3 rounded-full bg-muted'>
        <div
          className='absolute inset-y-0 rounded-full bg-emerald-500/70'
          style={{ left: `${pos(p5)}%`, width: `${pos(p95) - pos(p5)}%` }}
        />
        <div className='absolute -top-1 h-5 w-0.5 bg-slate-900 dark:bg-slate-100' style={{ left: `${pos(p50)}%` }} />
        <div
          className='absolute -top-1.5 size-3 rounded-full border-2 border-background bg-primary'
          style={{ left: `calc(${pos(see)}% - 6px)` }}
        />
      </div>
      <div className='grid grid-cols-3 gap-3 text-center'>
        {[
          ['P5 low', p5],
          ['P50 median', p50],
          ['P95 high', p95],
        ].map(([label, value]) => (
          <div key={label as string}>
            <p className='text-xs text-muted-foreground uppercase'>{label}</p>
            <p className='font-semibold tabular-nums'>{fmt(value as number, 4)}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

const DQ_TEXT = {
  A: 'All inputs measured or document-backed',
  B: 'Fallbacks under 20% of emissions',
  C: 'Fallbacks at 20% or more of emissions',
} as const

/** Shape expected by the existing CSV evidence-ledger export. */
function toLegacyCalculation(p1: Priority1Result): DeterministicCalculationResult {
  const r = p1.result
  return {
    specific_embedded_emissions_see: r.see_tco2_per_t,
    see_unit: 'tCO2/t',
    allocated_scope1_direct_tco2: r.scope1_allocated_tco2,
    allocated_scope2_indirect_tco2: r.scope2_counted_tco2,
    precursor_emissions_tco2: r.precursor_tco2,
    total_embedded_emissions_tco2: r.total_tco2,
    facility_gross_scope1_tco2: r.scope1_raw_tco2,
    facility_gross_scope2_tco2: r.scope2_raw_tco2,
    net_target_production_tonnes: r.target_production_t,
    allocation_factor_alpha: r.alpha,
    includes_indirect_delta_cn: true,
    data_quality_rating: `${r.data_quality_label} (${(r.fallback_share * 100).toFixed(1)}% fallback)`,
    uncertainty: p1.uncertainty,
    formula_latex: '',
  }
}

export function PassportPage() {
  const workspace = useCbamStore((state) => state.workspace)
  const documents = useCbamStore((state) => state.documents)
  const overrides = useCbamStore((state) => state.overrides)
  const setReviewStatus = useCbamStore((state) => state.setReviewStatus)
  const setCalculation = useCbamStore((state) => state.setCalculation)
  const actor = useCbamStore((state) => state.actingAs.name)
  const { workspaceId, state, sync, syncing, error, profileMissing } = useServerWorkspace()

  const [result, setResult] = useState<Priority1Result | null>(null)
  const [passport, setPassport] = useState<PassportState | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [calculating, setCalculating] = useState(false)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'pdf' | 'csv' | null>(null)

  const calcReady = state?.calc_status === 'Ready' && state.open_gaps === 0
  const incomplete = state?.calc_status === 'Incomplete'

  const refreshPassport = useCallback(async () => {
    if (!workspaceId) return
    try {
      const [p, h] = await Promise.all([getPassport(workspaceId), getPassportHistory(workspaceId)])
      setPassport(p)
      setHistory(h)
      setReviewStatus(p.status as ReviewStatus)
    } catch {
      /* backend error surfaced by the sync hook */
    }
  }, [workspaceId, setReviewStatus])

  const runCalculation = useCallback(async () => {
    if (!workspaceId) return
    setCalcError(null)
    setCalculating(true)
    try {
      const payload = await calculateWorkspace(workspaceId)
      setResult(payload)
      setCalculation(toLegacyCalculation(payload))
    } catch (cause) {
      setResult(null)
      setCalculation(null)
      if (!(cause instanceof ApiError && cause.status === 422)) {
        setCalcError(cause instanceof Error ? cause.message : 'Calculation failed.')
      }
    } finally {
      setCalculating(false)
      void refreshPassport()
    }
  }, [workspaceId, refreshPassport, setCalculation])

  useEffect(() => {
    if (!state) return
    const timer = setTimeout(() => {
      if (calcReady) void runCalculation()
      else {
        setResult(null)
        setCalculation(null)
        void refreshPassport()
      }
    }, 0)
    return () => clearTimeout(timer)
    // re-run whenever the server reports a new state (inputs, gaps or passport version changed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const exportPack = async (kind: 'pdf' | 'csv') => {
    setExporting(kind)
    const suffix = workspace.cn_code.replace(/ /g, '_')
    try {
      if (kind === 'pdf') {
        const blob = await downloadServerPassportPdf(workspaceId)
        saveBlob(blob, `CBAM_Emissions_Passport_${suffix}_v${passport?.version_number ?? 1}.pdf`)
      } else if (result) {
        const blob = await downloadPassportCsv({
          workspace: { ...workspace },
          calculation: toLegacyCalculation(result),
          uploaded_documents: documents,
          overrides,
          review_status: passport?.status,
        })
        saveBlob(blob, `CBAM_Audit_Evidence_Ledger_${suffix}.csv`)
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Export failed.')
    } finally {
      setExporting(null)
    }
  }

  const withdraw = async (id: number, key: string) => {
    if (!actor.trim()) return toast.error('Enter your name in "Acting as" first.')
    const reason = window.prompt(`Why withdraw the fallback for ${key}?`)
    if (!reason?.trim()) return
    try {
      await withdrawAssumption(workspaceId, id, reason.trim(), actor.trim())
      toast.success('Assumption withdrawn; the gap is open again.')
      void sync()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not withdraw.')
    }
  }

  const r = result?.result

  return (
    <>
      <CbamTopBar />
      <Main>
        <StepIndicator current={5} />
        <PageHeader
          title='Emissions Passport'
          description={
            workspace.company_name.trim()
              ? [workspace.company_name, workspace.installation_name, workspace.cn_code && `CN ${workspace.cn_code}`]
                  .filter(Boolean)
                  .join(' · ')
              : 'Embedded-emissions summary with traceable inputs, deterministic calculations, and uncertainty ranges.'
          }
        >
          <Button
            variant='outline'
            onClick={() => void sync()}
            disabled={syncing || calculating || profileMissing.length > 0}
          >
            {syncing || calculating ? <Loader2 className='size-4 animate-spin' /> : <RefreshCw className='size-4' />}
            Recalculate
          </Button>
        </PageHeader>

        <Card className='mb-4'>
          <CardContent className='flex flex-wrap items-end justify-between gap-4 py-4'>
            <ActingAs compact />
            <p className='max-w-md text-xs text-muted-foreground'>
              Prototype role selector with a typed name. Every fallback, waiver and status change is logged under this
              name. Real authentication is future work.
            </p>
          </CardContent>
        </Card>

        {(error || calcError) && (
          <Alert variant='destructive' className='mb-4'>
            <AlertTitle>Calculation unavailable</AlertTitle>
            <AlertDescription>
              {error || calcError}
              {error && (
                <span className='mt-1 block text-xs'>
                  Check that the backend is running (<code>uvicorn app.main:app --port 8000</code>) and reachable at{' '}
                  {API_URL}.
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}

        {profileMissing.length > 0 ? (
          <MissingInputsCard items={profileMissing} />
        ) : !state ? (
          <Card>
            <CardContent className='flex items-center justify-center gap-3 py-12 text-sm text-muted-foreground'>
              <Loader2 className='size-5 animate-spin' /> Syncing the workspace with the backend…
            </CardContent>
          </Card>
        ) : (
          <>
            {incomplete && (
              <div className='mb-4 flex items-start gap-3 rounded-lg border-2 border-red-500 bg-red-50 p-4 text-red-900 dark:bg-red-950 dark:text-red-100'>
                <AlertOctagon className='mt-0.5 size-6 shrink-0' />
                <div>
                  <p className='text-lg font-bold tracking-wide'>INCOMPLETE – NOT FOR SUBMISSION</p>
                  <p className='text-sm'>
                    Required inputs are missing and have no approved fallback. The engine refuses to run, so no SEE
                    value is shown. Complete the checklist below; the status updates as you go.
                  </p>
                </div>
              </div>
            )}

            {state.open_gaps > 0 && (
              <div className='mb-4'>
                <GapChecklist
                  workspaceId={workspaceId}
                  gaps={state.gaps}
                  incomplete={incomplete}
                  factorSetVersion={state.factor_set_version}
                  onChanged={() => void sync()}
                />
              </div>
            )}

            {calcReady && !r && (
              <Card>
                <CardContent className='flex items-center justify-center gap-3 py-12 text-sm text-muted-foreground'>
                  <Loader2 className='size-5 animate-spin' /> Calculating emissions and uncertainty interval…
                </CardContent>
              </Card>
            )}

            {r && result && (
              <>
                <div className='mb-4 flex flex-wrap items-center gap-2'>
                  <StatusBadge
                    label={`Data quality ${r.data_quality_label}`}
                    variant={r.data_quality_label === 'A' ? 'primary' : r.data_quality_label === 'B' ? 'human' : 'fallback'}
                  />
                  <span className='text-xs text-muted-foreground'>
                    {DQ_TEXT[r.data_quality_label]} · fallback share {(r.fallback_share * 100).toFixed(1)}%
                  </span>
                  {passport && (
                    <StatusBadge
                      label={`${passport.status} · v${passport.version_number}`}
                      variant={statusVariant(passport.status)}
                    />
                  )}
                  <StatusBadge label={`Factor set ${result.factor_set_version}`} variant='neutral' />
                </div>

                <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                  <Card>
                    <CardHeader className='pb-2'>
                      <CardDescription>Specific embedded emissions</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className='text-2xl font-bold tabular-nums'>{fmt(r.see_tco2_per_t, 4)}</p>
                      <p className='text-xs text-muted-foreground'>tCO₂e / tonne · label {r.data_quality_label}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className='pb-2'>
                      <CardDescription>Direct (fuel + process) · allocated</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className='text-2xl font-bold tabular-nums'>{fmt(r.scope1_allocated_tco2, 4)}</p>
                      <p className='text-xs text-muted-foreground'>raw {fmt(r.scope1_raw_tco2, 4)} tCO₂</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className='pb-2'>
                      <CardDescription>Indirect · allocated</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className='text-2xl font-bold tabular-nums'>{fmt(r.scope2_counted_tco2)}</p>
                      <p className='text-xs text-muted-foreground'>raw {fmt(r.scope2_raw_tco2)} tCO₂</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className='pb-2'>
                      <CardDescription>Precursor emissions</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className='text-2xl font-bold tabular-nums'>{fmt(r.precursor_tco2)}</p>
                      <p className='text-xs text-muted-foreground'>not allocated (directly attributable)</p>
                    </CardContent>
                  </Card>
                </div>

                <div className='mt-4 grid gap-4 lg:grid-cols-3'>
                  <Card className='lg:col-span-2'>
                    <CardHeader>
                      <CardTitle>Statistical uncertainty</CardTitle>
                      <CardDescription>
                        Seeded Monte Carlo ({result.uncertainty.iterations.toLocaleString()} draws, seed{' '}
                        {result.mc_seed}). Fallback inputs use the register&apos;s wider distribution.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <UncertaintyBand
                        p5={result.uncertainty.p5}
                        p50={result.uncertainty.p50}
                        p95={result.uncertainty.p95}
                        see={r.see_tco2_per_t}
                      />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Allocation</CardTitle>
                    </CardHeader>
                    <CardContent className='space-y-3 text-sm'>
                      <div className='flex justify-between'>
                        <span className='text-muted-foreground'>αₚ</span>
                        <span className='font-semibold tabular-nums'>{fmt(r.alpha, 4)}</span>
                      </div>
                      <div className='flex justify-between'>
                        <span className='text-muted-foreground'>Net target production</span>
                        <span className='font-semibold tabular-nums'>{fmt(r.target_production_t)} t</span>
                      </div>
                      <div className='flex justify-between'>
                        <span className='text-muted-foreground'>Total embedded</span>
                        <span className='font-semibold tabular-nums'>{fmt(r.total_tco2, 4)} tCO₂</span>
                      </div>
                      <Separator />
                      <Link to='/allocation' className='text-sm text-primary underline'>
                        Adjust allocation or process emissions
                      </Link>
                    </CardContent>
                  </Card>
                </div>

                <Card className='mt-4'>
                  <CardHeader>
                    <CardTitle>Breakdown</CardTitle>
                    <CardDescription>Direct = Σ (Q × NCV × EF × OF) + Process. Rounded for display only.</CardDescription>
                  </CardHeader>
                  <CardContent className='overflow-x-auto'>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Term</TableHead>
                          <TableHead className='text-right'>Raw tCO₂</TableHead>
                          <TableHead className='text-right'>Allocated tCO₂</TableHead>
                          <TableHead>Basis</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...r.fuels.map((t) => ['Fuel', t] as const), ...r.process.map((t) => ['Process', t] as const),
                          ...r.precursors.map((t) => ['Precursor', t] as const)].map(([kind, t]) => (
                          <TableRow key={`${kind}-${t.key}`}>
                            <TableCell>
                              {kind}: {t.name}
                            </TableCell>
                            <TableCell className='text-right tabular-nums'>{fmt(t.raw_tco2, 4)}</TableCell>
                            <TableCell className='text-right tabular-nums'>{fmt(t.allocated_tco2, 4)}</TableCell>
                            <TableCell>
                              <StatusBadge
                                label={t.fallback_based ? 'fallback-based' : 'measured'}
                                variant={t.fallback_based ? 'human' : 'primary'}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                        {r.process.length === 0 && (
                          <TableRow>
                            <TableCell>Process emissions</TableCell>
                            <TableCell className='text-right'>0.0000</TableCell>
                            <TableCell className='text-right'>0.0000</TableCell>
                            <TableCell className='text-xs text-muted-foreground'>Declared: none</TableCell>
                          </TableRow>
                        )}
                        <TableRow>
                          <TableCell>Indirect electricity</TableCell>
                          <TableCell className='text-right tabular-nums'>{fmt(r.scope2_raw_tco2, 4)}</TableCell>
                          <TableCell className='text-right tabular-nums'>{fmt(r.scope2_counted_tco2, 4)}</TableCell>
                          <TableCell />
                        </TableRow>
                      </TableBody>
                    </Table>
                    {r.notes.map((note) => (
                      <p key={note} className='mt-2 text-xs text-muted-foreground'>
                        {note}
                      </p>
                    ))}
                  </CardContent>
                </Card>

                <Card className='mt-4'>
                  <CardHeader>
                    <CardTitle>Assumptions</CardTitle>
                    <CardDescription>Every fallback applied by a user, with its source and factor-set version.</CardDescription>
                  </CardHeader>
                  <CardContent className='overflow-x-auto'>
                    {result.assumptions.length === 0 ? (
                      <p className='text-sm text-muted-foreground'>None. All inputs are measured or document-backed.</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Input</TableHead>
                            <TableHead>Value used</TableHead>
                            <TableHead>Source</TableHead>
                            <TableHead>Reason</TableHead>
                            <TableHead>Applied by</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.assumptions.map((a) => (
                            <TableRow key={a.id}>
                              <TableCell className='font-mono text-xs'>{a.input_key}</TableCell>
                              <TableCell className='tabular-nums'>
                                {a.value_used} {a.unit}
                              </TableCell>
                              <TableCell className='max-w-xs text-xs whitespace-normal'>
                                {a.publisher} ({a.year}) · set {a.factor_set_version}
                              </TableCell>
                              <TableCell className='max-w-xs text-xs whitespace-normal'>{a.reason}</TableCell>
                              <TableCell className='text-xs'>{a.applied_by}</TableCell>
                              <TableCell>
                                <Button size='sm' variant='ghost' onClick={() => void withdraw(a.id, a.input_key)}>
                                  Withdraw
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>

                <Card className='mt-4'>
                  <CardHeader>
                    <CardTitle>Emission factors used</CardTitle>
                    <CardDescription>
                      From the versioned register (factor set {result.factor_set_version}). Re-running this passport
                      uses the same version.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className='overflow-x-auto'>
                    {result.factors_used.length === 0 ? (
                      <p className='text-sm text-muted-foreground'>
                        No register factors used; every factor is a document-backed input.
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Key</TableHead>
                            <TableHead>Value</TableHead>
                            <TableHead>Source</TableHead>
                            <TableHead>Year</TableHead>
                            <TableHead>Set</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.factors_used.map((f) => (
                            <TableRow key={f.id}>
                              <TableCell className='font-mono text-xs'>{f.key}</TableCell>
                              <TableCell className='tabular-nums'>
                                {f.value} {f.unit}
                              </TableCell>
                              <TableCell className='max-w-md text-xs whitespace-normal'>
                                <a href={f.source_url} target='_blank' rel='noreferrer' className='underline'>
                                  {f.source_title}
                                </a>
                                <span className='block text-muted-foreground'>{f.publisher}</span>
                              </TableCell>
                              <TableCell>{f.year}</TableCell>
                              <TableCell>{f.factor_set_version}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </>
            )}

            {passport && (
              <StatusWorkflow
                workspaceId={workspaceId}
                passport={passport}
                history={history}
                onChanged={() => void refreshPassport()}
              />
            )}

            <Alert className='mt-4 border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100'>
              <AlertTitle>Decision-support prototype</AlertTitle>
              <AlertDescription>
                This passport does not certify emissions or replace an accredited independent verifier under EU CBAM
                rules.
              </AlertDescription>
            </Alert>

            <div className='mt-4 flex flex-wrap gap-2'>
              <Button onClick={() => void exportPack('pdf')} disabled={exporting !== null}>
                <Download className='size-4' />
                {exporting === 'pdf'
                  ? 'Generating…'
                  : incomplete
                    ? 'Download INCOMPLETE PDF'
                    : 'Download passport PDF'}
              </Button>
              {result && (
                <Button asChild variant='secondary'>
                  <Link to='/insights'>
                    Carbon insights <ArrowRight className='size-4' />
                  </Link>
                </Button>
              )}
              <Button variant='outline' onClick={() => void exportPack('csv')} disabled={exporting !== null || !result}>
                <Download className='size-4' />
                {exporting === 'csv' ? 'Generating…' : 'Download evidence CSV'}
              </Button>
            </div>
          </>
        )}
      </Main>
    </>
  )
}
