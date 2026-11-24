"""Carbon insights (Priority 2): emissions breakdown, scenario simulator,
ranked reduction tips and one-at-a-time sensitivity.

Every number here comes from the deterministic engine
(``compute_emissions``) and the seeded Monte Carlo (``simulate_engine``).
A scenario is a modified copy of the resolved engine inputs; nothing is
estimated by a language model and the tip texts are fixed templates.
"""

from typing import Callable, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.calculation.engine import EngineInputError, compute_emissions
from app.modules.calculation.unit_converter import FUEL_FORMS, canonical_factor, ncv_to_canonical
from app.modules.registry.factors import get_factor
from app.modules.uncertainty.monte_carlo import simulate_engine
from app.schemas.workspace import (
    EngineFuel,
    EngineInputs,
    EngineResult,
    EngineValue,
    UncertaintySpec,
)


class InsightError(ValueError):
    """A scenario cannot be applied to these inputs."""


# ---------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------


class Band(BaseModel):
    p5: float
    p50: float
    p95: float


class Snapshot(BaseModel):
    see_tco2_per_t: float
    total_tco2: float
    band: Band
    data_quality_label: str


class BreakdownItem(BaseModel):
    key: str
    label: str
    category: Literal["fuel", "process", "electricity", "precursor"]
    tco2: float
    share: float = Field(..., description="Share of total embedded emissions, 0-1")
    see_contribution: float = Field(..., description="tCO2 per tonne of product")
    fallback_based: bool


class Breakdown(BaseModel):
    total_tco2: float
    see_tco2_per_t: float
    target_production_t: float
    items: List[BreakdownItem]


class ScenarioSpec(BaseModel):
    """A "what if". Percentages are 0-100. Empty fields mean "no change"."""

    name: str = "Custom scenario"
    electricity_cut_pct: float = Field(0.0, ge=0, le=100)
    ppa_share_pct: float = Field(0.0, ge=0, le=100, description="Share of electricity bought on a PPA")
    ppa_ef: float = Field(0.0, ge=0, description="Emission factor of the PPA electricity, tCO2/MWh")
    fuel_cut_pct: float = Field(0.0, ge=0, le=100)
    fuel_switch_to: Optional[str] = Field(None, description="Register fuel key, energy-equivalent switch")
    precursor_see: Optional[float] = Field(None, ge=0, description="New supplier SEE, tCO2/t, all precursors")
    precursor_cut_pct: float = Field(0.0, ge=0, le=100, description="Less precursor per tonne (yield)")

    @field_validator("fuel_switch_to")
    @classmethod
    def _fuel(cls, value):
        if value is not None and value not in FUEL_FORMS:
            raise ValueError(f"Unknown fuel '{value}'. Choose one of: {', '.join(sorted(FUEL_FORMS))}.")
        return value

    def is_empty(self) -> bool:
        return not any([self.electricity_cut_pct, self.ppa_share_pct, self.fuel_cut_pct, self.fuel_switch_to,
                        self.precursor_see is not None, self.precursor_cut_pct])


class ScenarioResult(BaseModel):
    name: str
    changes: List[str]
    baseline: Snapshot
    scenario: Snapshot
    tco2_saving: float
    see_saving: float
    see_change_pct: float
    breakdown: Breakdown


class Tip(BaseModel):
    id: str
    rank: int = 0
    title: str
    action: str
    assumption: str
    tco2_saving: float
    see_saving: float
    see_after: float
    saving_pct: float
    scenario: ScenarioSpec


class SensitivityBar(BaseModel):
    key: str
    label: str
    base_value: float
    unit: str
    see_low: float
    see_high: float
    swing: float
    note: Optional[str] = None


class Sensitivity(BaseModel):
    swing_pct: float
    base_see: float
    bars: List[SensitivityBar]


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


def _snapshot(inputs: EngineInputs, seed: int, iterations: int) -> Snapshot:
    result = compute_emissions(inputs)
    mc = simulate_engine(inputs, iterations=iterations, seed=seed)
    return Snapshot(see_tco2_per_t=result.see_tco2_per_t, total_tco2=result.total_tco2,
                    band=Band(p5=mc.p5, p50=mc.p50, p95=mc.p95),
                    data_quality_label=result.data_quality_label)


