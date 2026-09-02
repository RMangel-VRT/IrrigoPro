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

describe("work-order location cutoff", () => {
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
      }),
      null,
    );
    assert.equal(
      workOrderLocationGateError({
        createdAt: WORK_ORDER_LOCATION_GATE_EFFECTIVE_AT,
        workLocationLat: null,
        workLocationLng: null,
      }),
      "Add the work location pin before completing this work order.",
    );
  });

});