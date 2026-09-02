import { describe, expect, it } from "vitest";
import { canEditWetCheckBillingFields } from "./wet-check-billing-permissions";

const unlocked = { status: "approved_passed_to_billing", invoiceId: null };

describe("canEditWetCheckBillingFields", () => {
  it.each(["billing_manager", "company_admin", "super_admin"])(
    "allows %s on an unlocked snapshot",
    (role) => expect(canEditWetCheckBillingFields(role, unlocked as any)).toBe(true),
  );

  it.each(["field_tech", "irrigation_manager", null, undefined])(
    "rejects %s",
    (role) => expect(canEditWetCheckBillingFields(role, unlocked as any)).toBe(false),
  );

  it("rejects billed and invoiced snapshots", () => {
    expect(canEditWetCheckBillingFields("billing_manager", { status: "billed", invoiceId: null } as any)).toBe(false);
    expect(canEditWetCheckBillingFields("billing_manager", { status: "approved_passed_to_billing", invoiceId: 8 } as any)).toBe(false);
  });

  it("fails closed when completed-work lock metadata is absent", () => {
    expect(canEditWetCheckBillingFields("billing_manager", {})).toBe(false);
    expect(canEditWetCheckBillingFields("billing_manager", {
      status: "approved_passed_to_billing",
    })).toBe(false);
  });
});