def breakdown_from_result(result: EngineResult) -> Breakdown:
    total = result.total_tco2
    target = result.target_production_t
    items: List[BreakdownItem] = []

    def add(key, label, category, tco2, fallback):
        items.append(BreakdownItem(key=key, label=label, category=category, tco2=tco2,
                                   share=tco2 / total if total > 0 else 0.0,
                                   see_contribution=tco2 / target, fallback_based=fallback))

    for term in result.fuels:
        add(f"fuel.{term.key}", f"Fuel: {term.name}", "fuel", term.allocated_tco2, term.fallback_based)
    for term in result.process:
        add(f"process.{term.key}", f"Process: {term.name}", "process", term.allocated_tco2, term.fallback_based)
    if result.scope2_counted_tco2 or result.scope2_raw_tco2:
        # The engine result does not say whether the grid factor was a fallback;
        # emissions_breakdown() fills that in from the inputs.
        add("electricity", "Electricity (indirect)", "electricity", result.scope2_counted_tco2, False)
    for term in result.precursors:
        add(f"precursor.{term.key}", f"Precursor: {term.name}", "precursor", term.allocated_tco2, term.fallback_based)
    items.sort(key=lambda item: item.tco2, reverse=True)
    return Breakdown(total_tco2=total, see_tco2_per_t=result.see_tco2_per_t, target_production_t=target, items=items)


def emissions_breakdown(inputs: EngineInputs) -> Breakdown:
    result = compute_emissions(inputs)
    breakdown = breakdown_from_result(result)
    grid_fallback = inputs.grid_ef is not None and "fallback" in (
        inputs.grid_ef.source_type, inputs.electricity.source_type if inputs.electricity else "measured")
    for item in breakdown.items:
        if item.category == "electricity":
            item.fallback_based = grid_fallback
    return breakdown


def _scaled(ev: EngineValue, factor: float) -> EngineValue:
    """Scales a value and its triangular bounds; relative uncertainty is unchanged."""
    spec = ev.uncertainty
    if spec.kind == "triangular" and spec.low is not None and spec.high is not None:
        spec = UncertaintySpec(kind="triangular", low=spec.low * factor, high=spec.high * factor)
    return ev.model_copy(update={"value": ev.value * factor, "uncertainty": spec})


def _register_value(db: Session, key: str, version: str) -> EngineValue:
    row = get_factor(db, key, version)
    if row is None:
        raise InsightError(f"The register has no factor '{key}' in set {version}.")
    if row.uncertainty_type == "triangular":
        spec = UncertaintySpec(kind="triangular", low=row.uncertainty_low, high=row.uncertainty_high)
    elif row.uncertainty_type == "relative":
        spec = UncertaintySpec(kind="relative", rel=row.uncertainty_rel)
    else:
        spec = UncertaintySpec()
    return EngineValue(value=row.value, unit=row.unit, source_type="fallback", factor_id=row.id,
                       factor_set_version=row.factor_set_version, uncertainty=spec)


def _switch_fuel(db: Session, fuel: EngineFuel, target: str, version: str) -> EngineFuel:
    """Replaces a fuel by an energy-equivalent quantity of another register fuel."""
    if fuel.key == target:
        raise InsightError(f"{fuel.name} is already {target.replace('_', ' ')}.")
    form = FUEL_FORMS.get(fuel.key)
    if form is None:
        raise InsightError(f"Cannot switch fuel '{fuel.key}': its physical form is unknown.")
    energy_gj = (fuel.quantity.value * canonical_factor(fuel.quantity.unit, form)
                 * fuel.ncv.value * ncv_to_canonical(1.0, fuel.ncv.unit, form))
    ncv = _register_value(db, f"fuel.{target}.ncv", version)
    ef = _register_value(db, f"fuel.{target}.ef", version)
    of = _register_value(db, f"fuel.{target}.of", version)
    new_form = FUEL_FORMS[target]
    canonical_unit = {"liquid_fuel": "L", "gas": "m3", "mass": "t"}[new_form]
    quantity = energy_gj / (ncv.value * ncv_to_canonical(1.0, ncv.unit, new_form))
    return EngineFuel(key=target, name=target.replace("_", " ").title(), is_shared=fuel.is_shared,
                      quantity=fuel.quantity.model_copy(update={"value": quantity, "unit": canonical_unit}),
                      ncv=ncv, ef=ef, oxidation_factor=of)


