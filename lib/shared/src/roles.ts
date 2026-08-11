// ─── Central role registry ──────────────────────────────────────────────────
//
// This is the single place where role membership is declared. Call sites must
// ask what a user *can do* (`hasCapability(role, CAN_READ_INVOICES)`), never
// who they *are* (`role === 'billing_manager'`). Adding a role should be a
// matter of adding it to `ROLES` and to the capability sets it belongs in —
// not of hunting hand-rolled string comparisons across the codebase.

/**
 * Canonical list of every role the product recognises.
 *
 * `users.role` is a plain text column (deliberately — see the ticket's
 * out-of-scope list), so this array, not the database, is the source of
 * truth for what a valid role string is.
 */
export const ROLES = [
  "super_admin",
  "company_admin",
  "billing_manager",
  "irrigation_manager",
  "field_tech",
  "bookkeeper",
] as const;

export type Role = (typeof ROLES)[number];

/** Narrowing guard — true only for a string in `ROLES`. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// ─── Capability sets ────────────────────────────────────────────────────────
//
// Each set is the complete membership for one capability. A role that is not
// listed does not have the capability — these are allowlists, never denylists.

/**
 * Read invoices: the list, a single invoice, its line items, payment status,
 * balance, aging, and the invoice PDF.
 *
 * `irrigation_manager` is in this set **deliberately and by decision**, not by
 * accident. Before the registry existed the invoice list endpoint had no role
 * gate at all, so irrigation managers (and everyone else) could read invoices
 * as a side effect of the missing check. That access is now a stated product
 * decision: a manager needs a customer's invoice history from the customer
 * profile. Do not "clean this up" as an oversight — removing it is a
 * deliberate product change, not a bug fix.
 *
 * `field_tech` is excluded deliberately: a tech has no reason to read
 * invoices, and the pricing-visibility rules already work to keep money out
 * of their view.
 */
export const CAN_READ_INVOICES = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
  "irrigation_manager",
  "bookkeeper",
]);

/**
 * Mutate invoices: create, edit, correct, void, merge, delete, regenerate a
 * PDF, adjust payment state.
 *
 * This is exactly the membership of the former `requireBillingAccess`
 * middleware, unchanged. A bookkeeper is deliberately absent — she reads
 * invoices and chases payment, she does not author them.
 */
export const CAN_EDIT_INVOICES = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
]);

/**
 * Send an invoice to the customer by email, and mark an invoice sent.
 *
 * The bookkeeper is included: delivering the invoice and recording that it
 * went out is the core of the job. It does not change what the invoice says.
 */
export const CAN_SEND_INVOICE_EMAIL = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
  "bookkeeper",
]);

/**
 * Manage the QuickBooks integration: connect, disconnect, read connection
 * status and health, run a manual sync.
 *
 * For the pre-existing roles this is exactly who passed the old denylist
 * (which refused `irrigation_manager` and `field_tech` by name and let
 * everything else through). Those two are still refused — now by absence from
 * an allowlist rather than by being named, so a future role does not gain
 * QuickBooks access by accident.
 *
 * The bookkeeper is included deliberately: she is the person who reconnects
 * the integration when the token expires. That is a bookkeeper's job, not an
 * admin escalation.
 */
export const CAN_MANAGE_QUICKBOOKS = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
  "bookkeeper",
]);

/** Approve or reject an estimate. */
export const CAN_APPROVE_ESTIMATES = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
  "irrigation_manager",
]);

/** Approve a manual/manual-review part. */
export const CAN_APPROVE_PARTS = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
  "irrigation_manager",
]);

/**
 * See budget targets, budget usage, and budget alerts.
 * Mirrors the existing budget-routes allowlist exactly.
 */
export const CAN_VIEW_BUDGETS = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
]);

/**
 * See part costs, margins, labor rates, and Financial Pulse.
 * Mirrors the existing Financial Pulse allowlist exactly.
 */
export const CAN_VIEW_COSTS = new Set<Role>([
  "super_admin",
  "company_admin",
  "billing_manager",
]);

// ─── UI landing defaults ────────────────────────────────────────────────────
//
// Task #1890 — which roles land on a non-default *view* is a presentation
// decision, not an authorization decision. Declaring it as another
// `ReadonlySet<Role>` alongside the capability sets would make the two
// interchangeable at every call site: a UI default handed to `hasCapability`
// compiles cleanly and silently grants access to whoever is in it.
//
// Branding the set is not enough. A branded `ReadonlySet<Role>` is still
// structurally a `ReadonlySet<Role>`, so it still satisfies `Capability` and
// still passes into `hasCapability` with no error. The wrapper below is not a
// Set at all, which is what makes the compiler reject it in both directions —
// a UI default cannot be used as a capability, and a capability cannot be used
// as a UI default — without changing the shape of the existing capability sets.

/** A set of roles that changes what the UI shows first. Never an allowlist. */
export interface UiDefaultRoles {
  readonly kind: "ui-default";
  readonly roles: readonly Role[];
}

/**
 * Roles whose invoice list opens on collections work — unpaid and overdue,
 * biggest balance first within the oldest bucket first — instead of the
 * newest-first billing view.
 *
 * This grants nothing. A bookkeeper can already read invoices because she is
 * in `CAN_READ_INVOICES`; this only decides what she sees before she touches a
 * control. Every other role keeps the newest-first landing.
 */
export const COLLECTIONS_LANDING_DEFAULT: UiDefaultRoles = {
  kind: "ui-default",
  roles: ["bookkeeper"],
};

/**
 * The only way to ask a landing-default question. Mirrors `hasCapability`'s
 * safety: unknown role strings, `null` and `undefined` all return false.
 */
export function usesUiDefault(
  role: string | null | undefined,
  uiDefault: UiDefaultRoles,
): boolean {
  if (!isRole(role)) return false;
  return uiDefault.roles.includes(role);
}

/** A capability is just a role set from this module. */
export type Capability = ReadonlySet<Role>;

/**
 * The only way to ask an authorization question.
 *
 * Safe on bad input by design: an unrecognised role string, `null`, and
 * `undefined` all return `false`. Never throws, never defaults to permissive.
 * This is the property that makes converting a denylist into an allowlist
 * actually hold — under a denylist an unknown or missing role falls through to
 * "allowed", and under this helper it is refused.
 *
 * Do not add a null/undefined special case that returns true. If a caller
 * appears to need one, that caller is relying on an authorization bypass.
 */
export function hasCapability(
  role: string | null | undefined,
  capability: Capability,
): boolean {
  if (!isRole(role)) return false;
  return capability.has(role);
}
