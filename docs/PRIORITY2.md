# Priority 2: carbon insight features

New page **Carbon insights** (`/insights` in the React app, linked from the Passport page) and module
`app/modules/insights/`. Every number is produced by the deterministic engine (`compute_emissions`) and the
seeded Monte Carlo (`simulate_engine`) from Priority 1; no language model is involved, and tip texts are fixed
templates. Insights need a complete calculation: a workspace with open gaps answers HTTP 422 with the gap list.

| Feature | Code | What it does |
|---|---|---|
| Emissions breakdown | `analysis.emissions_breakdown` | Allocated tCO2 per fuel, process source, electricity and precursor, with share of total and tCO2 per tonne of product. Horizontal bar chart + table. |
| Carbon reduction tips | `analysis.reduction_tips` | Six levers (cut electricity, renewable PPA, cut fuel, switch fuel, lower-carbon supplier, material yield). Each is run through the scenario engine; ranked by tCO2 saved, with SEE saving and the assumption stated. Lever sizes are in `app/config.py` (`TIP_*`). |
| Scenario simulator | `analysis.run_scenario` | Electricity cut %, PPA share and factor, fuel cut %, energy-equivalent fuel switch (register factors), new supplier SEE, precursor yield. Returns baseline vs scenario SEE and P5-P95 band (same seed). The passport is not changed. |
| Sensitivity analysis | `analysis.sensitivity` | One-at-a-time ±10 % (`SENSITIVITY_SWING`) on every input; tornado chart sorted by SEE swing. Oxidation factor is capped at 1. |
| CBAM cost estimator | `cost.estimate_cost` | certificates/t = max(0, SEE − benchmark × CBAM factor × CSCF); cost = certificates/t × price − carbon price paid, × shipment tonnes. Range from SEE P5/P95. Always labelled **ESTIMATE**. |

## API (prefix `/api/v1`)

- `GET /workspaces/{id}/insights?swing=0.1` – baseline, breakdown, ranked tips, tornado data
- `POST /workspaces/{id}/scenario` – body `ScenarioSpec`
- `POST /workspaces/{id}/cost-estimate` – body `CostInputs` (+ optional `scenario`)
- `GET /insights/cost-parameters` – CBAM factor table, published certificate prices, sources

## Cost parameters (checked 24 Nov 2026)

- Certificate price: 2026 quarterly averages of EU ETS auction prices published by the Commission:
  Q1 €75.36, Q2 €75.28, Q3 €82.32 per tCO2e; weekly prices from 2027. Default = latest (Q3 2026).
  <https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/price-cbam-certificates_en>
- CBAM factor (free-allocation adjustment): 0.975 (2026), 0.95, 0.90, 0.775, 0.515, 0.39, 0.265, 0.14, 0 (2034);
  Implementing Regulation (EU) 2025/2620.
- The product's CBAM benchmark and the cross-sectoral correction factor are user inputs. The default benchmark 0
  gives the gross (upper-bound) cost; the fastener benchmark from the EU table is still an open question.

## Limitations

- Tip lever sizes (10 % electricity, 50 % PPA, 20 % lower supplier SEE, 2 % yield, ...) are illustrative
  defaults; the supplier tip must be replaced with a real supplier quote before acting on it.
- Whether PPA electricity reduces CBAM indirect emissions depends on the rules for indirect emissions; the tip
  says so.
- The cost estimate is not a CBAM declaration; the EU importer (authorised declarant) confirms price, benchmark,
  correction factor and any carbon price paid.
