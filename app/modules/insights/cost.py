"""CBAM certificate cost estimator (Priority 2). Always labelled an ESTIMATE.

certificates per tonne = max(0, SEE - CBAM benchmark x CBAM factor x CSCF)
cost per tonne        = certificates per tonne x certificate price - carbon price paid in the origin country
cost per shipment     = cost per tonne x shipment tonnes

Sources (checked 24 Nov 2026):
* Certificate price: quarterly averages of EU ETS auction prices for 2026
  (Q1 75.36, Q2 75.28, Q3 82.32 EUR/tCO2e); weekly from 2027.
  https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/price-cbam-certificates_en
* CBAM factor phase-in (free-allocation adjustment): 0.975 in 2026 down to 0 in 2034,
  Implementing Regulation (EU) 2025/2620.
The CBAM benchmark for the product and the cross-sectoral correction factor are
inputs: the default benchmark of 0 gives the gross (upper-bound) cost.
"""

from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from app.modules.insights.analysis import Band

CBAM_FACTOR: Dict[int, float] = {
    2026: 0.975, 2027: 0.95, 2028: 0.90, 2029: 0.775, 2030: 0.515,
    2031: 0.39, 2032: 0.265, 2033: 0.14, 2034: 0.0,
}

CERTIFICATE_PRICES = [
    {"period": "Q1 2026", "eur_per_tco2": 75.36, "published": "2026-04-07"},
    {"period": "Q2 2026", "eur_per_tco2": 75.28, "published": "2026-07-06"},
    {"period": "Q3 2026", "eur_per_tco2": 82.32, "published": "2026-10-05"},
]
DEFAULT_PRICE = CERTIFICATE_PRICES[-1]

SOURCES = [
    {"title": "European Commission - Price of CBAM certificates",
     "url": "https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/price-cbam-certificates_en"},
    {"title": "Commission Implementing Regulation (EU) 2025/2620 - free allocation adjustment",
     "url": "https://eur-lex.europa.eu/eli/reg_impl/2025/2620/oj/eng"},
]

DISCLAIMER = ("ESTIMATE ONLY. Not a CBAM declaration or an invoice. The certificate price, the product's "
              "CBAM benchmark, the correction factor and any carbon price paid must be confirmed by the EU "
              "importer (authorised CBAM declarant).")


class CostInputs(BaseModel):
    shipment_tonnes: float = Field(..., gt=0, description="Tonnes of product in the shipment")
    certificate_price_eur: float = Field(DEFAULT_PRICE["eur_per_tco2"], gt=0)
    year: int = Field(2026, ge=2026, le=2034, description="Import year, sets the CBAM factor")
    benchmark_tco2_per_t: float = Field(0.0, ge=0, description="CBAM benchmark for the product (0 = gross cost)")
    cscf: float = Field(1.0, gt=0, le=1, description="Cross-sectoral correction factor")
    carbon_price_paid_eur_per_t: float = Field(0.0, ge=0, description="Carbon price already paid per tonne of product")
    eur_to_inr: Optional[float] = Field(None, gt=0, description="Optional exchange rate for an INR figure")


class CostLine(BaseModel):
    see_tco2_per_t: float
    certificates_per_t: float
    certificates: float
    cost_per_t_eur: float
    cost_eur: float
    cost_inr: Optional[float] = None


class CostEstimate(BaseModel):
    label: str = "ESTIMATE"
    inputs: CostInputs
    cbam_factor: float
    free_allocation_per_t: float
    central: CostLine
    low: CostLine
    high: CostLine
    formula: str
    disclaimer: str = DISCLAIMER
    sources: List[dict] = Field(default_factory=lambda: list(SOURCES))


def _line(see: float, params: CostInputs, factor: float) -> CostLine:
    free = params.benchmark_tco2_per_t * factor * params.cscf
    per_t = max(0.0, see - free)
    cost_per_t = max(0.0, per_t * params.certificate_price_eur - params.carbon_price_paid_eur_per_t)
    cost = cost_per_t * params.shipment_tonnes
    return CostLine(see_tco2_per_t=see, certificates_per_t=per_t, certificates=per_t * params.shipment_tonnes,
                    cost_per_t_eur=cost_per_t, cost_eur=cost,
                    cost_inr=cost * params.eur_to_inr if params.eur_to_inr else None)


def estimate_cost(see: float, band: Band, params: CostInputs) -> CostEstimate:
    factor = CBAM_FACTOR[params.year]
    return CostEstimate(
        inputs=params,
        cbam_factor=factor,
        free_allocation_per_t=params.benchmark_tco2_per_t * factor * params.cscf,
        central=_line(see, params, factor),
        low=_line(band.p5, params, factor),
        high=_line(band.p95, params, factor),
        formula=("certificates/t = max(0, SEE - benchmark x CBAM factor x CSCF); "
                 "cost = certificates/t x price - carbon price paid, x shipment tonnes"),
    )


def cost_parameters() -> dict:
    return {"cbam_factor": CBAM_FACTOR, "certificate_prices": CERTIFICATE_PRICES,
            "default_price": DEFAULT_PRICE, "sources": SOURCES, "disclaimer": DISCLAIMER}
