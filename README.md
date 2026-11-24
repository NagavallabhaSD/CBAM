# CBAM-Ready Emissions Passport
An open-source decision-support prototype for Indian MSME exporters under the EU CBAM regime.

## Running the app

```bash
pip install -r requirements.txt
uvicorn app.main:app --port 8000          # API + OpenAPI docs at http://localhost:8000/docs
cd web && npm install && npm run dev      # React UI at http://localhost:5173 (VITE_API_URL=http://localhost:8000)
```

## How to run tests

```bash
pip install -r requirements.txt
pytest -q --cov=app --cov-report=term-missing
```

The suite uses a temporary in-memory SQLite database (see `tests/conftest.py`), so it runs on a clean
checkout with one command. Layout:

```
tests/
    conftest.py                  # seeded temp DB, API client, benchmark workspace
    helpers.py                   # benchmark inputs (500 t product, 625 t installation, alpha 0.8)
    unit/test_engine.py          # check values, OF, process, unit errors, monotonicity
    unit/test_validation.py      # V1 units, V2 overlaps/gaps/window, V3 duplicates, waivers
    unit/test_gaps.py            # required inputs, Incomplete / Ready, audit rows
    unit/test_fallbacks.py       # explicit fallbacks, allowed = false, register uncertainty
    unit/test_status.py          # transitions, preconditions, automatic reset to Draft
    unit/test_register.py        # immutability, versioning, 2026.1 reproducible after 2026.2
    unit/test_monte_carlo.py     # seed 42, repeatability, wider band with fallbacks
    unit/test_insights.py        # breakdown, scenarios, tips, tornado, cost estimate
    integration/test_api_flow.py # Incomplete -> fallback -> Draft -> User-Confirmed, PDF, insights API
```

The latest coverage report is saved in `reports/coverage.txt` (calculation, validation, gaps, review
and registry modules are all above 85 %).

## Priority 2: carbon insights

The **Carbon insights** page adds an emissions breakdown chart, engine-calculated reduction tips, a scenario
simulator, a sensitivity tornado chart and a CBAM certificate cost estimator (labelled as an estimate).
See [`docs/PRIORITY2.md`](docs/PRIORITY2.md).

## Priority 1 features

See [`docs/PRIORITY1.md`](docs/PRIORITY1.md) for the emission-factor register, the oxidation-factor and
process-emission engine, validation checks, the data-gap register, fallbacks with widened uncertainty,
the review status workflow, the new API endpoints and the known limitations.
