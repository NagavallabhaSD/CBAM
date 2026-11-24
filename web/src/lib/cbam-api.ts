/**
 * Typed client for the CBAM-Ready Emissions Passport FastAPI backend.
 *
 * Configure the backend origin in .env (Vite):
 *   VITE_API_URL=http://localhost:8000
 */

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";
const V1 = `${API_URL}/api/v1`;

export type FieldCategory =
  | "scope1_fuel"
  | "scope2_electricity"
  | "precursor"
  | "production";

export interface ExtractedFieldCandidate {
  field_name: string;
  extracted_value: number;
  unit: string;
  confidence_score: number;
  evidence_page: number;
  evidence_snippet: string;
  bounding_box: string | null;
  field_category: FieldCategory | string | null;
}

export interface DocumentExtractionResult {
  document_hash: string;
  filename: string;
  page_count: number;
  extracted_fields: ExtractedFieldCandidate[];
  file_size_bytes?: number;
}

export interface ExtractedFieldAuditRead {
  id: number;
  document_hash: string;
  field_name: string;
  raw_extracted_value: string | null;
  raw_unit: string | null;
  confidence_score: number;
  evidence_page: number | null;
  evidence_snippet: string | null;
  effective_value: string | null;
  effective_unit: string | null;
  was_overridden: boolean;
  user_override_value: string | null;
  user_override_unit: string | null;
  modified_by_user_id: string | null;
  override_reason: string | null;
  created_at: string;
}

export interface DocumentRecordRead {
  id: number;
  document_hash: string;
  filename: string;
  workspace_id: string;
  page_count: number;
  file_size_bytes: number;
  created_at: string;
}

export interface HumanOverrideRequest {
  document_hash: string;
  field_name: string;
  override_value: number;
  override_unit?: string | null;
  override_reason: string;
  user_id: string;
}

export interface HumanOverrideResponse {
  status: string;
  message: string;
  field_name: string;
  raw_value: string;
  effective_value: string;
  effective_unit: string;
  was_overridden: boolean;
  modified_by: string;
  override_reason: string;
}

export interface FuelCombustionItem {
  fuel_name: string;
  quantity: number;
  unit: string;
  ncv?: number | null;
  ef?: number | null;
  oxidation_factor?: number; // backend default 1.0
  confidence_score?: number;
  is_shared_utility?: boolean;
}

export interface ElectricityConsumptionItem {
  source_name: string;
  consumed_quantity: number;
  unit: string;
  grid_ef_tco2_per_mwh?: number | null;
  confidence_score?: number;
  is_shared_utility?: boolean;
}

export interface PrecursorMaterialItem {
  material_name: string;
  consumed_quantity: number;
  unit: string;
  embedded_see_tco2_per_tonne?: number | null;
  source_type?: string;
  cn_code?: string;
  country_of_origin?: string;
  confidence_score?: number;
  is_fallback?: boolean;
  fallback_markup_pct?: number;
}

export interface ProductionAllocationInput {
  target_product_family: string;
  target_production_quantity: number;
  target_production_unit: string;
  total_facility_production_quantity: number;
  total_facility_production_unit: string;
}

export interface DeterministicCalculationRequest {
  reporting_period_id: number;
  cn_code: string;
  production: ProductionAllocationInput;
  fuels: FuelCombustionItem[];
  electricity: ElectricityConsumptionItem;
  precursors: PrecursorMaterialItem[];
  apply_allocation_to_shared_energy?: boolean;
  run_monte_carlo?: boolean;
  monte_carlo_iterations?: number;
}

export interface UncertaintyBand {
  p5: number;
  p50: number;
  p95: number;
  iterations?: number;
  confidence_interval_pct?: number;
}

export interface DeterministicCalculationResult {
  specific_embedded_emissions_see: number;
  see_unit: string;
  allocated_scope1_direct_tco2: number;
  allocated_scope2_indirect_tco2: number;
  precursor_emissions_tco2: number;
  total_embedded_emissions_tco2: number;
  facility_gross_scope1_tco2: number;
  facility_gross_scope2_tco2: number;
  net_target_production_tonnes: number;
  allocation_factor_alpha: number;
  includes_indirect_delta_cn: boolean;
  data_quality_rating: "ACTUAL_PRIMARY" | "HYBRID_ESTIMATED" | "FALLBACK_DEFAULT" | string;
  uncertainty: UncertaintyBand | null;
  formula_latex: string;
  fallback_notes?: string[];
  input_snapshot?: Record<string, unknown>;
}

