import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  getBillingLocationViolations,
  resolveBillingLocationCreateGate,
  resolveBillingLocationPatchGate,
} from "./billing-sheet-location-gate";

// Every role that can reach a billing sheet. The gate takes no role at all,
// so each of these must land on the identical decision — a manager on site
// produces exactly the record the gate exists to prevent.
const ROLES = [
  "field_tech",
  "irrigation_manager",
  "company_admin",
  "billing_manager",
] as const;

const POST_CUTOFF = new Date("2026-09-03T00:00:00.000Z");
const PRE_CUTOFF = "2026-09-01T23:59:59.999Z";
const SEEDED_REGISTRY = 7;
const EMPTY_REGISTRY = 0;

// What each call site does with the caller's role: nothing. Modelled here so
// the role table below exercises the real shape of the server decision.
function createDecisionFor(_role: string, activeWorkTypeCount: number) {
  return resolveBillingLocationCreateGate(POST_CUTOFF, activeWorkTypeCount);
}
function patchDecisionFor(
  _role: string,
  createdAt: string,
  patch: Record<string, unknown>,
  activeWorkTypeCount: number,
) {
  return resolveBillingLocationPatchGate(createdAt, patch, activeWorkTypeCount);
}

describe("billing sheet location gate — role scope", () => {
  it("enforces a post-cutoff create identically for every role", () => {
    for (const role of ROLES) {
      assert.deepEqual(
        createDecisionFor(role, SEEDED_REGISTRY),
        { enforced: true, skippedEmptyRegistry: false },
        role,
      );
    }
  });

  it("gives every role the same rejection on a post-cutoff sheet", () => {
    const bare = {
      workLocationLat: null,
      workLocationLng: null,
      fieldWorkType: null,
      fieldWorkTypeDetails: null,
      controllerLetter: null,
      zoneNumber: null,
    };
    for (const role of ROLES) {
      assert.equal(createDecisionFor(role, SEEDED_REGISTRY).enforced, true, role);
      assert.deepEqual(
        getBillingLocationViolations(bare, null),
        ["pin_missing", "work_type_missing"],
        role,
      );
    }
  });

  it("grandfathers a pre-cutoff sheet for every role", () => {
    for (const role of ROLES) {
      assert.deepEqual(
        patchDecisionFor(role, PRE_CUTOFF, { fieldWorkType: "zone_repair" }, SEEDED_REGISTRY),
        { enforced: false, skippedEmptyRegistry: false },
        role,
      );
    }
  });

  it("lets a labor-hours-only patch through for every role", () => {
    // The billing workspace and Command Center edit hours inline on sheets
    // that predate the location capture; that must never trip the gate.
    for (const role of ROLES) {
      assert.equal(
        patchDecisionFor(role, "2026-09-03T00:00:00.000Z", { totalHours: "3.5" }, SEEDED_REGISTRY)
          .enforced,
        false,
        role,
      );
      assert.equal(
        patchDecisionFor(role, "2026-09-03T00:00:00.000Z", { managerBillingNotes: "Call" }, SEEDED_REGISTRY)
          .enforced,
        false,
        role,
      );
    }
  });

  it("still catches a location-relevant patch and a status transition", () => {
    assert.equal(
      resolveBillingLocationPatchGate(
        "2026-09-03T00:00:00.000Z",
        { controllerLetter: "A" },
        SEEDED_REGISTRY,
      ).enforced,
      true,
    );
    // Out of scope to loosen: patching only a status must not walk past the gate.
    for (const status of ["submitted", "pending_manager_review", "completed"]) {
      assert.equal(
        resolveBillingLocationPatchGate(
          "2026-09-03T00:00:00.000Z",
          { status },
          SEEDED_REGISTRY,
        ).enforced,
        true,
        status,
      );
    }
  });

  it("keeps the role condition out of the module for good", () => {
    // The shipped bug was `role === "field_tech" && …`. A parameter that
    // always passes invites the condition creeping back in a later edit, so
    // the module must carry no role literal at all.
    const source = readFileSync(new URL("./billing-sheet-location-gate.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/field_tech|authenticatedUserRole/.test(code), false);
  });
});

describe("billing sheet location gate — empty work type registry", () => {
  it("fails open, and says so, when the tenant has no active work types", () => {
    assert.deepEqual(resolveBillingLocationCreateGate(POST_CUTOFF, EMPTY_REGISTRY), {
      enforced: false,
      skippedEmptyRegistry: true,
    });
    assert.deepEqual(
      resolveBillingLocationPatchGate(
        "2026-09-03T00:00:00.000Z",
        { controllerLetter: "A" },
        EMPTY_REGISTRY,
      ),
      { enforced: false, skippedEmptyRegistry: true },
    );
  });

  it("enforces normally as soon as the tenant has one active type", () => {
    assert.deepEqual(resolveBillingLocationCreateGate(POST_CUTOFF, 1), {
      enforced: true,
      skippedEmptyRegistry: false,
    });
  });

  it("returns the tenant to the unblocked path when its last type is deactivated", () => {
    const before = resolveBillingLocationCreateGate(POST_CUTOFF, 1);
    const after = resolveBillingLocationCreateGate(POST_CUTOFF, 0);
    assert.equal(before.enforced, true);
    assert.deepEqual(after, { enforced: false, skippedEmptyRegistry: true });
  });

  it("never reports a skip for a grandfathered sheet", () => {
    // Nothing was skipped there: the cutoff already answered the question, and
    // auditing it would drown the real signal.
    assert.deepEqual(
      resolveBillingLocationPatchGate(PRE_CUTOFF, { controllerLetter: "A" }, EMPTY_REGISTRY),
      { enforced: false, skippedEmptyRegistry: false },
    );
  });

  it("keeps the gate on when the count could not be resolved", () => {
    assert.equal(resolveBillingLocationCreateGate(POST_CUTOFF).enforced, true);
    assert.equal(resolveBillingLocationCreateGate(POST_CUTOFF, null).enforced, true);
  });
});

describe("billing sheet location violations", () => {
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
