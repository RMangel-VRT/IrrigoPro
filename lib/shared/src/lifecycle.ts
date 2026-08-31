// Slice 10a — Estimates Lifecycle
// Single canonical lifecycle bucket computed server-side from the
// existing (status, internalStatus, estimateDate) tuple. The customer-
// facing `status` enum and the internal review track `internalStatus`
// stay unchanged; this module just maps the two together (plus a 30-day
// expiration window) into one bucket the UI can switch on.

export const LIFECYCLE_STATUSES = [
  "draft",
  "pending_review",
  "sent",
  "approved",
  "rejected",
  "expired",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

// Estimates with `internalStatus = sent_to_customer` and
// `status = pending` flip from `sent` → `expired` once it has been more
// than this many days since the estimate was last sent to the customer
// (`approvalSentAt`). Task #1955 moved the clock off `estimateDate`
// (which defaults to creation time) so an estimate drafted a month ago
// and emailed yesterday isn't already expired in the customer's inbox.
// Rows sent before `approvalSentAt` was reliably recorded fall back to
// `estimateDate` so no historical row silently changes bucket.
// Boundary is inclusive at the lower end: exactly 30 days after the
// send still counts as `sent`.
export const ESTIMATE_EXPIRATION_DAYS = 30;

// Estimate Command Center thresholds. A pending_review estimate older
// than this many days is flagged as stuck. A `sent` estimate at or
// above this $ amount and not responded to within a week is flagged as
// high-value silent. Centralized here so the summary aggregator,
// attention strip, and any future surface read from the same source.
export const ESTIMATE_STUCK_REVIEW_DAYS = 3;
export const ESTIMATE_HIGH_VALUE_USD = 5000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type EstimateLifecycleInput = {
  status?: string | null;
  internalStatus?: string | null;
  estimateDate?: Date | string | null;
  // Task #1955 — when the approval email was last sent to the customer.
  // This is the expiry clock; `estimateDate` is only the fallback for
  // rows sent before this was recorded.
  approvalSentAt?: Date | string | null;
  // Canonical lifecycle column. Preferred over (status, internalStatus)
  // when set. `null`/missing means a pre-migration row.
  lifecycle?: string | null;
};

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Task #1955 — the single definition of "when does the 30-day expiry
// window start". Every surface that measures expiry (the lifecycle
// helper, the Estimate Command Center aggregator, the estimate PDF's
// validity date) must anchor on this so they never disagree.
//
// The anchor is the most recent send (`approvalSentAt`), which is
// re-stamped on every send path — first send, resend of an expired
// estimate, and re-delivery of a still-live one — so a resend restarts
// the window. Rows with no recorded send time fall back to
// `estimateDate`, preserving the pre-#1955 behavior for history.
export function estimateExpiryAnchor(
  estimate: {
    approvalSentAt?: Date | string | null;
    estimateDate?: Date | string | null;
  } | null | undefined,
): Date | null {
  if (!estimate) return null;
  return toValidDate(estimate.approvalSentAt) ?? toValidDate(estimate.estimateDate);
}

// Write-time derivation of the lifecycle column from the two legacy
// axes. Returns only the five *stored* lifecycle values; `expired` is
// intentionally excluded because it's a read-time view over
// (lifecycle='sent', last sent > 30 days ago). Every write path that
// mutates `status` or `internalStatus` must also pass the result of
// this helper through as `lifecycle` so the column stays in sync with
// the legacy axes during the dual-write window.
export type StoredLifecycleStatus = Exclude<LifecycleStatus, "expired">;

export function deriveLifecycleForWrite(opts: {
  status?: string | null;
  internalStatus?: string | null;
}): StoredLifecycleStatus {
  const status = opts.status ?? "";
  const internalStatus = opts.internalStatus ?? "";

  if (status === "approved" || status === "converted_to_work_order") return "approved";
  if (status === "rejected") return "rejected";
  if (internalStatus === "draft") return "draft";
  if (internalStatus === "sent_to_customer" && status === "pending") return "sent";
  return "pending_review";
}

const STORED_LIFECYCLES = new Set<string>([
  "draft",
  "pending_review",
  "sent",
  "approved",
  "rejected",
]);

export function computeLifecycleStatus(
  estimate: EstimateLifecycleInput,
  now: Date = new Date(),
): LifecycleStatus {
  // Prefer the stored lifecycle column when present.
  // Legacy (status, internalStatus) is consulted only when the column
  // is missing/invalid (e.g. backfill not yet run, or an in-memory
  // fixture in a test). `sent` always re-checks the expiry window so
  // a row can flip into `expired` without a write.
  const stored = (estimate.lifecycle ?? "") as string;
  const useStored = STORED_LIFECYCLES.has(stored);
  const base: StoredLifecycleStatus = useStored
    ? (stored as StoredLifecycleStatus)
    : deriveLifecycleForWrite(estimate);

  if (base === "sent") {
    // Task #1955 — measured from the last send, falling back to
    // `estimateDate` when the row has no recorded send time.
    const anchor = estimateExpiryAnchor(estimate);
    if (anchor) {
      const ageDays = (now.getTime() - anchor.getTime()) / MS_PER_DAY;
      if (ageDays > ESTIMATE_EXPIRATION_DAYS) return "expired";
    }
    return "sent";
  }

  return base;
}

// Canonical entry point for the UI. Prefers the stored `lifecycle`
// column when present, otherwise computes from
// (status, internalStatus, approvalSentAt/estimateDate). Every component that needs
// to reason about an estimate's state should go through this helper
// (or one of the predicates below) — never read `estimate.status` or
// `estimate.internalStatus` directly.
type EstimateLike = EstimateLifecycleInput & {
  workOrderId?: number | null;
};

export function lifecycleOf(
  estimate: EstimateLike | null | undefined,
  now?: Date,
): LifecycleStatus {
  if (!estimate) return "pending_review";
  // Prefer the canonical stored lifecycle column. Legacy
  // (status, internalStatus) is consulted only when the column is
  // missing/invalid (e.g. backfill not yet run, or an in-memory
  // fixture in a test).
  const stored = estimate.lifecycle;
  if (
    typeof stored === "string" &&
    (LIFECYCLE_STATUSES as readonly string[]).includes(stored)
  ) {
    // `sent` rows still need view-time expiry computation.
    if (stored === "sent") {
      return computeLifecycleStatus(
        {
          status: estimate.status,
          internalStatus: estimate.internalStatus,
          estimateDate: estimate.estimateDate,
          // Task #1955 — the expiry clock. Must be forwarded or
          // client-side expiry silently falls back to `estimateDate`.
          approvalSentAt: estimate.approvalSentAt,
          lifecycle: estimate.lifecycle,
        },
        now,
      );
    }
    return stored as LifecycleStatus;
  }
  return computeLifecycleStatus(
    {
      status: estimate.status,
      internalStatus: estimate.internalStatus,
      estimateDate: estimate.estimateDate,
      approvalSentAt: estimate.approvalSentAt,
      lifecycle: estimate.lifecycle,
    },
    now,
  );
}

// --- Predicates ------------------------------------------------------
// Each predicate accepts either an estimate-like object (preferred) or
// a pre-computed LifecycleStatus, so call sites that already hold the
// lifecycle string don't need to re-derive it.
type LifecycleArg = EstimateLike | LifecycleStatus | null | undefined;

function toLifecycle(arg: LifecycleArg, now?: Date): LifecycleStatus {
  if (arg == null) return "pending_review";
  if (typeof arg === "string") return arg as LifecycleStatus;
  return lifecycleOf(arg, now);
}

export const isDraft = (e: LifecycleArg, now?: Date) =>
  toLifecycle(e, now) === "draft";
export const isPendingReview = (e: LifecycleArg, now?: Date) =>
  toLifecycle(e, now) === "pending_review";
export const isAwaitingCustomer = (e: LifecycleArg, now?: Date) =>
  toLifecycle(e, now) === "sent";
export const isSent = isAwaitingCustomer;
export const isApproved = (e: LifecycleArg, now?: Date) =>
  toLifecycle(e, now) === "approved";
export const isRejected = (e: LifecycleArg, now?: Date) =>
  toLifecycle(e, now) === "rejected";
export const isExpired = (e: LifecycleArg, now?: Date) =>
  toLifecycle(e, now) === "expired";
export const isClosed = (e: LifecycleArg, now?: Date) => {
  const lc = toLifecycle(e, now);
  return lc === "approved" || lc === "rejected" || lc === "expired";
};
export const isOpen = (e: LifecycleArg, now?: Date) => !isClosed(e, now);

// `pending_review` covers two server-side internalStatus values:
// `pending_approval` (awaiting manager review) and `approved_internal`
// (manager has internally approved; ready to send to customer).
// The "ready to send" badge on /estimates/pending-approval needs to
// distinguish them. Keep this read isolated to lifecycle so the
// rest of the UI stays free of raw enum reads.
export const isReadyToSend = (
  e: EstimateLike | null | undefined,
): boolean => e?.internalStatus === "approved_internal";

export const isAwaitingInternalReview = (
  e: EstimateLike | null | undefined,
): boolean => e?.internalStatus === "pending_approval";

// `converted_to_work_order` is folded into the `approved` lifecycle
// bucket (the customer approved the estimate; the work order is the
// downstream artifact). UI surfaces that want to celebrate the
// conversion specifically (purple "WORK ORDER ACTIVE" banner in the
// detail modal) ask via this helper rather than reading the raw
// status enum.
export const isConvertedToWorkOrder = (
  e: EstimateLike | null | undefined,
): boolean => e?.status === "converted_to_work_order" || e?.workOrderId != null;

// Customer hasn't responded yet — used to gate the customer-facing
// Approve/Reject actions in the detail modal. Mirrors the server's
// `status === 'pending'` precondition on those endpoints.
export const isAwaitingCustomerReply = (
  e: EstimateLike | null | undefined,
): boolean => e?.status === "pending";

// Role × lifecycle delete matrix. Must agree with the server's
// `ESTIMATE_DELETE_ROLES` + `ESTIMATE_PENDING_DELETE_ROLES` sets in
// `estimate-routes.ts` / `estimate-role-guards.ts`. The UI hides the
// Delete control whenever this returns false so we never surface an
// action that would 403 / 409 on click; the server remains the
// authoritative gate.
//
//   - draft           → any role that can create an estimate (incl.
//                       field_tech for their own drafts) may delete.
//   - pending_review  → managers/admins/billing only; field_tech is
//                       refused server-side.
//   - sent / approved /
//     rejected / expired → nobody (still preserved for audit).
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const DELETE_ROLES_ANY = new Set<string>([
  "super_admin",
  "company_admin",
  "irrigation_manager",
  "billing_manager",
  "field_tech",
]);
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const DELETE_ROLES_PENDING = new Set<string>([
  "super_admin",
  "company_admin",
  "irrigation_manager",
  "billing_manager",
]);

export function canDeleteLifecycle(arg: LifecycleArg, now?: Date): boolean {
  const lc = toLifecycle(arg, now);
  return lc === "draft" || lc === "pending_review";
}

export function canDeleteEstimateAs(
  role: string | null | undefined,
  arg: LifecycleArg,
  now?: Date,
): boolean {
  if (!role || !DELETE_ROLES_ANY.has(role)) return false;
  const lc = toLifecycle(arg, now);
  if (lc === "draft") return true;
  if (lc === "pending_review") return DELETE_ROLES_PENDING.has(role);
  return false;
}

// --- Two-axis label helpers ----------------------------------------
// `computeLifecycleStatus` collapses the two server-side axes
// (internalStatus = "review stage", status = "customer response") into
// a single lifecycle bucket — which is what every list / board / badge
// surface should show. The estimate detail modal is the one
// documented exception: it shows the canonical lifecycle badge in the
// header *and* a secondary detail row exposing the two axes. These two
// helpers are the only place raw enum values turn into human-readable
// labels, so the modal doesn't have to read `estimate.status` /
// `estimate.internalStatus` directly.
export function reviewStageLabel(
  internalStatus: string | null | undefined,
): string {
  switch (internalStatus) {
    case "draft":
      return "Draft";
    case "pending_approval":
      return "Awaiting review";
    case "approved_internal":
      return "Ready to send";
    case "sent_to_customer":
      return "Sent";
    default:
      return "—";
  }
}

export function customerResponseLabel(
  status: string | null | undefined,
): string {
  switch (status) {
    case "pending":
      return "Awaiting reply";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "converted_to_work_order":
      return "Approved";
    default:
      return "—";
  }
}

export function reviewStageLabelOf(
  e: EstimateLike | null | undefined,
): string {
  return reviewStageLabel(e?.internalStatus);
}

export function customerResponseLabelOf(
  e: EstimateLike | null | undefined,
): string {
  return customerResponseLabel(e?.status);
}

// Wizard payload round-trip helper. The estimate wizard needs to
// forward the existing review track (and the customer's previous
// response) verbatim when saving an edit, but it must not read the raw
// enums itself. This helper is the one isolated point where those reads
// are allowed.
export function estimateSubmitStatusFields(
  e: EstimateLike | null | undefined,
): { nextStatus: string; nextInternalStatus: string | null } {
  return {
    nextStatus: e?.status ?? "pending",
    nextInternalStatus: e?.internalStatus ?? null,
  };
}

// Shared tint + label map so the board column headers and the list
// status badges stay visually in sync. Tailwind class strings only;
// the consumers compose them as needed.
export const LIFECYCLE_TINTS: Record<
  LifecycleStatus,
  { label: string; bg: string; text: string; border: string }
> = {
  draft: {
    label: "Draft",
    bg: "bg-gray-100",
    text: "text-gray-700",
    border: "border-gray-200",
  },
  pending_review: {
    label: "Pending review",
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
  },
  sent: {
    label: "Sent",
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
  },
  approved: {
    label: "Approved",
    bg: "bg-green-50",
    text: "text-green-700",
    border: "border-green-200",
  },
  rejected: {
    label: "Rejected",
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
  },
  expired: {
    label: "Expired",
    bg: "bg-gray-100",
    text: "text-gray-500",
    border: "border-gray-200",
  },
};

// Wet-check controller tint palette — used by the zone detail view to
// give each controller letter a stable, recognizable accent so techs
// immediately register which clock they're on when switching zones.
// Pure Tailwind class strings; UI-only.
export type ControllerTint = {
  band: string;
  border: string;
  letterBg: string;
  letterText: string;
  zoneText: string;
  label: string;
};

const CONTROLLER_TINT_PALETTE: ControllerTint[] = [
  { band: "bg-blue-600",    border: "border-blue-800",    letterBg: "bg-blue-900",    letterText: "text-white", zoneText: "text-white", label: "text-blue-100" },
  { band: "bg-purple-600",  border: "border-purple-800",  letterBg: "bg-purple-900",  letterText: "text-white", zoneText: "text-white", label: "text-purple-100" },
  { band: "bg-emerald-600", border: "border-emerald-800", letterBg: "bg-emerald-900", letterText: "text-white", zoneText: "text-white", label: "text-emerald-100" },
  { band: "bg-orange-600",  border: "border-orange-800",  letterBg: "bg-orange-900",  letterText: "text-white", zoneText: "text-white", label: "text-orange-100" },
  { band: "bg-pink-600",    border: "border-pink-800",    letterBg: "bg-pink-900",    letterText: "text-white", zoneText: "text-white", label: "text-pink-100" },
  { band: "bg-cyan-700",    border: "border-cyan-900",    letterBg: "bg-cyan-900",    letterText: "text-white", zoneText: "text-white", label: "text-cyan-100" },
  { band: "bg-indigo-600",  border: "border-indigo-800",  letterBg: "bg-indigo-900",  letterText: "text-white", zoneText: "text-white", label: "text-indigo-100" },
  { band: "bg-rose-600",    border: "border-rose-800",    letterBg: "bg-rose-900",    letterText: "text-white", zoneText: "text-white", label: "text-rose-100" },
];

export function tintForControllerLetter(letter: string | null | undefined): ControllerTint {
  const ch = (letter ?? "").toUpperCase().charCodeAt(0);
  if (!ch || Number.isNaN(ch)) return CONTROLLER_TINT_PALETTE[0];
  const a = "A".charCodeAt(0);
  const idx = ((ch - a) % CONTROLLER_TINT_PALETTE.length + CONTROLLER_TINT_PALETTE.length) % CONTROLLER_TINT_PALETTE.length;
  return CONTROLLER_TINT_PALETTE[idx];
}

// Lifecycle order used for list "Status" sorting.
export const LIFECYCLE_ORDER: Record<LifecycleStatus, number> = {
  draft: 0,
  pending_review: 1,
  sent: 2,
  approved: 3,
  rejected: 4,
  expired: 5,
};
