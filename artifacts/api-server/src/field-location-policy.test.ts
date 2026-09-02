import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
  WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  checkLocationGate,
  deriveLocationConfidence,
  isLocationGateEnforced,
} from "@workspace/db";
import { FIELD_WORK_TYPE_SEEDS } from "./seeds/field-work-types";

const emptyInput = {
  workLocationLat: null,
  workLocationLng: null,
  fieldWorkType: null,
  fieldWorkTypeDetails: null,
  controllerLetter: null,
  zoneNumber: null,
};

describe("field location policy", () => {
  it("covers all seven defaults with the required matrix", () => {
    assert.deepEqual(
      FIELD_WORK_TYPE_SEEDS.map((row) => ({
        code: row.code,
        controller: row.requiresController,
        zone: row.requiresZone,
        details: row.requiresDetails,
      })),
      [
        { code: "zone_repair", controller: true, zone: true, details: false },
        { code: "head_replacement", controller: true, zone: true, details: false },
        { code: "valve_repair", controller: true, zone: true, details: false },
        { code: "controller_repair", controller: true, zone: false, details: false },
        { code: "backflow", controller: false, zone: false, details: false },
        { code: "mainline_repair", controller: false, zone: false, details: false },
        { code: "other", controller: false, zone: false, details: true },
      ],
    );

    for (const rule of FIELD_WORK_TYPE_SEEDS) {
      const violations = checkLocationGate(
        { ...emptyInput, fieldWorkType: rule.code },
        rule,
      );
      const expected = ["pin_missing"];
      if (rule.requiresController) expected.push("controller_missing");
      if (rule.requiresZone) expected.push("zone_missing");
      if (rule.requiresDetails) expected.push("details_missing");
      assert.deepEqual(violations, expected, rule.code);
    }
  });

  it("accepts finite decimal strings and returns every missing requirement in stable order", () => {
    const zoneRepair = FIELD_WORK_TYPE_SEEDS.find((row) => row.code === "zone_repair")!;
    assert.deepEqual(
      checkLocationGate({
        workLocationLat: "39.7392364",
        workLocationLng: "-104.9902508",
        fieldWorkType: "zone_repair",
        fieldWorkTypeDetails: null,
        controllerLetter: null,
        zoneNumber: null,
      }, zoneRepair),
      ["controller_missing", "zone_missing"],
    );
  });

  it("rejects malformed and partial coordinate pairs", () => {
    const mainline = FIELD_WORK_TYPE_SEEDS.find((row) => row.code === "mainline_repair")!;
    for (const pair of [
      [39.7, null],
      [null, -104.9],
      ["", "-104.9"],
      ["NaN", "-104.9"],
      [Number.POSITIVE_INFINITY, -104.9],
    ] as const) {
      assert.deepEqual(
        checkLocationGate({
          ...emptyInput,
          fieldWorkType: "mainline_repair",
          workLocationLat: pair[0],
          workLocationLng: pair[1],
        }, mainline),
        ["pin_missing"],
      );
    }
  });

  it("fails closed for a missing or unknown work type", () => {
    assert.deepEqual(checkLocationGate(emptyInput, null), [
      "pin_missing",
      "work_type_missing",
    ]);
    assert.deepEqual(checkLocationGate({
      ...emptyInput,
      workLocationLat: 39.7,
      workLocationLng: -104.9,
      fieldWorkType: "foreign_type",
    }, null), ["work_type_missing"]);
  });

  it("requires nonblank details only when the rule says so", () => {
    const other = FIELD_WORK_TYPE_SEEDS.find((row) => row.code === "other")!;
    const input = {
      ...emptyInput,
      workLocationLat: 39.7,
      workLocationLng: -104.9,
      fieldWorkType: "other",
    };
    assert.deepEqual(checkLocationGate({ ...input, fieldWorkTypeDetails: "  " }, other), [
      "details_missing",
    ]);
    assert.deepEqual(checkLocationGate({ ...input, fieldWorkTypeDetails: "Custom repair" }, other), []);
  });

  it("derives pin confidence from provenance without a stored shadow value", () => {
    assert.equal(
      deriveLocationConfidence({ workLocationSource: "manual", workLocationGpsError: "denied" }),
      "low",
    );
    assert.equal(
      deriveLocationConfidence({ workLocationSource: "manual", workLocationGpsError: null }),
      "high",
    );
    assert.equal(
      deriveLocationConfidence({ workLocationSource: "gps", workLocationGpsError: null }),
      "high",
    );
    assert.equal(
      deriveLocationConfidence({ workLocationSource: null, workLocationGpsError: null }),
      "unknown",
    );
  });

  it("ships only billing enabled and evaluates an explicit cutoff independently", () => {
    const now = new Date();
    assert.equal(isLocationGateEnforced(now, BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT), true);
    assert.equal(isLocationGateEnforced(now, WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT), false);
    const cutoff = new Date("2026-09-01T12:00:00.000Z");
    assert.equal(isLocationGateEnforced("2026-09-01T11:59:59.999Z", cutoff), false);
    assert.equal(isLocationGateEnforced("2026-09-01T12:00:00.000Z", cutoff), true);
    assert.equal(isLocationGateEnforced(null, cutoff), false);
    assert.equal(isLocationGateEnforced("not-a-date", cutoff), false);
  });
});