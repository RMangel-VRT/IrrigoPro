const BILLING_EDIT_ROLES = new Set(["billing_manager", "company_admin", "super_admin"]);

interface WetCheckBillingEditState {
  invoiceId?: number | null;
  status?: string | null;
}

/**
 * The single client-side permission predicate for editable WC Snapshot fields.
 * Keep this in lockstep with the server's billing-manager allowlist and locks.
 */
export function canEditWetCheckBillingFields(
  role: string | null | undefined,
  wcb: WetCheckBillingEditState,
): boolean {
  return BILLING_EDIT_ROLES.has(role ?? "") &&
    wcb.invoiceId !== undefined &&
    wcb.invoiceId === null &&
    !!wcb.status &&
    wcb.status !== "billed";
}
