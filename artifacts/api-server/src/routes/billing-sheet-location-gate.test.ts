import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getBillingLocationViolations,
  shouldEnforceBillingLocationCreate,
  shouldEnforceBillingLocationPatch,
} from "./billing-sheet-location-gate";

describe("billing sheet location gate", () => {
  it("enforces post-cutoff field creates but keeps office creates permissive", () => {
    const postCutoff = new Date("2026-09-03T00:00:00.000Z");
    assert.equal(shouldEnforceBillingLocationCreate("field_tech", postCutoff), true);
    assert.equal(shouldEnforceBillingLocationCreate("company_admin", postCutoff), false);
  });

  it("grandfathers old sheets and ignores unrelated partial patches", () => {
    assert.equal(
      shouldEnforceBillingLocationPatch("field_tech", "2026-09-01T23:59:59.999Z", {
        fieldWorkType: "inspection",
      }),
      false,
    );
    assert.equal(
      shouldEnforceBillingLocationPatch("field_tech", "2026-09-03T00:00:00.000Z", {
        managerBillingNotes: "Call customer",
      }),
      false,
    );
    assert.equal(
      shouldEnforceBillingLocationPatch("field_tech", "2026-09-03T00:00:00.000Z", {
        controllerLetter: "A",
      }),
      true,
    );
    assert.equal(
      shouldEnforceBillingLocationPatch("company_admin", "2026-09-03T00:00:00.000Z", {
        controllerLetter: "A",
      }),
      false,
    );
  });

  it("returns every conditional violation and rejects unknown tenant rules", () => {
    const input = {
      workLocationLat: 33,
      workLocationLng: -84,
      fieldWorkType: "zone_repair",
      controllerLetter: null,
      zoneNumber: null,
      fieldWorkTypeDetails: "",
    };
    assert.deepEqual(
      getBillingLocationViolations(input, {
        code: "zone_repair",
        requiresController: true,
        requiresZone: true,
        requiresDetails: true,
      }),
      ["controller_missing", "zone_missing", "details_missing"],
    );
    assert.deepEqual(getBillingLocationViolations(input, null), [
      "work_type_missing",
    ]);
  });
});