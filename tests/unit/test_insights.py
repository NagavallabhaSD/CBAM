"""Carbon insights (Priority 2): breakdown, scenarios, tips, sensitivity, cost estimate."""

import pytest
from pydantic import ValidationError

from app.modules.calculation.engine import compute_emissions
from app.modules.insights.analysis import (
    InsightError,
    ScenarioSpec,
    apply_scenario,
    emissions_breakdown,
    reduction_tips,
    run_scenario,
    sensitivity,
)
from app.modules.insights.cost import CBAM_FACTOR, CostInputs, cost_parameters, estimate_cost
from app.modules.insights.analysis import Band
from app.schemas.workspace import EngineProcessSource
from tests.helpers import benchmark_engine_inputs, ev

V = "2026.1"
REL = 1e-9


# ------------------------------ Breakdown ------------------------------

def test_breakdown_sums_to_total_and_is_sorted():
    b = emissions_breakdown(benchmark_engine_inputs())
    assert [i.key for i in b.items] == ["precursor.wire_rod", "electricity", "fuel.furnace_oil"]
    assert sum(i.tco2 for i in b.items) == pytest.approx(1142.53776, rel=REL)
    assert sum(i.share for i in b.items) == pytest.approx(1.0, rel=REL)
    assert sum(i.see_contribution for i in b.items) == pytest.approx(2.28507552, rel=REL)
    assert b.items[1].tco2 == pytest.approx(143.2, rel=REL)


def test_breakdown_marks_fallback_grid_and_process():
    inputs = benchmark_engine_inputs(grid_fallback=True, process_sources=[
        EngineProcessSource(name="Pickling", method="direct", direct=ev(5.0, "tCO2"))])
    items = {i.key: i for i in emissions_breakdown(inputs).items}
    assert items["electricity"].fallback_based is True
    assert items["process.Pickling"].tco2 == pytest.approx(4.0, rel=REL)  # alpha 0.8


# ------------------------------ Scenarios ------------------------------

def test_electricity_cut_scenario(db):
    r = run_scenario(db, benchmark_engine_inputs(), ScenarioSpec(electricity_cut_pct=10), V)
    assert r.tco2_saving == pytest.approx(14.32, rel=REL)
    assert r.scenario.see_tco2_per_t == pytest.approx(2.28507552 - 14.32 / 500, rel=REL)
    assert r.scenario.band.p5 < r.scenario.see_tco2_per_t < r.scenario.band.p95


def test_ppa_scenario_blends_grid_factor(db):
    r = run_scenario(db, benchmark_engine_inputs(), ScenarioSpec(ppa_share_pct=50, ppa_ef=0.1), V)
    blended = 0.716 * 0.5 + 0.1 * 0.5
    assert r.tco2_saving == pytest.approx(250 * 0.8 * (0.716 - blended), rel=REL)
    assert "0.7160 -> 0.4080" in r.changes[0]


def test_supplier_switch_scenario(db):
    r = run_scenario(db, benchmark_engine_inputs(), ScenarioSpec(precursor_see=1.5), V)
    assert r.tco2_saving == pytest.approx(520 * 0.35, rel=REL)
    assert r.see_change_pct == pytest.approx(-520 * 0.35 / 1142.53776 * 100, rel=1e-6)


def test_fuel_switch_is_energy_equivalent(db):
    inputs = benchmark_engine_inputs()
    modified, changes = apply_scenario(db, inputs, ScenarioSpec(fuel_switch_to="natural_gas"), V)
    fuel = modified.fuels[0]
    assert fuel.key == "natural_gas" and fuel.quantity.unit == "m3"
    energy = 15000 * 0.0402
    assert fuel.quantity.value * 0.0385 == pytest.approx(energy, rel=REL)
    assert fuel.ef.source_type == "fallback" and fuel.ef.factor_id is not None
    raw = compute_emissions(modified).fuels[0].raw_tco2
    assert raw == pytest.approx(energy * 0.0561, rel=REL)
    with pytest.raises(InsightError, match="already"):
        apply_scenario(db, inputs, ScenarioSpec(fuel_switch_to="furnace_oil"), V)


def test_combined_scenario_and_yield(db):
    spec = ScenarioSpec(electricity_cut_pct=10, precursor_cut_pct=2, fuel_cut_pct=10)
    modified, changes = apply_scenario(db, benchmark_engine_inputs(), spec, V)
    assert len(changes) == 3
    assert modified.precursors[0].quantity.value == pytest.approx(509.6)
    assert modified.fuels[0].quantity.value == pytest.approx(13500)


def test_empty_scenario_equals_baseline(db):
    r = run_scenario(db, benchmark_engine_inputs(), ScenarioSpec(), V)
    assert r.tco2_saving == 0 and r.baseline == r.scenario
    assert ScenarioSpec().is_empty()


def test_scenario_errors(db):
    no_elec = benchmark_engine_inputs(electricity=None, grid_ef=None)
    with pytest.raises(InsightError):
        apply_scenario(db, no_elec, ScenarioSpec(electricity_cut_pct=5), V)
    with pytest.raises(InsightError):
        apply_scenario(db, no_elec, ScenarioSpec(ppa_share_pct=5), V)
    bare = benchmark_engine_inputs(fuels=[], precursors=[])
    for spec in (ScenarioSpec(fuel_cut_pct=5), ScenarioSpec(fuel_switch_to="diesel"),
                 ScenarioSpec(precursor_see=1), ScenarioSpec(precursor_cut_pct=1)):
        with pytest.raises(InsightError):
            apply_scenario(db, bare, spec, V)
    with pytest.raises(ValidationError):
        ScenarioSpec(fuel_switch_to="hydrogen")
    with pytest.raises(ValidationError):
        ScenarioSpec(electricity_cut_pct=120)