def apply_scenario(db: Session, inputs: EngineInputs, spec: ScenarioSpec, version: str):
    """Returns (modified inputs, list of plain-language changes)."""
    new = inputs.model_copy(deep=True)
    changes: List[str] = []

    if spec.electricity_cut_pct:
        if new.electricity is None:
            raise InsightError("There is no electricity consumption to cut.")
        new.electricity = _scaled(new.electricity, 1 - spec.electricity_cut_pct / 100)
        changes.append(f"Electricity consumption reduced by {spec.electricity_cut_pct:g}%.")
    if spec.ppa_share_pct:
        if new.grid_ef is None:
            raise InsightError("There is no grid factor to replace with a PPA.")
        share = spec.ppa_share_pct / 100
        grid = new.grid_ef.value
        blended = grid * (1 - share) + spec.ppa_ef * share
        new.grid_ef = _scaled(new.grid_ef, blended / grid if grid else 1.0)
        changes.append(
            f"{spec.ppa_share_pct:g}% of electricity from a PPA at {spec.ppa_ef:g} tCO2/MWh; "
            f"effective factor {grid:.4f} -> {blended:.4f} tCO2/MWh."
        )
    if spec.fuel_switch_to:
        if not new.fuels:
            raise InsightError("There is no fuel to switch.")
        names = ", ".join(f.name for f in new.fuels)
        new.fuels = [_switch_fuel(db, fuel, spec.fuel_switch_to, version) for fuel in new.fuels]
        changes.append(
            f"{names} replaced by an energy-equivalent amount of {spec.fuel_switch_to.replace('_', ' ')} "
            f"using register factors (set {version})."
        )
    if spec.fuel_cut_pct:
        if not new.fuels:
            raise InsightError("There is no fuel use to cut.")
        new.fuels = [f.model_copy(update={"quantity": _scaled(f.quantity, 1 - spec.fuel_cut_pct / 100)})
                     for f in new.fuels]
        changes.append(f"Fuel consumption reduced by {spec.fuel_cut_pct:g}%.")
    if spec.precursor_see is not None:
        if not new.precursors:
            raise InsightError("There is no precursor to re-source.")
        for prec in new.precursors:
            changes.append(f"{prec.name}: supplier SEE {prec.see.value:g} -> {spec.precursor_see:g} tCO2/t.")
            prec.see = EngineValue(value=spec.precursor_see, unit="tCO2/t", source_type="measured")
    if spec.precursor_cut_pct:
        if not new.precursors:
            raise InsightError("There is no precursor quantity to reduce.")
        for prec in new.precursors:
            prec.quantity = _scaled(prec.quantity, 1 - spec.precursor_cut_pct / 100)
        changes.append(f"Precursor input per tonne of product reduced by {spec.precursor_cut_pct:g}% (yield).")
    if not changes:
        changes.append("No change: the scenario equals the baseline.")
    return new, changes


def run_scenario(db: Session, inputs: EngineInputs, spec: ScenarioSpec, version: str,
                 seed: Optional[int] = None, iterations: Optional[int] = None) -> ScenarioResult:
    seed = settings.MC_DEFAULT_SEED if seed is None else seed
    iterations = iterations or settings.MC_DEFAULT_ITERATIONS
    modified, changes = apply_scenario(db, inputs, spec, version)
    try:
        base = _snapshot(inputs, seed, iterations)
        scen = _snapshot(modified, seed, iterations)
    except EngineInputError as exc:
        raise InsightError(str(exc)) from exc
    saving = base.total_tco2 - scen.total_tco2
    see_saving = base.see_tco2_per_t - scen.see_tco2_per_t
    return ScenarioResult(
        name=spec.name, changes=changes, baseline=base, scenario=scen, tco2_saving=saving, see_saving=see_saving,
        see_change_pct=-see_saving / base.see_tco2_per_t * 100 if base.see_tco2_per_t else 0.0,
        breakdown=emissions_breakdown(modified),
    )


# ---------------------------------------------------------------------
# Ranked reduction tips
# ---------------------------------------------------------------------


