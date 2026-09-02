import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BILLING_SHEET_LOCATION_GATE_EFFECTIVE_AT,
  WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  checkLocationGate,
  clearLocationFieldsForRule,
  deriveLocationConfidence,
  isLocationGateEnforced,
  resolveLocationFieldVisibility,
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

  it("never requires a zone without its controller", () => {
    // A zone is only ever chosen underneath a controller, so the inverse
    // combination is not expressible in the field UI. The admin PATCH route
    // refuses it; these defaults must not smuggle it in.
    for (const rule of FIELD_WORK_TYPE_SEEDS) {
      if (rule.requiresZone) assert.equal(rule.requiresController, true, rule.code);
    }
  });

  it("shows exactly the fields each seeded rule actually uses", () => {
    const shape = FIELD_WORK_TYPE_SEEDS.map((rule) => {
      const v = resolveLocationFieldVisibility(rule);
      return [rule.code, v.showController, v.showZone, v.showControllerZoneGroup];
    });
    assert.deepEqual(shape, [
      ["zone_repair", true, true, true],
      ["head_replacement", true, true, true],
      ["valve_repair", true, true, true],
      ["controller_repair", true, false, true],
      ["backflow", false, false, false],
      ["mainline_repair", false, false, false],
      ["other", false, false, false],
    ]);
  });

  it("never hides a field the gate would still demand", () => {
    // The presentation layer and the validator read the same rule, so a
    // required-but-invisible field would be an unfixable block.
    for (const rule of FIELD_WORK_TYPE_SEEDS) {
      const v = resolveLocationFieldVisibility(rule);
      const violations = checkLocationGate({ ...emptyInput, fieldWorkType: rule.code }, rule);
      if (violations.includes("controller_missing")) assert.equal(v.showController, true);
      if (violations.includes("zone_missing")) assert.equal(v.showZone, true);
      assert.equal(v.controllerRequired, violations.includes("controller_missing"));
      assert.equal(v.zoneRequired, violations.includes("zone_missing"));
    }
  });

  it("keeps a stored value visible even when its rule does not use it", () => {
    // Legacy tickets predate the registry; hiding stored data would make it
    // uneditable and invisible rather than merely optional.
    const backflow = FIELD_WORK_TYPE_SEEDS.find((r) => r.code === "backflow")!;
    const v = resolveLocationFieldVisibility(backflow, { hasController: true, hasZone: true });
    assert.equal(v.showController, true);
    assert.equal(v.showZone, true);
    assert.equal(v.controllerRequired, false);
    assert.equal(v.zoneRequired, false);

    const orphan = resolveLocationFieldVisibility(null, { hasController: true });
    assert.equal(orphan.showControllerZoneGroup, true);
  });

  it("hides everything until a work type is chosen", () => {
    const v = resolveLocationFieldVisibility(null);
    assert.deepEqual(v, {
      showControllerZoneGroup: false,
      showController: false,
      showZone: false,
      controllerRequired: false,
      zoneRequired: false,
    });
  });

  it("drops only the values the newly chosen rule stops using", () => {
    const current = { controllerLetter: "A", zoneNumber: 3 };
    const byCode = (code: string) => FIELD_WORK_TYPE_SEEDS.find((r) => r.code === code)!;

    assert.deepEqual(clearLocationFieldsForRule(byCode("head_replacement"), current), {
      controllerLetter: "A",
      zoneNumber: 3,
    });
    assert.deepEqual(clearLocationFieldsForRule(byCode("controller_repair"), current), {
      controllerLetter: "A",
      zoneNumber: null,
    });
    assert.deepEqual(clearLocationFieldsForRule(byCode("backflow"), current), {
      controllerLetter: null,
      zoneNumber: null,
    });
    assert.deepEqual(clearLocationFieldsForRule(null, current), {
      controllerLetter: null,
      zoneNumber: null,
    });
  });

  it("leaves nothing behind that the new rule would then reject", () => {
    // Clearing must be sufficient on its own: whatever survives the switch
    // has to satisfy the gate for the rule that caused the switch.
    for (const rule of FIELD_WORK_TYPE_SEEDS) {
      const cleared = clearLocationFieldsForRule(rule, { controllerLetter: "A", zoneNumber: 3 });
      const violations = checkLocationGate(
        {
          ...emptyInput,
          workLocationLat: 39.7,
          workLocationLng: -104.9,
          fieldWorkType: rule.code,
          fieldWorkTypeDetails: rule.requiresDetails ? "notes" : null,
          ...cleared,
        },
        rule,
      );
      assert.deepEqual(violations, [], `${rule.code} should be satisfiable after clearing`);
    }
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