def test_fuel_switch_needs_register_factor(db):
    inputs = benchmark_engine_inputs()
    with pytest.raises(InsightError, match="register has no factor"):
        apply_scenario(db, inputs, ScenarioSpec(fuel_switch_to="diesel"), "2025.1")


# ------------------------------ Tips ------------------------------

def test_tips_are_ranked_and_engine_calculated(db):
    tips = reduction_tips(db, benchmark_engine_inputs(), V)
    assert [t.rank for t in tips] == list(range(1, len(tips) + 1))
    assert [t.tco2_saving for t in tips] == sorted((t.tco2_saving for t in tips), reverse=True)
    by_id = {t.id: t for t in tips}
    assert by_id["lower_carbon_supplier"].tco2_saving == pytest.approx(962 * 0.2, rel=REL)
    assert by_id["renewable_ppa"].tco2_saving == pytest.approx(143.2 * 0.5, rel=REL)
    assert by_id["electricity_efficiency"].see_saving == pytest.approx(14.32 / 500, rel=REL)
    for tip in tips:
        replay = run_scenario(db, benchmark_engine_inputs(), tip.scenario, V)
        assert replay.tco2_saving == pytest.approx(tip.tco2_saving, rel=REL)
        assert tip.assumption and tip.action


def test_tips_skip_levers_that_do_not_apply(db):
    inputs = benchmark_engine_inputs(fuels=[], precursors=[])
    ids = {t.id for t in reduction_tips(db, inputs, V)}
    assert ids == {"electricity_efficiency", "renewable_ppa"}


# ------------------------------ Sensitivity ------------------------------

def test_tornado_order_and_values():
    s = sensitivity(benchmark_engine_inputs())
    assert s.base_see == pytest.approx(2.28507552, rel=REL)
    labels = [b.label for b in s.bars]
    assert labels[0] == "Target product output"
    swings = [b.swing for b in s.bars]
    assert swings == sorted(swings, reverse=True)
    see = {b.key: b for b in s.bars}["precursor.wire_rod.see"]
    assert see.see_high - s.base_see == pytest.approx(0.1 * 962 / 500, rel=1e-9)
    of = {b.key: b for b in s.bars}["fuel.furnace_oil.of"]
    assert of.see_high == pytest.approx(s.base_see) and "Capped" in of.note


def test_sensitivity_dedicated_and_bad_swing():
    s = sensitivity(benchmark_engine_inputs(dedicated=True, total_installation_production=None), swing=0.2)
    assert "production.total_installation" not in {b.key for b in s.bars}
    assert s.swing_pct == pytest.approx(20)
    with pytest.raises(InsightError):
        sensitivity(benchmark_engine_inputs(), swing=1.5)


def test_sensitivity_records_impossible_variation():
    tight = benchmark_engine_inputs(total_installation_production=ev(520.0, "t"))
    bar = {b.key: b for b in sensitivity(tight).bars}["production.target"]
    assert bar.note and "not possible" in bar.note


def test_sensitivity_includes_process_sources():
    inputs = benchmark_engine_inputs(process_sources=[
        EngineProcessSource(name="Pickling", method="direct", direct=ev(5.0, "tCO2")),
        EngineProcessSource(name="Lime", method="activity", activity=ev(2.0, "t"), factor=ev(0.75, "tCO2/t"))])
    keys = {b.key for b in sensitivity(inputs).bars}
    assert {"process.Pickling", "process.Lime.activity"} <= keys


# ------------------------------ Cost ------------------------------

def test_cost_estimate_gross_and_with_benchmark():
    band = Band(p5=2.2, p50=2.285, p95=2.33)
    gross = estimate_cost(2.28507552, band, CostInputs(shipment_tonnes=20))
    assert gross.label == "ESTIMATE" and "ESTIMATE ONLY" in gross.disclaimer
    assert gross.central.certificates == pytest.approx(2.28507552 * 20)
    assert gross.central.cost_eur == pytest.approx(2.28507552 * 20 * 82.32)
    net = estimate_cost(2.28507552, band, CostInputs(shipment_tonnes=20, benchmark_tco2_per_t=1.4, year=2030,
                                                    carbon_price_paid_eur_per_t=5, eur_to_inr=100))
    per_t = 2.28507552 - 1.4 * 0.515
    assert net.cbam_factor == 0.515
    assert net.central.cost_per_t_eur == pytest.approx(per_t * 82.32 - 5)
    assert net.central.cost_inr == pytest.approx(net.central.cost_eur * 100)
    assert net.low.cost_eur < net.central.cost_eur < net.high.cost_eur


def test_cost_never_negative_and_parameters():
    est = estimate_cost(1.0, Band(p5=0.9, p50=1, p95=1.1), CostInputs(shipment_tonnes=1, benchmark_tco2_per_t=5))
    assert est.central.cost_eur == 0 and est.central.certificates == 0
    params = cost_parameters()
    assert params["cbam_factor"][2026] == 0.975 and params["cbam_factor"][2034] == 0
    assert params["default_price"]["eur_per_tco2"] == 82.32
    assert CBAM_FACTOR[2028] == 0.9
    with pytest.raises(ValidationError):
        CostInputs(shipment_tonnes=0)
    with pytest.raises(ValidationError):
        CostInputs(shipment_tonnes=1, year=2025)
