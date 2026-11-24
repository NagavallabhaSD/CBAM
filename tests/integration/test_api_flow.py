"""End-to-end API flow: Incomplete workspace -> fallback applied -> Draft -> User-Confirmed,
with validation findings, duplicate rejection, status resets and the generated PDF."""

import fitz

from tests.helpers import benchmark_inputs

V1 = "/api/v1"
WS = "IN-FDB-001"


def _pdf_text(content: bytes) -> str:
    with fitz.open(stream=content, filetype="pdf") as pdf:
        return "\n".join(page.get_text() for page in pdf)


def _bill_pdf(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((50, 80), text)
    data = doc.write()
    doc.close()
    return data


def test_full_demo_flow(api):
    # ---- Workspace with the production quantity missing -> Incomplete --------------------
    data = benchmark_inputs()
    data["production"]["target"] = {"value": None}
    data["fuels"][0]["ncv"] = {"value": None}
    data["electricity"]["grid_ef"] = {"value": None}
    r = api.put(f"{V1}/workspaces/{WS}", json={
        "company_name": "Apex Fasteners", "installation_name": "Unit 1", "cn_code": "7318 15 82",
        "reporting_start": "2026-01-01", "reporting_end": "2026-12-31", "inputs": data, "actor": "Harish"})
    assert r.status_code == 200
    state = r.json()
    assert state["calc_status"] == "Incomplete"
    gaps = {g["input_key"]: g for g in state["gaps"]}
    assert gaps["production.target_quantity"]["fallback_available"] is False
    assert gaps["electricity.grid_ef"]["fallback_available"] is True

    r = api.post(f"{V1}/workspaces/{WS}/calculate", json={})
    assert r.status_code == 422
    assert "production.target_quantity" in [g["input_key"] for g in r.json()["gaps"]]

    pdf = api.get(f"{V1}/passports/{WS}/pdf")
    assert pdf.status_code == 200
    text = _pdf_text(pdf.content)
    assert "INCOMPLETE – NOT FOR SUBMISSION" in text
    assert "tCO2e/t" not in text  # no SEE value printed

    # ---- Fill the production gap: status updates on the next call ------------------------
    data["production"]["target"] = {"value": 500.0, "unit": "t"}
    state = api.put(f"{V1}/workspaces/{WS}/inputs", params={"actor": "Harish"}, json=data).json()
    assert state["calc_status"] == "Ready" and state["pending_fallbacks"] == 2

    # ---- Apply the fallbacks explicitly --------------------------------------------------
    r = api.post(f"{V1}/workspaces/{WS}/gaps/electricity.grid_ef/apply-fallback", json={"reason": "", "actor": "H"})
    assert r.status_code == 422  # reason required
    for key in ("electricity.grid_ef", "fuel.furnace_oil.ncv"):
        r = api.post(f"{V1}/workspaces/{WS}/gaps/{key}/apply-fallback",
                     json={"reason": "No measured value available for 2026", "actor": "Harish"})
        assert r.status_code == 200, r.text
    assumptions = api.get(f"{V1}/workspaces/{WS}/assumptions").json()
    assert {a["input_key"] for a in assumptions} == {"electricity.grid_ef", "fuel.furnace_oil.ncv"}

    calc = api.post(f"{V1}/workspaces/{WS}/calculate", json={"seed": 42}).json()
    assert abs(calc["result"]["see_tco2_per_t"] - 2.28507552) < 1e-9
    assert calc["result"]["data_quality_label"] == "B"
    assert calc["mc_seed"] == 42
    assert api.get(f"{V1}/workspaces/{WS}/result").json()["mc_seed"] == 42

    # ---- Upload a bill, duplicate rejected, metadata, validation, approval --------------
    bill = _bill_pdf("DHBVN Bill No: EB-1001\nBilling Period: 01/10/2026 to 31/10/2026\n"
                     "Active Energy Consumption: 250,000 kWh")
    r = api.post(f"{V1}/documents/upload", files={"file": ("oct.pdf", bill, "application/pdf")},
                 data={"workspace_id": WS})
    assert r.status_code == 201
    doc_hash = r.json()["document_hash"]
    dup = api.post(f"{V1}/documents/upload", files={"file": ("oct-copy.pdf", bill, "application/pdf")},
                   data={"workspace_id": WS})
    assert dup.status_code == 409
    assert dup.json()["existing_document"]["url"].endswith(doc_hash)
    assert api.get(f"{V1}/documents/{doc_hash}").json()["filename"] == "oct.pdf"

    docs = api.get(f"{V1}/documents/workspace/{WS}").json()
    assert docs[0]["bill_number"] == "EB-1001" and docs[0]["period_start"] == "2026-10-01"

    bill2 = _bill_pdf("Active Energy Consumption: 240,000 kWh")
    r = api.post(f"{V1}/documents/upload", files={"file": ("nov.pdf", bill2, "application/pdf")},
                 data={"workspace_id": WS})
    hash2 = r.json()["document_hash"]
    r = api.patch(f"{V1}/documents/{hash2}/metadata", json={
        "period_start": "2026-10-31", "period_end": "2026-11-30", "utility_type": "electricity",
        "actor": "Harish", "reason": "From the printed bill"})
    assert r.status_code == 200
    findings = api.post(f"{V1}/workspaces/{WS}/validate").json()
    overlap = [f for f in findings if f["rule_id"] == "V2_OVERLAP" and f["severity"] == "error"]
    assert len(overlap) == 1 and overlap[0]["status"] == "open"
    assert api.get(f"{V1}/workspaces/{WS}").json()["open_errors"] == 1

    fields = api.get(f"{V1}/documents/{hash2}/fields").json()
    r = api.post(f"{V1}/documents/fields/{fields[0]['id']}/approve", json={"actor": "Harish"})
    assert r.status_code == 409  # blocked while the overlap error is open

    assert api.post(f"{V1}/findings/{overlap[0]['id']}/waive", json={"reason": "", "actor": "H"}).status_code == 422
    r = api.post(f"{V1}/findings/{overlap[0]['id']}/waive",
                 json={"reason": "Utility re-billed 31 Oct; quantity pro-rated in override", "actor": "Harish"})
    assert r.json()["status"] == "waived"
    audit = api.get(f"{V1}/workspaces/{WS}/audit", params={"entity_type": "finding"}).json()
    assert any(a["action"] == "waived" and a["actor"] == "Harish" for a in audit)

    for h in (doc_hash, hash2):
        for field in api.get(f"{V1}/documents/{h}/fields").json():
            r = api.post(f"{V1}/documents/fields/{field['id']}/approve", json={"actor": "Harish"})
            assert r.status_code == 200 and r.json()["reviewed"] is True

    # ---- Status workflow ------------------------------------------------------------------
    api.post(f"{V1}/workspaces/{WS}/calculate", json={})
    r = api.post(f"{V1}/passports/{WS}/transition",
                 json={"to": "Externally Verified", "actor": "H", "role": "verifier"})
    assert r.status_code == 409
    r = api.post(f"{V1}/passports/{WS}/transition", json={"to": "User-Confirmed", "actor": "Harish", "role": "exporter"})
    assert r.status_code == 409 and "declaration" in str(r.json()["detail"]["problems"])
    r = api.post(f"{V1}/passports/{WS}/transition", json={
        "to": "User-Confirmed", "actor": "Harish", "role": "exporter", "note": "Checked",
        "extra_fields": {"declaration": True}})
    assert r.status_code == 200, r.text
    confirmed_version = r.json()["version_number"]
    passport = api.get(f"{V1}/passports/{WS}").json()
    assert passport["status"] == "User-Confirmed" and passport["allowed_next"] == ["Expert-Reviewed"]

    pdf_text = _pdf_text(api.get(f"{V1}/passports/{WS}/pdf").content)
    assert "USER-CONFIRMED" in pdf_text and f"Passport v{confirmed_version}" in pdf_text
    assert "Assumptions" in pdf_text and "Emission factors used" in pdf_text
    assert "Status history" in pdf_text and "electricity.grid_ef" in pdf_text

    # ---- Editing an override after confirmation resets to Draft --------------------------
    r = api.post(f"{V1}/documents/override", json={
        "document_hash": hash2, "field_name": "electricity_quantity", "override_value": 230000,
        "override_unit": "kWh", "override_reason": "Pro-rated to exclude 31 Oct", "user_id": "Harish"})
    assert r.status_code == 200
    passport = api.get(f"{V1}/passports/{WS}").json()
    assert passport["status"] == "Draft" and passport["version_number"] == confirmed_version + 1
    history = api.get(f"{V1}/passports/{WS}/history").json()
    assert history[-1]["from"] == "User-Confirmed" and history[-1]["to"] == "Draft"

    # The confirmed snapshot can still be re-run to the same SEE.
    rerun = api.post(f"{V1}/passports/{WS}/versions/{confirmed_version}/rerun").json()
    assert rerun["matches_stored"] is True
    versions = api.get(f"{V1}/passports/{WS}/versions").json()
    assert versions[confirmed_version - 1]["status"] == "User-Confirmed"

    # ---- Exclude a document; draft PDF wording ------------------------------------------
    r = api.post(f"{V1}/documents/{hash2}/exclude", json={"actor": "Harish", "reason": "Wrong meter"})
    assert r.json()["is_excluded"] is True
    r = api.post(f"{V1}/documents/{hash2}/include", json={"actor": "Harish"})
    assert r.json()["is_excluded"] is False
    text = _pdf_text(api.get(f"{V1}/passports/{WS}/pdf").content)
    assert "Not reviewed. Not for submission." in text


def test_full_workflow_to_externally_verified_pdf(api):
    api.put(f"{V1}/workspaces/WS-2", json={"company_name": "Apex", "inputs": benchmark_inputs()})
    api.post(f"{V1}/workspaces/WS-2/calculate", json={})
    steps = [
        {"to": "User-Confirmed", "actor": "Harish", "role": "exporter", "extra_fields": {"declaration": True}},
        {"to": "Expert-Reviewed", "actor": "Dr. Rao", "role": "reviewer", "note": "Reviewed",
         "extra_fields": {"reviewer_name": "Dr. Rao", "organisation": "Advisory LLP"}},
        {"to": "Externally Verified", "actor": "Harish", "role": "verifier", "note": "Statement held",
         "extra_fields": {"verifier_body": "Verifier GmbH", "accreditation_ref": "D-VS-1",
                          "statement_ref": "ST-9", "date": "2026-11-20"}},
    ]
    for step in steps:
        assert api.post(f"{V1}/passports/WS-2/transition", json=step).status_code == 200
    text = _pdf_text(api.get(f"{V1}/passports/WS-2/pdf").content)
    assert "EXTERNALLY VERIFIED" in text
    assert "Verifier GmbH" in text
    assert "Recorded by the user; not verified by this tool." in text
    assert "No register factors used" in text  # fully measured benchmark


def test_registry_api_is_append_only(api):
    sets = api.get(f"{V1}/registry/factor-sets").json()
    assert sets[0]["version"] == "2026.1" and sets[0]["factor_count"] == 13
    factors = api.get(f"{V1}/registry/factors").json()
    assert all(f["source_url"] and f["year"] for f in factors)
    assert api.patch(f"{V1}/registry/factors/{factors[0]['id']}", json={"value": 1}).status_code == 409
    new = {"version": "2026.2", "factors": [{
        "key": "electricity.grid_ef", "value": 0.727, "unit": "tCO2/MWh", "source_title": "CEA v20 Annexure-I",
        "publisher": "Central Electricity Authority", "source_url": "https://cea.nic.in/", "year": 2024}]}
    assert api.post(f"{V1}/registry/factor-sets", json=new).status_code == 201
    assert api.post(f"{V1}/registry/factor-sets", json=new).status_code == 409
    grid = [f for f in api.get(f"{V1}/registry/factors", params={"version": "2026.1"}).json()
            if f["key"] == "electricity.grid_ef"][0]
    assert grid["value"] == 0.716 and grid["status"] == "superseded"

    api.put(f"{V1}/workspaces/WS-3", json={"inputs": benchmark_inputs()})
    r = api.post(f"{V1}/workspaces/WS-3/factor-set", json={"version": "2026.2", "actor": "Harish"})
    assert r.json()["factor_set_version"] == "2026.2"
    assert api.post(f"{V1}/workspaces/WS-3/factor-set", json={"version": "1999.1", "actor": "H"}).status_code == 404


def test_not_found_paths(api):
    assert api.get(f"{V1}/workspaces/missing").status_code == 404
    assert api.get(f"{V1}/workspaces/missing/gaps").status_code == 404
    assert api.get(f"{V1}/passports/missing").status_code == 404
    assert api.post(f"{V1}/findings/999/waive", json={"reason": "r", "actor": "a"}).status_code == 404
    assert api.post(f"{V1}/documents/fields/999/approve", json={"actor": "a"}).status_code == 404
    assert api.get(f"{V1}/documents/nohash").status_code == 404


def test_insights_api(api):
    W = "WS-INS"
    data = benchmark_inputs()
    data["electricity"]["grid_ef"] = {"value": None}
    api.put(f"{V1}/workspaces/{W}", json={"inputs": data})
    r = api.get(f"{V1}/workspaces/{W}/insights")
    assert r.status_code == 422 and r.json()["gaps"][0]["input_key"] == "electricity.grid_ef"
    assert api.post(f"{V1}/workspaces/{W}/scenario", json={}).status_code == 422
    assert api.post(f"{V1}/workspaces/{W}/cost-estimate", json={"shipment_tonnes": 1}).status_code == 422
    api.post(f"{V1}/workspaces/{W}/gaps/electricity.grid_ef/apply-fallback",
             json={"reason": "No supplier factor", "actor": "Harish"})

    body = api.get(f"{V1}/workspaces/{W}/insights").json()
    assert abs(body["baseline"]["see_tco2_per_t"] - 2.28507552) < 1e-9
    assert body["baseline"]["data_quality_label"] == "B"
    assert body["breakdown"]["items"][0]["category"] == "precursor"
    assert [t["rank"] for t in body["tips"]][:2] == [1, 2]
    assert body["sensitivity"]["bars"][0]["swing"] >= body["sensitivity"]["bars"][-1]["swing"]

    s = api.post(f"{V1}/workspaces/{W}/scenario", json={"name": "PPA", "ppa_share_pct": 100}).json()
    assert abs(s["tco2_saving"] - 143.2) < 1e-9
    assert s["scenario"]["band"]["p95"] - s["scenario"]["band"]["p5"] < s["baseline"]["band"]["p95"] - s["baseline"]["band"]["p5"]
    assert api.post(f"{V1}/workspaces/{W}/scenario", json={"fuel_switch_to": "furnace_oil"}).status_code == 400

    c = api.post(f"{V1}/workspaces/{W}/cost-estimate", json={"shipment_tonnes": 25}).json()
    assert c["label"] == "ESTIMATE" and c["inputs"]["certificate_price_eur"] == 82.32
    assert abs(c["central"]["cost_eur"] - 2.28507552 * 25 * 82.32) < 1e-6
    after = api.post(f"{V1}/workspaces/{W}/cost-estimate",
                     json={"shipment_tonnes": 25, "scenario": {"name": "PPA", "ppa_share_pct": 100}}).json()
    assert after["scenario"] == "PPA" and after["central"]["cost_eur"] < c["central"]["cost_eur"]
    assert api.get(f"{V1}/insights/cost-parameters").json()["cbam_factor"]["2026"] == 0.975
    assert api.get(f"{V1}/workspaces/missing/insights").status_code == 404
