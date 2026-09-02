import type { Request } from "express";
import { recordAuditEvent, type AuditEventInput } from "./audit-log";

/**
 * A tenant whose field-work-type registry is empty has the location gate
 * skipped rather than being locked out of saving. That skip means the company
 * has silently lost field capture, so it is recorded as an audited system
 * event: Super Admin should see it before a technician discovers it by being
 * unable to finish his day.
 *
 * Best-effort by construction — the underlying writer already swallows its own
 * failures, and this wrapper guarantees that even an unexpected throw can never
 * fail the save the skip was granted for.
 */
export const LOCATION_GATE_SKIPPED_EMPTY_REGISTRY_ACTION =
  "location_gate.skipped_empty_registry";

export type LocationGateSkipContext = {
  companyId: number | null;
  surface: string;
  targetType?: string | null;
  targetId?: number | string | null;
};

export async function recordLocationGateSkip(
  req: Request | null,
  context: LocationGateSkipContext,
  writer: (
    req: Request | null,
    evt: AuditEventInput,
  ) => Promise<void> = recordAuditEvent,
): Promise<void> {
  try {
    await writer(req, {
      actorUserId: (req as any)?.authenticatedUserId ?? null,
      actorRole: (req as any)?.authenticatedUserRole ?? null,
      actorCompanyId: context.companyId,
      actionType: "system",
      action: LOCATION_GATE_SKIPPED_EMPTY_REGISTRY_ACTION,
      severity: "warning",
      targetType: context.targetType ?? null,
      targetId: context.targetId == null ? null : String(context.targetId),
      summary:
        "Work location gate skipped: this company has no active field work types.",
      details: {
        companyId: context.companyId,
        surface: context.surface,
        reason: "empty_work_type_registry",
      },
    });
  } catch {
    /* an audit failure must never block the save */
  }
}
