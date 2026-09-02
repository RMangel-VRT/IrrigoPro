import { useMemo } from "react";
import type { FieldWorkType } from "@workspace/db/schema";
import type { FieldWorkTypeRule } from "@workspace/db/field-location-policy";
import { useArrayQuery } from "@/lib/queryClient";

/**
 * The one place the web app reads the field work type registry.
 *
 * Three questions get asked of that table and they are NOT the same question:
 *
 *   1. "What may a user choose for this work?" — active rows only. A retired
 *      type must never be offered.
 *   2. "What is this stored code called?" — the full registry. A record that
 *      already carries a since-retired code still has to render a name a person
 *      recognises, not the raw database code.
 *   3. "What does this stored code require?" — the full registry. Resolving a
 *      retired type's rule demands exactly what it demanded the day the record
 *      was saved; reading active-only made a correctly-captured ticket resolve
 *      no rule at all, which the gate reads as "work type missing" and refuses
 *      to save — while the Missing Location Data report, which reads the full
 *      registry, insists the same ticket is fine.
 *
 * Callers take exactly one of `selectable`, `resolveLabel`, `resolveRule` and
 * never a raw mixed list, so 1 can never quietly answer 2 or 3. One fetch backs
 * all three; the query key is shared, so a wizard and the location card inside
 * it hit the cache once.
 */
export interface FieldWorkTypeRegistry {
  /** Types choosable for new work: active rows only. */
  selectable: FieldWorkType[];
  /** Display name for any code the registry knows, active or retired. */
  resolveLabel: (code: string | null | undefined) => string | null;
  /** Requirement rule for any code the registry knows, active or retired. */
  resolveRule: (code: string | null | undefined) => FieldWorkTypeRule | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Scoped to the record's customer, not just to the signed-in company: a Super
 * Admin has no company of their own, so an unscoped read answers with every
 * tenant's work types and would re-impose a gate the server has already failed
 * open on for this customer's empty tenant. For every other role the server
 * ignores the parameter and stays tenant-scoped.
 */
export function fieldWorkTypeRegistryQueryKey(
  customerId: number | null | undefined,
): string {
  return `/api/field-work-types?customerId=${customerId ?? ""}&includeRetired=true`;
}

export function useFieldWorkTypeRegistry(options: {
  customerId: number | null | undefined;
  enabled?: boolean;
}): FieldWorkTypeRegistry {
  const { customerId, enabled = true } = options;
  const {
    data: rows = [],
    isLoading,
    isError,
  } = useArrayQuery<FieldWorkType>({
    queryKey: [fieldWorkTypeRegistryQueryKey(customerId)],
    enabled: enabled && !!customerId,
  });

  return useMemo(() => {
    const byCode = new Map(rows.map((row) => [row.code, row]));
    const find = (code: string | null | undefined) =>
      typeof code === "string" && code !== "" ? byCode.get(code) ?? null : null;
    return {
      // `active !== false` rather than `active === true`: the flag arrives on
      // every row from the server, and a row without one can only have come
      // from the active-only default response.
      selectable: rows.filter((row) => row.active !== false),
      resolveLabel: (code) => find(code)?.label ?? null,
      resolveRule: (code) => {
        const row = find(code);
        return row
          ? {
              code: row.code,
              requiresController: row.requiresController,
              requiresZone: row.requiresZone,
              requiresDetails: row.requiresDetails,
            }
          : null;
      },
      isLoading,
      isError,
    };
  }, [rows, isLoading, isError]);
}