export interface RAGCitation {
  document_title: string;
  section_reference: string;
  publication_year: number | null;
  source_url: string | null;
  excerpt: string;
  score: number;
}

export interface RAGQueryResponse {
  query: string;
  answer: string;
  citations: RAGCitation[];
}

export interface PassportExportPayload {
  workspace: Record<string, unknown>;
  calculation: DeterministicCalculationResult;
  uploaded_documents: Record<string, DocumentExtractionResult>;
  overrides?: Record<string, Record<string, unknown>>;
  review_status?: string;
}

/** Error carrying the HTTP status and the parsed JSON body (409 / 422 bodies hold details). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get problems(): string[] {
    const detail = (this.body as { detail?: { problems?: string[] } } | null)?.detail;
    return detail && typeof detail === "object" && Array.isArray(detail.problems) ? detail.problems : [];
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${V1}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let body: unknown = null;
    try {
      body = await response.json();
      const raw = (body as { detail?: unknown })?.detail;
      if (typeof raw === "string") detail = raw;
      else if (raw && typeof raw === "object" && "message" in raw) detail = String((raw as { message: string }).message);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, response.status, body);
  }
  return (await response.json()) as T;
}

function json(method: string, payload: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export async function checkHealth(): Promise<{ status: string; version: string }> {
  const response = await fetch(`${API_URL}/health`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as { status: string; version: string };
}

export function uploadDocument(
  file: File,
  workspaceId: string,
): Promise<DocumentExtractionResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("workspace_id", workspaceId);
  return request<DocumentExtractionResult>(
    "/documents/upload",
    { method: "POST", body: form },
  );
}

export function overrideField(payload: HumanOverrideRequest): Promise<HumanOverrideResponse> {
  return request<HumanOverrideResponse>("/documents/override", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function getDocumentFields(documentHash: string): Promise<ExtractedFieldAuditRead[]> {
  return request<ExtractedFieldAuditRead[]>(`/documents/${documentHash}/fields`);
}

export function listWorkspaceDocuments(workspaceId: string): Promise<DocumentRecordRead[]> {
  return request<DocumentRecordRead[]>(`/documents/workspace/${workspaceId}`);
}

export function calculate(
  payload: DeterministicCalculationRequest,
  saveToDb = true,
): Promise<DeterministicCalculationResult> {
  return request<DeterministicCalculationResult>(
    `/calculations/calculate?save_to_db=${saveToDb}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export function getLatestCalculation(reportingPeriodId: number): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/calculations/period/${reportingPeriodId}/latest`);
}

export function queryRegulatory(
  query: string,
  topK = 3,
  cnCodeFilter?: string,
): Promise<RAGQueryResponse> {
  return request<RAGQueryResponse>("/rag/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK, cn_code_filter: cnCodeFilter ?? null }),
  });
}

async function download(path: string, payload: PassportExportPayload): Promise<Blob> {
  const response = await fetch(`${V1}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Export failed: HTTP ${response.status}`);
  return response.blob();
}

export function downloadPassportPdf(payload: PassportExportPayload): Promise<Blob> {
  return download("/passport/download-pdf", payload);
}

export function downloadPassportCsv(payload: PassportExportPayload): Promise<Blob> {
  return download("/passport/download-csv", payload);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}


// =====================================================================
// Priority 1: workspaces, validation findings, data gaps, fallbacks,
// review status workflow and the emission-factor register.
// =====================================================================

export interface SourcedValue {
  value: number | null;
  unit?: string | null;
  evidence_ref?: string | null;
  rel_uncertainty?: number | null;
}

export interface ProcessSource {
  name: string;
  method: "activity" | "direct";
  activity_quantity?: number | null;
  activity_unit?: string | null;
  factor_key?: string | null;
  direct_tco2?: number | null;
  evidence_ref?: string | null;
  is_shared?: boolean;
}

export interface ProcessDeclaration {
  mode: "none" | "sources" | null;
  reason?: string | null;
  sources: ProcessSource[];
}

export interface WorkspaceInputs {
  cn_code: string | null;
  includes_indirect: boolean;
  production: {
    product_family: string | null;
    target: SourcedValue;
    total_installation: SourcedValue;
    utility_coverage: "shared" | "dedicated";
  };
  uses_fuel: boolean;
  fuels: {
    fuel_key: string;
    name: string;
    quantity: SourcedValue;
    ncv: SourcedValue;
    ef: SourcedValue;
    oxidation_factor: SourcedValue;
    is_shared: boolean;
  }[];
  electricity: { consumed: SourcedValue; grid_ef: SourcedValue; is_shared: boolean };
  precursors: {
    key: string;
    name: string;
    cn_code: string | null;
    country_of_origin: string | null;
    quantity: SourcedValue;
    supplier_see: SourcedValue;
    directly_attributable: boolean;
  }[];
  process: ProcessDeclaration;
}

export interface Gap {
  id: number;
  input_key: string;
  description: string;
  fallback_available: boolean;
  fallback_allowed_flag: boolean | null;
  status: "open" | "filled_by_user" | "fallback_applied" | "waived";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface GapSummary {
  workspace_id: string;
  calc_status: "Incomplete" | "Ready";
  factor_set_version: string | null;
  gaps: Gap[];
  open_gaps: number;
  pending_fallbacks: number;
}

export interface WorkspaceState extends GapSummary {
  company_name: string | null;
  installation_name: string | null;
  cn_code: string | null;
  reporting_start: string | null;
  reporting_end: string | null;
  open_errors: number;
  open_warnings: number;
  passport: { version_number: number; status: string; input_hash: string; has_result: boolean } | null;
}

export interface Finding {
  id: number;
  rule_id: "V1_UNIT" | "V2_OVERLAP" | "V3_DUPLICATE";
  severity: "error" | "warning";
  document_id: number | null;
  field_id: number | null;
  related_document_id: number | null;
  message: string;
  suggested_fix: string | null;
  status: "open" | "resolved" | "waived";
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface FactorRead {
  id: number;
  factor_set_version: string;
  key: string;
  value: number;
  unit: string;
  source_title: string;
  publisher: string;
  source_url: string;
  year: number;
  is_fallback: boolean;
  allowed: boolean;
  uncertainty_type: string | null;
  uncertainty_rel: number | null;
  uncertainty_low: number | null;
  uncertainty_high: number | null;
  notes: string | null;
  status: string;
}

export interface AssumptionRow {
  id: number;
  input_key: string;
  value_used: number;
  unit: string;
  factor_id: number;
  factor_set_version: string;
  reason: string;
  applied_by: string;
  applied_at: string;
  source_title?: string;
  publisher?: string;
  source_url?: string;
  year?: number;
}

export interface TermBreakdown {
  key: string;
  name: string;
  raw_tco2: number;
  allocated_tco2: number;
  fallback_based: boolean;
}

export interface Priority1Result {
  version_number: number;
  factor_set_version: string | null;
  mc_seed: number;
  result: {
    alpha: number;
    fuels: TermBreakdown[];
    process: TermBreakdown[];
    precursors: TermBreakdown[];
    scope1_fuel_raw_tco2: number;
    process_raw_tco2: number;
    scope1_raw_tco2: number;
    scope1_allocated_tco2: number;
    scope2_raw_tco2: number;
    scope2_allocated_tco2: number;
    scope2_counted_tco2: number;
    precursor_tco2: number;
    total_tco2: number;
    target_production_t: number;
    see_tco2_per_t: number;
    fallback_tco2: number;
    fallback_share: number;
    data_quality_label: "A" | "B" | "C";
    factor_ids_used: number[];
    notes: string[];
  };
  uncertainty: { p5: number; p50: number; p95: number; mean: number; std_dev: number; iterations: number };
  factors_used: FactorRead[];
  assumptions: AssumptionRow[];
}

export type ReviewStatusName = "Draft" | "User-Confirmed" | "Expert-Reviewed" | "Externally Verified";
export type ActorRole = "exporter" | "reviewer" | "verifier";

export interface PassportState {
  version_number: number;
  status: ReviewStatusName;
  status_wording: string | null;
  input_hash: string;
  factor_set_version: string | null;
  mc_seed: number | null;
  has_result: boolean;
  verifier_details: Record<string, string> | null;
  allowed_next: ReviewStatusName[];
  required_role: Partial<Record<ReviewStatusName, ActorRole>>;
  result: Priority1Result | null;
}

export interface HistoryRow {
  id: number;
  version_number: number;
  from: string | null;
  to: string;
  actor: string;
  role: string;
  note: string | null;
  extra: Record<string, unknown> | null;
  timestamp: string;
}

export interface DocumentMetadata {
  supplier?: string | null;
  account_number?: string | null;
  utility_type?: string | null;
  bill_number?: string | null;
  bill_date?: string | null;
  period_start?: string | null;
  period_end?: string | null;
}

export type DocumentRecordWithMeta = DocumentRecordRead & DocumentMetadata & { is_excluded: boolean };

export interface FieldAuditWithReview extends ExtractedFieldAuditRead {
  field_type: string | null;
  canonical_value: number | null;
  canonical_unit: string | null;
  reviewed: boolean;
  reviewed_by: string | null;
}

export interface DuplicateDocumentBody {
  detail: string;
  existing_document: { id: number; document_hash: string; filename: string; workspace_id: string; url: string };
}

const enc = encodeURIComponent;

export function upsertWorkspace(
  workspaceId: string,
  profile: {
    company_name?: string;
    installation_name?: string;
    cn_code?: string;
    reporting_start?: string | null;
    reporting_end?: string | null;
    inputs?: WorkspaceInputs;
    actor?: string;
  },
): Promise<WorkspaceState> {
  return request<WorkspaceState>(`/workspaces/${enc(workspaceId)}`, json("PUT", profile));
}

export function getWorkspaceState(workspaceId: string): Promise<WorkspaceState> {
  return request<WorkspaceState>(`/workspaces/${enc(workspaceId)}`);
}

export function validateWorkspace(workspaceId: string, actor = "system"): Promise<Finding[]> {
  return request<Finding[]>(`/workspaces/${enc(workspaceId)}/validate?actor=${enc(actor)}`, { method: "POST" });
}

export function waiveFinding(findingId: number, reason: string, actor: string): Promise<Finding> {
  return request<Finding>(`/findings/${findingId}/waive`, json("POST", { reason, actor }));
}

export function resolveFinding(
  findingId: number,
  action: "resolve" | "keep_this" | "keep_other" | "distinct",
  actor: string,
  note: string,
): Promise<Finding> {
  return request<Finding>(`/findings/${findingId}/resolve`, json("POST", { action, actor, note }));
}

export function getGaps(workspaceId: string): Promise<GapSummary> {
  return request<GapSummary>(`/workspaces/${enc(workspaceId)}/gaps`);
}

export function applyFallback(workspaceId: string, inputKey: string, reason: string, actor: string): Promise<GapSummary> {
  return request<GapSummary>(
    `/workspaces/${enc(workspaceId)}/gaps/${enc(inputKey)}/apply-fallback`,
    json("POST", { reason, actor }),
  );
}

export function withdrawAssumption(workspaceId: string, assumptionId: number, reason: string, actor: string) {
  return request<GapSummary>(
    `/workspaces/${enc(workspaceId)}/assumptions/${assumptionId}/withdraw`,
    json("POST", { reason, actor }),
  );
}

export function calculateWorkspace(workspaceId: string, seed?: number): Promise<Priority1Result> {
  return request<Priority1Result>(`/workspaces/${enc(workspaceId)}/calculate`, json("POST", { seed }));
}

export function getPassport(workspaceId: string): Promise<PassportState> {
  return request<PassportState>(`/passports/${enc(workspaceId)}`);
}

export function transitionPassport(
  workspaceId: string,
  body: { to: ReviewStatusName; note: string; actor: string; role: ActorRole; extra_fields: Record<string, unknown> },
) {
  return request<PassportState & { history: HistoryRow[] }>(`/passports/${enc(workspaceId)}/transition`, json("POST", body));
}

export function getPassportHistory(workspaceId: string): Promise<HistoryRow[]> {
  return request<HistoryRow[]>(`/passports/${enc(workspaceId)}/history`);
}

export async function downloadServerPassportPdf(workspaceId: string): Promise<Blob> {
  const response = await fetch(`${V1}/passports/${enc(workspaceId)}/pdf`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Export failed: HTTP ${response.status}`);
  return response.blob();
}

export function getRegisterFactors(version?: string): Promise<FactorRead[]> {
  return request<FactorRead[]>(`/registry/factors${version ? `?version=${enc(version)}` : ""}`);
}

export function getDocument(documentHash: string): Promise<DocumentExtractionResult> {
  return request<DocumentExtractionResult>(`/documents/${documentHash}`);
}

export function getWorkspaceDocuments(workspaceId: string): Promise<DocumentRecordWithMeta[]> {
  return request<DocumentRecordWithMeta[]>(`/documents/workspace/${enc(workspaceId)}`);
}

export function getFieldsWithReview(documentHash: string): Promise<FieldAuditWithReview[]> {
  return request<FieldAuditWithReview[]>(`/documents/${documentHash}/fields`);
}

export function updateDocumentMetadata(
  documentHash: string,
  metadata: DocumentMetadata & { actor: string; reason?: string },
): Promise<DocumentRecordWithMeta> {
  return request<DocumentRecordWithMeta>(`/documents/${documentHash}/metadata`, json("PATCH", metadata));
}

export function excludeDocument(documentHash: string, actor: string, reason: string) {
  return request<DocumentRecordWithMeta>(`/documents/${documentHash}/exclude`, json("POST", { actor, reason }));
}

export function approveField(fieldId: number, actor: string): Promise<FieldAuditWithReview> {
  return request<FieldAuditWithReview>(`/documents/fields/${fieldId}/approve`, json("POST", { actor }));
}

// =====================================================================
// Priority 2: carbon insights. Every number is calculated by the engine.
// =====================================================================

export interface Band {
  p5: number
  p50: number
  p95: number
}

export interface Snapshot {
  see_tco2_per_t: number
  total_tco2: number
  band: Band
  data_quality_label: string
}

export interface BreakdownItem {
  key: string
  label: string
  category: 'fuel' | 'process' | 'electricity' | 'precursor'
  tco2: number
  share: number
  see_contribution: number
  fallback_based: boolean
}

export interface Breakdown {
  total_tco2: number
  see_tco2_per_t: number
  target_production_t: number
  items: BreakdownItem[]
}

export interface ScenarioSpec {
  name?: string
  electricity_cut_pct?: number
  ppa_share_pct?: number
  ppa_ef?: number
  fuel_cut_pct?: number
  fuel_switch_to?: string | null
  precursor_see?: number | null
  precursor_cut_pct?: number
}

export interface Tip {
  id: string
  rank: number
  title: string
  action: string
  assumption: string
  tco2_saving: number
  see_saving: number
  see_after: number
  saving_pct: number
  scenario: ScenarioSpec
}

export interface SensitivityBar {
  key: string
  label: string
  base_value: number
  unit: string
  see_low: number
  see_high: number
  swing: number
  note: string | null
}

export interface Insights {
  factor_set_version: string
  baseline: Snapshot & { mc_seed: number }
  breakdown: Breakdown
  tips: Tip[]
  sensitivity: { swing_pct: number; base_see: number; bars: SensitivityBar[] }
}

export interface ScenarioResult {
  name: string
  changes: string[]
  baseline: Snapshot
  scenario: Snapshot
  tco2_saving: number
  see_saving: number
  see_change_pct: number
  breakdown: Breakdown
}

export interface CostInputs {
  shipment_tonnes: number
  certificate_price_eur?: number
  year?: number
  benchmark_tco2_per_t?: number
  cscf?: number
  carbon_price_paid_eur_per_t?: number
  eur_to_inr?: number | null
  scenario?: ScenarioSpec | null
}

export interface CostLine {
  see_tco2_per_t: number
  certificates_per_t: number
  certificates: number
  cost_per_t_eur: number
  cost_eur: number
  cost_inr: number | null
}

export interface CostEstimate {
  label: 'ESTIMATE'
  inputs: CostInputs
  cbam_factor: number
  free_allocation_per_t: number
  central: CostLine
  low: CostLine
  high: CostLine
  formula: string
  disclaimer: string
  sources: { title: string; url: string }[]
  scenario: string | null
}

export interface CostParameters {
  cbam_factor: Record<string, number>
  certificate_prices: { period: string; eur_per_tco2: number; published: string }[]
  default_price: { period: string; eur_per_tco2: number; published: string }
  sources: { title: string; url: string }[]
  disclaimer: string
}

export function getInsights(workspaceId: string): Promise<Insights> {
  return request<Insights>(`/workspaces/${enc(workspaceId)}/insights`)
}

export function runScenario(workspaceId: string, spec: ScenarioSpec): Promise<ScenarioResult> {
  return request<ScenarioResult>(`/workspaces/${enc(workspaceId)}/scenario`, json('POST', spec))
}

export function estimateCost(workspaceId: string, body: CostInputs): Promise<CostEstimate> {
  return request<CostEstimate>(`/workspaces/${enc(workspaceId)}/cost-estimate`, json('POST', body))
}

export function getCostParameters(): Promise<CostParameters> {
  return request<CostParameters>('/insights/cost-parameters')
}
