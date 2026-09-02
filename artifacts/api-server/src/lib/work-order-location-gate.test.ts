import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
  resolveWorkOrderLocationGate,
  workOrderLocationGateError,
} from "./work-order-location-gate";

const completePin = {
  workLocationLat: "39.7392",
  workLocationLng: "-104.9903",
};
const mainlineRule = {
  code: "mainline_repair",
  requiresController: false,
  requiresZone: false,
  requiresDetails: false,
};

describe("work-order location cutoff", () => {
  it("keeps online enforcement ready but intentionally inactive until offline completion ships", () => {
    assert.equal(
      WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT.toISOString(),
      "2099-01-01T00:00:00.000Z",
      "Do not activate the work-order cutoff in the online-only task; signal-less offline technicians must remain able to complete work.",
    );
  });

  it("grandfathers work orders created before the effective timestamp", () => {
    assert.equal(
      workOrderLocationGateError({
        createdAt: new Date(WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT.getTime() - 1),
      }),
      null,
    );
  });

  it("requires coordinates, but not an address, at the cutoff", () => {
    assert.equal(
      workOrderLocationGateError({
        createdAt: WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
        ...completePin,
        fieldWorkType: "mainline_repair",
      }, mainlineRule),
      null,
    );
    assert.equal(
      workOrderLocationGateError({
        createdAt: WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
        workLocationLat: null,
        workLocationLng: null,
        fieldWorkType: "mainline_repair",
      }, mainlineRule),
      "Complete every required work location field before completing this work order.",
    );
  });

  it("returns every conditional requirement for a post-cutoff work order", async () => {
    const { getWorkOrderLocationViolations } =
      await import("./work-order-location-gate");
    assert.deepEqual(
      getWorkOrderLocationViolations(
        {
          createdAt: WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
          ...completePin,
          fieldWorkType: "zone_repair",
          controllerLetter: null,
          zoneNumber: null,
        },
        {
          code: "zone_repair",
          requiresController: true,
          requiresZone: true,
          requiresDetails: false,
        },
      ),
      ["controller_missing", "zone_missing"],
    );
  });

  it("fails open for a tenant with no active work types, and reports the skip", () => {
    // Work Type is required by the gate and nothing in the product lets a
    // company add one, so an empty registry is an outage, not enforcement.
    // Resolved through the shared policy so both surfaces cannot drift.
    const postCutoff = {
      createdAt: WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
      workLocationLat: null,
      workLocationLng: null,
      fieldWorkType: null,
    };
    assert.deepEqual(resolveWorkOrderLocationGate(postCutoff, 0), {
      enforced: false,
      skippedEmptyRegistry: true,
    });
    assert.equal(workOrderLocationGateError(postCutoff, null, 0), null);

    assert.deepEqual(resolveWorkOrderLocationGate(postCutoff, 1), {
      enforced: true,
      skippedEmptyRegistry: false,
    });
    assert.equal(
      workOrderLocationGateError(postCutoff, null, 1),
      "Complete every required work location field before completing this work order.",
    );
  });

  it("never reports a skip for a grandfathered work order, and keeps the gate on when the count is unknown", () => {
    const grandfathered = {
      createdAt: new Date(WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT.getTime() - 1),
    };
    assert.deepEqual(resolveWorkOrderLocationGate(grandfathered, 0), {
      enforced: false,
      skippedEmptyRegistry: false,
    });
    assert.equal(
      resolveWorkOrderLocationGate({
        createdAt: WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
      }).enforced,
      true,
    );
  });
});