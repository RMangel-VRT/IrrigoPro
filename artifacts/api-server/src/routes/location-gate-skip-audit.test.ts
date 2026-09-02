import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOCATION_GATE_SKIPPED_EMPTY_REGISTRY_ACTION,
  recordLocationGateSkip,
} from "./location-gate-skip-audit";

function fakeRequest() {
  return {
    authenticatedUserId: 42,
    authenticatedUserRole: "field_tech",
    authenticatedUserCompanyId: 7,
  } as any;
}

describe("location gate skip audit", () => {
  it("records exactly one event carrying the company id and the surface", async () => {
    const written: any[] = [];
    await recordLocationGateSkip(
      fakeRequest(),
      {
        companyId: 7,
        surface: "billing_sheet_create",
        targetType: "billing_sheet",
      },
      async (_req, evt) => {
        written.push(evt);
      },
    );

    assert.equal(written.length, 1);
    const [evt] = written;
    assert.equal(evt.action, "location_gate.skipped_empty_registry");
    assert.equal(evt.action, LOCATION_GATE_SKIPPED_EMPTY_REGISTRY_ACTION);
    assert.equal(evt.actorCompanyId, 7);
    assert.equal((evt.details as any).companyId, 7);
    assert.equal((evt.details as any).surface, "billing_sheet_create");
    assert.equal(evt.targetType, "billing_sheet");
    // Visible to Super Admin as something to act on, not routine noise.
    assert.equal(evt.severity, "warning");
  });

  it("never lets an audit failure block the save it was granted for", async () => {
    await recordLocationGateSkip(
      fakeRequest(),
      { companyId: 7, surface: "work_order_complete" },
      async () => {
        throw new Error("audit table unavailable");
      },
    );
  });
});