def candidate_tips(inputs: EngineInputs) -> List[dict]:
    s = settings
    tips = []
    if inputs.electricity is not None:
        tips.append(dict(
            id="electricity_efficiency", title="Cut electricity use",
            action="Efficiency measures such as compressed-air leak repair, efficient motors and furnace insulation.",
            assumption=f"{s.TIP_ELECTRICITY_CUT * 100:g}% less electricity, same output.",
            scenario=ScenarioSpec(name="Cut electricity", electricity_cut_pct=s.TIP_ELECTRICITY_CUT * 100)))
    if inputs.grid_ef is not None and inputs.grid_ef.value > s.TIP_PPA_EF:
        tips.append(dict(
            id="renewable_ppa", title="Buy renewable electricity (PPA)",
            action="Contract part of the load through a solar or wind power purchase agreement with documented attributes.",
            assumption=(f"{s.TIP_PPA_SHARE * 100:g}% of electricity on a PPA at {s.TIP_PPA_EF:g} tCO2/MWh; "
                        "acceptance of PPA electricity for CBAM depends on the rules for indirect emissions."),
            scenario=ScenarioSpec(name="Renewable PPA", ppa_share_pct=s.TIP_PPA_SHARE * 100, ppa_ef=s.TIP_PPA_EF)))
    if inputs.fuels:
        tips.append(dict(
            id="fuel_efficiency", title="Reduce fuel use",
            action="Burner tuning, waste-heat recovery and better furnace loading.",
            assumption=f"{s.TIP_FUEL_CUT * 100:g}% less fuel, same output.",
            scenario=ScenarioSpec(name="Reduce fuel", fuel_cut_pct=s.TIP_FUEL_CUT * 100)))
        if all(f.key != s.TIP_SWITCH_TO_FUEL for f in inputs.fuels) and s.TIP_SWITCH_TO_FUEL in FUEL_FORMS:
            target = s.TIP_SWITCH_TO_FUEL.replace("_", " ")
            tips.append(dict(
                id="fuel_switch", title=f"Switch fuel to {target}",
                action=f"Replace the current fuel with {target} where a connection is available.",
                assumption=f"Same useful energy, supplied by {target} with register default factors.",
                scenario=ScenarioSpec(name=f"Switch to {target}", fuel_switch_to=s.TIP_SWITCH_TO_FUEL)))
    if inputs.precursors:
        current = max(p.see.value for p in inputs.precursors)
        target = current * (1 - s.TIP_SUPPLIER_SEE_CUT)
        tips.append(dict(
            id="lower_carbon_supplier", title="Source lower-carbon wire rod",
            action="Ask suppliers for wire rod from scrap-based (EAF) routes with verified SEE values.",
            assumption=(f"Supplier SEE {s.TIP_SUPPLIER_SEE_CUT * 100:g}% lower ({current:.3g} -> {target:.3g} tCO2/t). "
                        "Replace with a real supplier quote before acting."),
            scenario=ScenarioSpec(name="Lower-carbon supplier", precursor_see=target)))
        tips.append(dict(
            id="material_yield", title="Improve material yield",
            action="Reduce scrap and off-cuts in heading, threading and trimming.",
            assumption=f"{s.TIP_PRECURSOR_YIELD * 100:g}% less wire rod per tonne of fasteners.",
            scenario=ScenarioSpec(name="Better yield", precursor_cut_pct=s.TIP_PRECURSOR_YIELD * 100)))
    return tips


def reduction_tips(db: Session, inputs: EngineInputs, version: str) -> List[Tip]:
    base = compute_emissions(inputs)
    tips: List[Tip] = []
    for tip in candidate_tips(inputs):
        try:
            modified, _ = apply_scenario(db, inputs, tip["scenario"], version)
            after = compute_emissions(modified)
        except (InsightError, EngineInputError):
            continue
        saving = base.total_tco2 - after.total_tco2
        if saving <= 1e-9:
            continue
        tips.append(Tip(**tip, tco2_saving=saving, see_saving=base.see_tco2_per_t - after.see_tco2_per_t,
                        see_after=after.see_tco2_per_t, saving_pct=saving / base.total_tco2 * 100))
    tips.sort(key=lambda t: t.tco2_saving, reverse=True)
    for rank, tip in enumerate(tips, start=1):
        tip.rank = rank
    return tips


# ---------------------------------------------------------------------
# Sensitivity (tornado)
# ---------------------------------------------------------------------

