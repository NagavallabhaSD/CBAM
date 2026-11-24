"""Carbon insights API (Priority 2): breakdown, tips, scenarios, sensitivity, cost estimate.

All endpoints run on the workspace's resolved engine inputs, so a workspace
with open gaps answers 422 with the gap list, like the calculation endpoint.
"""

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.db.database import get_db
from app.modules.calculation.engine import EngineInputError, IncompleteInputError, compute_emissions
from app.modules.gaps.fallbacks import build_engine_inputs
from app.modules.gaps.register import WorkspaceNotFound, get_workspace
from app.modules.insights.analysis import (
    Band,
    InsightError,
    ScenarioSpec,
    apply_scenario,
    emissions_breakdown,
    reduction_tips,
    run_scenario,
    sensitivity,
)
from app.modules.insights.cost import CostInputs, cost_parameters, estimate_cost
from app.modules.uncertainty.monte_carlo import simulate_engine

router = APIRouter(tags=["Carbon Insights"])


class CostRequest(CostInputs):
    scenario: Optional[ScenarioSpec] = Field(None, description="Estimate the cost after this scenario instead")


def _inputs(db: Session, workspace_id: str):
    try:
        ws = get_workspace(db, workspace_id)
        return ws, build_engine_inputs(db, workspace_id)
    except WorkspaceNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


def _incomplete(db: Session, workspace_id: str, exc: IncompleteInputError):
    db.commit()
    gaps = [json.loads(g.model_dump_json()) if hasattr(g, "model_dump_json") else {"input_key": str(g)}
            for g in exc.gaps]
    return JSONResponse(status_code=422, content={
        "detail": "Insights need a complete calculation. " + str(exc), "gaps": gaps})


@router.get("/workspaces/{workspace_id}/insights")
def get_insights(workspace_id: str, swing: Optional[float] = None, db: Session = Depends(get_db)):
    """Breakdown, ranked reduction tips and the tornado data in one call."""
    try:
        ws, inputs = _inputs(db, workspace_id)
        result = compute_emissions(inputs)
        mc = simulate_engine(inputs)
        payload = {
            "factor_set_version": ws.factor_set_version,
            "baseline": {"see_tco2_per_t": result.see_tco2_per_t, "total_tco2": result.total_tco2,
                         "band": {"p5": mc.p5, "p50": mc.p50, "p95": mc.p95},
                         "data_quality_label": result.data_quality_label, "mc_seed": settings.MC_DEFAULT_SEED},
            "breakdown": emissions_breakdown(inputs).model_dump(),
            "tips": [tip.model_dump() for tip in reduction_tips(db, inputs, ws.factor_set_version)],
            "sensitivity": sensitivity(inputs, swing).model_dump(),
        }
    except IncompleteInputError as exc:
        return _incomplete(db, workspace_id, exc)
    except (EngineInputError, InsightError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return payload


@router.post("/workspaces/{workspace_id}/scenario")
def post_scenario(workspace_id: str, spec: ScenarioSpec, db: Session = Depends(get_db)):
    """Recalculates SEE and the uncertainty band for a "what if"."""
    try:
        ws, inputs = _inputs(db, workspace_id)
        result = run_scenario(db, inputs, spec, ws.factor_set_version)
    except IncompleteInputError as exc:
        return _incomplete(db, workspace_id, exc)
    except InsightError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return result.model_dump()


@router.post("/workspaces/{workspace_id}/cost-estimate")
def post_cost(workspace_id: str, body: CostRequest, db: Session = Depends(get_db)):
    """Estimated CBAM certificate cost per shipment. Labelled as an estimate."""
    try:
        ws, inputs = _inputs(db, workspace_id)
        scenario_name = None
        if body.scenario is not None and not body.scenario.is_empty():
            inputs, _ = apply_scenario(db, inputs, body.scenario, ws.factor_set_version)
            scenario_name = body.scenario.name
        see = compute_emissions(inputs).see_tco2_per_t
        mc = simulate_engine(inputs)
    except IncompleteInputError as exc:
        return _incomplete(db, workspace_id, exc)
    except (EngineInputError, InsightError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    estimate = estimate_cost(see, Band(p5=mc.p5, p50=mc.p50, p95=mc.p95),
                             CostInputs(**body.model_dump(exclude={"scenario"})))
    db.commit()
    return {**estimate.model_dump(), "scenario": scenario_name}


@router.get("/insights/cost-parameters")
def get_cost_parameters():
    return cost_parameters()
