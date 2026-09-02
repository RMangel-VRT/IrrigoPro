import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
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

});