Getter = Callable[[EngineInputs], Optional[EngineValue]]
Setter = Callable[[EngineInputs, EngineValue], None]


def _parameters(inputs: EngineInputs) -> List[tuple]:
    params = []

    def add(key, label, get: Getter, put: Setter, cap: Optional[float] = None):
        if get(inputs) is not None:
            params.append((key, label, get, put, cap))

    for i, fuel in enumerate(inputs.fuels):
        def g(attr, idx=i):
            return lambda x: getattr(x.fuels[idx], attr)

        def p(attr, idx=i):
            return lambda x, v: setattr(x.fuels[idx], attr, v)
        add(f"fuel.{fuel.key}.quantity", f"{fuel.name} quantity", g("quantity"), p("quantity"))
        add(f"fuel.{fuel.key}.ncv", f"{fuel.name} NCV", g("ncv"), p("ncv"))
        add(f"fuel.{fuel.key}.ef", f"{fuel.name} emission factor", g("ef"), p("ef"))
        add(f"fuel.{fuel.key}.of", f"{fuel.name} oxidation factor", g("oxidation_factor"), p("oxidation_factor"), cap=1.0)
    add("electricity.consumed", "Electricity consumed", lambda x: x.electricity, lambda x, v: setattr(x, "electricity", v))
    add("electricity.grid_ef", "Grid emission factor", lambda x: x.grid_ef, lambda x, v: setattr(x, "grid_ef", v))
    for i, prec in enumerate(inputs.precursors):
        add(f"precursor.{prec.key}.quantity", f"{prec.name} quantity",
            lambda x, idx=i: x.precursors[idx].quantity, lambda x, v, idx=i: setattr(x.precursors[idx], "quantity", v))
        add(f"precursor.{prec.key}.see", f"{prec.name} supplier SEE",
            lambda x, idx=i: x.precursors[idx].see, lambda x, v, idx=i: setattr(x.precursors[idx], "see", v))
    for i, src in enumerate(inputs.process_sources):
        if src.method == "direct":
            add(f"process.{src.name}", f"Process: {src.name}",
                lambda x, idx=i: x.process_sources[idx].direct,
                lambda x, v, idx=i: setattr(x.process_sources[idx], "direct", v))
        else:
            add(f"process.{src.name}.activity", f"Process: {src.name} activity",
                lambda x, idx=i: x.process_sources[idx].activity,
                lambda x, v, idx=i: setattr(x.process_sources[idx], "activity", v))
    add("production.target", "Target product output", lambda x: x.target_production,
        lambda x, v: setattr(x, "target_production", v))
    if inputs.utility_coverage == "shared":
        add("production.total_installation", "Total installation output", lambda x: x.total_installation_production,
            lambda x, v: setattr(x, "total_installation_production", v))
    return params


def sensitivity(inputs: EngineInputs, swing: Optional[float] = None) -> Sensitivity:
    swing = settings.SENSITIVITY_SWING if swing is None else swing
    if not 0 < swing < 1:
        raise InsightError("The swing must be between 0 and 1 (e.g. 0.10 for +/-10%).")
    base = compute_emissions(inputs).see_tco2_per_t
    bars: List[SensitivityBar] = []
    for key, label, get, put, cap in _parameters(inputs):
        ev = get(inputs)
        results: Dict[str, Optional[float]] = {}
        note = None
        for direction, factor in (("low", 1 - swing), ("high", 1 + swing)):
            candidate = inputs.model_copy(deep=True)
            value = ev.value * factor
            if cap is not None and value > cap:
                value = cap
                note = f"Capped at {cap:g}: an oxidation factor cannot exceed 1."
            put(candidate, ev.model_copy(update={"value": value}))
            try:
                results[direction] = compute_emissions(candidate).see_tco2_per_t
            except EngineInputError as exc:
                results[direction] = base
                note = f"Variation not possible: {exc}"
        lo, hi = results["low"], results["high"]
        bars.append(SensitivityBar(key=key, label=label, base_value=ev.value, unit=ev.unit,
                                   see_low=lo, see_high=hi, swing=abs(hi - lo), note=note))
    bars.sort(key=lambda bar: bar.swing, reverse=True)
    return Sensitivity(swing_pct=swing * 100, base_see=base, bars=bars)
