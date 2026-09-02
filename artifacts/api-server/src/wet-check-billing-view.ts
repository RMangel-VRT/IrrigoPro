/**
 * WC Billing Slice 3 — Zone-grouped view assembler
 *
 * Provides:
 *   • TypeScript interfaces for the WetCheckBillingView payload
 *   • buildWetCheckBillingView — pure function, no I/O
 *
 * Both the in-app modal (Slice 5) and the PDF template (Slice 7)
 * consume the same shape so this is the single source of truth.
 */

import type {
  BillingSheet,
  Customer,
  WetCheck,
  WetCheckFinding,
  WetCheckZoneRecord,
  IssueTypeConfig,
} from "@workspace/db";
import { resolveIssueTypeKey } from "./seeds/issue-type-configs";

// Minimal WCB snapshot fields needed for snapshot-first totals (Slice 4c).
export interface WcbSnapshot {
  partsSubtotal: string | null | undefined;
  laborSubtotal: string | null | undefined;
  totalAmount: string | null | undefined;
  status?: string | null;
  invoiceId?: number | null;
}

// ─── Public interfaces ───────────────────────────────────────────────────────

/** One finding's combined parts + labor cost on the billing view. */
export interface WcvLineItem {
  findingId: number;
  issueType: string;
  /** Human-readable label sourced from issueTypeConfigs; title-cased fallback. */
  issueDisplayLabel: string;
  partName: string | null;
  quantity: number;
  /** Part unit price (2dp decimal string). */
  unitPrice: string;
  /** quantity × unitPrice (2dp). */
  partsTotal: string;
  /** Per-finding labor hours (2dp). */
  laborHours: string;
  /** laborHours × laborRate (2dp). */
  laborTotal: string;
  /** partsTotal + laborTotal (2dp). */
  lineTotal: string;
  /** True when the finding is a labor-only repair (no part required). */
  noPartNeeded: boolean;
  notes: string | null;
  /** URLs of photos attached to this finding. Empty when no photos. */
  findingPhotoUrls: string[];
  /** Catalog default labor per unit, used to preview quantity corrections. */
  catalogLaborHours?: string;
}

/** All findings for a single controller zone. */
export interface WcvZone {
  /** PK of the wet_check_zone_records row. Exposed so billing-manager UIs can PATCH zone labor. */
  zoneRecordId: number;
  controllerLetter: string;
  zoneNumber: number;
  /** Formatted label, e.g. "A-1". */
  zoneLabel: string;
  /**
   * Authoritative per-zone repair labor hours from the `repair_labor_hours`
   * column on wet_check_zone_records (Task #753, Slice 4 Option B).
   * The billing sheet total is driven by this value, not per-finding sums.
   */
  repairLaborHours: string;
  /** True when repairLaborHours was manually overridden (not auto-computed). */
  repairLaborManuallySet: boolean;
  lineItems: WcvLineItem[];
  zonePartsSubtotal: string;
  zoneLaborSubtotal: string;
  zoneTotal: string;
  /** URLs of photos attached at the zone level (not linked to any finding). Empty when none. */
  zonePhotoUrls: string[];
}

/** Snapshot of the wet check inspection that produced these findings. */
export interface WcvInspection {
  wetCheckId: number;
  technicianName: string;
  /** ISO date string (wet check startedAt). */
  inspectionDate: string;
  propertyAddress: string | null;
  weather: string | null;
  notes: string | null;
}

/** Full zone-grouped billing view for a billing sheet backed by a wet check. */
export interface WetCheckBillingView {
  /**
   * Set when the view was assembled from the `billing_sheets` path (legacy).
   * Undefined when assembled from `wet_check_billings` (Slice 2+).
   */
  billingSheetId?: number;
  /**
   * Set when the view was assembled from the `wet_check_billings` table (Slice 2+).
   * Undefined on the legacy billing-sheet path. Both may coexist during migration.
   */
  wetCheckBillingId?: number;
  wetCheckBillingStatus?: string | null;
  wetCheckBillingInvoiceId?: number | null;
  billingNumber: string;
  customerId: number;
  customerName: string;
  /** ISO date string (billing sheet workDate). */
  workDate: string;
  /**
   * Effective labor rate used throughout this view.
   * Precedence: bs.appliedLaborRate ?? bs.laborRate ?? customer.laborRate
   */
  laborRate: string;
  inspection: WcvInspection;
  /** Zones sorted by controllerLetter ASC then zoneNumber ASC. */
  zones: WcvZone[];
  /** e.g. "3 repairs across 2 zones" */
  repairsSummary: string;
  partsSubtotal: string;
  laborSubtotal: string;
  grandTotal: string;
  /**
   * Slice 4c — "wcb_snapshot" when totals were read from the WCB row's
   * snapshot columns (authoritative); "live_derive" when derived from
   * zone records (legacy BS-WC path or pre-creation preview).
   */
  totalsSource: "wcb_snapshot" | "live_derive";
  /**
   * Slice 4c — true when totalsSource is "wcb_snapshot" AND the live
   * zone-level labor sum differs from the snapshot labor subtotal by
   * more than $0.01 (stale zone repair_labor_hours).
   */
  zonesHaveStaleLaborData: boolean;
}

// ─── Assembler input ─────────────────────────────────────────────────────────

export interface BuildWetCheckBillingViewInput {
  billingSheet: BillingSheet;
  customer: Customer;
  /**
   * Findings that have billingSheetId === billingSheet.id.
   * Caller is responsible for pre-filtering.
   */
  findings: WetCheckFinding[];
  /** All zone records whose ids appear in findings.zoneRecordId. */
  zoneRecords: WetCheckZoneRecord[];
  wetCheck: WetCheck;
  /** issueTypeConfigs for the billing sheet's company (active + inactive). */
  issueTypeConfigs: IssueTypeConfig[];
  /**
   * Optional wet check photos with zone/finding linkage.
   * When provided, each zone and line item will carry the relevant photo URLs.
   */
  photos?: Array<{ url: string; zoneRecordId: number | null; findingId: number | null }>;
  /**
   * Slice 4c — snapshot columns from the wet_check_billings row.
   * When provided and totalAmount is non-null, totals are read from the
   * snapshot rather than re-derived from zone records, eliminating drift
   * from stale zone labor data. Pass undefined on the legacy BS-WC path.
   */
  wcb?: WcbSnapshot;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(s: string | null | undefined): number {
  const n = parseFloat(s ?? "0");
  return isNaN(n) ? 0 : n;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

/**
 * Title-case an issueType key as a display-label fallback.
 * "head_replacement" → "Head Replacement"
 */
function titleCase(issueType: string): string {
  return issueType
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Shared parts calculation used by both the view and atomic WCB mutations. */
export function computeWetCheckBillingPartsSubtotal(
  findings: Array<Pick<WetCheckFinding, "noPartNeeded" | "partPrice" | "quantity">>,
): number {
  return findings.reduce((sum, finding) => {
    if (finding.noPartNeeded) return sum;
    return sum + toNum(finding.partPrice) * (finding.quantity ?? 0);
  }, 0);
}

// ─── Pure assembler ──────────────────────────────────────────────────────────

export function buildWetCheckBillingView(
  input: BuildWetCheckBillingViewInput,
): WetCheckBillingView {
  const { billingSheet: bs, customer, findings, zoneRecords, wetCheck, issueTypeConfigs, photos = [], wcb } = input;

  // ── Labor rate precedence ────────────────────────────────────────────────
  // Nullish precedence: appliedLaborRate ?? laborRate ?? customer.laborRate.
  // An explicit "0.00" on the billing sheet is preserved — do NOT use ||
  // (which would treat zero as falsy and silently skip to the next rate).
  const effectiveRateStr = bs.appliedLaborRate ?? bs.laborRate ?? customer.laborRate;
  const laborRate = fmt(toNum(effectiveRateStr));
  const laborRateNum = toNum(laborRate);

  // ── issueType → displayLabel lookup ─────────────────────────────────────
  const labelMap = new Map<string, string>();
  const catalogLaborMap = new Map<string, string | null>();
  for (const cfg of issueTypeConfigs) {
    const key = resolveIssueTypeKey(cfg.issueType);
    labelMap.set(key, cfg.displayLabel);
    catalogLaborMap.set(key, cfg.defaultLaborHours);
  }

  // ── zoneRecordId → zone record lookup ───────────────────────────────────
  const zoneMap = new Map<number, WetCheckZoneRecord>();
  for (const zr of zoneRecords) {
    zoneMap.set(zr.id, zr);
  }

  // ── Group findings by zoneRecordId ───────────────────────────────────────
  const grouped = new Map<number, WetCheckFinding[]>();
  for (const f of findings) {
    const bucket = grouped.get(f.zoneRecordId) ?? [];
    bucket.push(f);
    grouped.set(f.zoneRecordId, bucket);
  }

  // ── Photo grouping ───────────────────────────────────────────────────────
  // findingId → photo URLs
  const findingPhotoMap = new Map<number, string[]>();
  // zoneRecordId → zone-level photo URLs (no findingId)
  const zonePhotoMap = new Map<number, string[]>();

  for (const photo of photos) {
    if (!photo.url) continue;
    if (photo.findingId !== null) {
      const arr = findingPhotoMap.get(photo.findingId) ?? [];
      arr.push(photo.url);
      findingPhotoMap.set(photo.findingId, arr);
    } else if (photo.zoneRecordId !== null) {
      const arr = zonePhotoMap.get(photo.zoneRecordId) ?? [];
      arr.push(photo.url);
      zonePhotoMap.set(photo.zoneRecordId, arr);
    }
  }

  // ── Build zones ──────────────────────────────────────────────────────────
  const zones: WcvZone[] = [];

  for (const [zoneRecordId, zonefindings] of grouped) {
    const zr = zoneMap.get(zoneRecordId);
    if (!zr) continue;

    // Sort findings by id for deterministic output
    const sorted = [...zonefindings].sort((a, b) => a.id - b.id);

    // Task #753, Slice 4 — zone-level repair labor comes from the dedicated
    // column, NOT from summing per-finding laborHours. This eliminates
    // double-counting (the column is the single source of truth for billing).
    const repairLaborHoursNum = toNum(zr.repairLaborHours);
    const zoneLabor = repairLaborHoursNum * laborRateNum;

    const zoneParts = computeWetCheckBillingPartsSubtotal(sorted);

    const lineItems: WcvLineItem[] = sorted.map((f) => {
      const issueKey = resolveIssueTypeKey(f.issueType);
      const issueDisplayLabel = labelMap.get(issueKey) ?? titleCase(f.issueType);
      const unitPrice = toNum(f.partPrice);
      const qty = f.quantity ?? 0;
      const partsTotal = f.noPartNeeded ? 0 : unitPrice * qty;
      // Per-finding laborHours are shown for display purposes on line items but
      // do NOT contribute to zone or sheet totals — repairLaborHours drives
      // billing math at the zone level (Slice 4 Option B).
      const laborHoursNum = toNum(f.laborHours);
      const laborTotal = laborHoursNum * laborRateNum;
      const lineTotal = partsTotal + laborTotal;

      return {
        findingId: f.id,
        issueType: f.issueType,
        issueDisplayLabel,
        partName: f.partName ?? null,
        quantity: qty,
        unitPrice: fmt(unitPrice),
        partsTotal: fmt(partsTotal),
        laborHours: fmt(laborHoursNum),
        laborTotal: fmt(laborTotal),
        lineTotal: fmt(lineTotal),
        noPartNeeded: f.noPartNeeded,
        notes: f.notes ?? null,
        findingPhotoUrls: findingPhotoMap.get(f.id) ?? [],
        catalogLaborHours: fmt(toNum(catalogLaborMap.get(issueKey))),
      };
    });

    zones.push({
      zoneRecordId,
      controllerLetter: zr.controllerLetter,
      zoneNumber: zr.zoneNumber,
      zoneLabel: `${zr.controllerLetter}-${zr.zoneNumber}`,
      repairLaborHours: fmt(repairLaborHoursNum),
      repairLaborManuallySet: !!(zr as any).repairLaborManuallySet,
      lineItems,
      zonePartsSubtotal: fmt(zoneParts),
      zoneLaborSubtotal: fmt(zoneLabor),
      zoneTotal: fmt(zoneParts + zoneLabor),
      zonePhotoUrls: zonePhotoMap.get(zoneRecordId) ?? [],
    });
  }

  // ── Sort zones: controllerLetter ASC, zoneNumber ASC ───────────────────
  zones.sort((a, b) => {
    if (a.controllerLetter < b.controllerLetter) return -1;
    if (a.controllerLetter > b.controllerLetter) return 1;
    return a.zoneNumber - b.zoneNumber;
  });

  // ── Totals ───────────────────────────────────────────────────────────────
  // Slice 4c — Snapshot-first totals.
  //
  // When a wet_check_billings row exists for this view, its snapshot
  // columns are authoritative — that's what gets billed, snapshotted at
  // approval time, pushed to QuickBooks, and reconciled in the financial
  // pulse audit. Re-deriving totals from zone records can disagree with
  // the snapshot for two reasons:
  //   1. Legacy zones whose `repair_labor_hours` was never recomputed
  //      (Task #891 hook didn't fire on findings created pre-deploy).
  //   2. The wet-check-level `wc.totalLaborHours` overhead (inspection +
  //      travel) that gets included in `_writeRepairedInFieldBilling`
  //      but is silently dropped here.
  //
  // Snapshot-first eliminates both classes of drift.
  let partsSubtotal: number;
  let laborSubtotal: number;
  let totalsSource: "wcb_snapshot" | "live_derive";

  if (wcb && wcb.totalAmount != null) {
    // WCB snapshot path — what the customer is actually billed.
    partsSubtotal = toNum(wcb.partsSubtotal);
    laborSubtotal = toNum(wcb.laborSubtotal);
    totalsSource = "wcb_snapshot";
  } else {
    // Legacy BS-WC path or pre-creation preview — derive live.
    partsSubtotal = 0;
    laborSubtotal = 0;
    for (const z of zones) {
      partsSubtotal += toNum(z.zonePartsSubtotal);
      laborSubtotal += toNum(z.zoneLaborSubtotal);
    }
    totalsSource = "live_derive";
  }
  const grandTotal = partsSubtotal + laborSubtotal;

  // Detect stale zone labor data: when we have a WCB snapshot, check whether
  // the live zone-level labor sum meaningfully disagrees with the snapshot.
  const liveZoneLaborSum = zones.reduce((s, z) => s + toNum(z.zoneLaborSubtotal), 0);
  const zonesHaveStaleLaborData =
    totalsSource === "wcb_snapshot" &&
    Math.abs(laborSubtotal - liveZoneLaborSum) > 0.01;

  // ── Summary ───────────────────────────────────────────────────────────────
  const repairCount = findings.length;
  const zoneCount = zones.length;
  const repairsSummary =
    `${repairCount} ${repairCount === 1 ? "repair" : "repairs"} ` +
    `across ${zoneCount} ${zoneCount === 1 ? "zone" : "zones"}`;

  // ── Inspection ───────────────────────────────────────────────────────────
  const inspection: WcvInspection = {
    wetCheckId: wetCheck.id,
    technicianName: wetCheck.technicianName,
    inspectionDate: wetCheck.startedAt.toISOString(),
    propertyAddress: wetCheck.propertyAddress ?? null,
    weather: wetCheck.weather ?? null,
    notes: wetCheck.notes ?? null,
  };

  return {
    billingSheetId: bs.id,
    wetCheckBillingStatus: wcb?.status,
    wetCheckBillingInvoiceId: wcb?.invoiceId,
    billingNumber: bs.billingNumber,
    customerId: customer.id,
    customerName: customer.name,
    workDate: bs.workDate.toISOString(),
    laborRate,
    inspection,
    zones,
    repairsSummary,
    partsSubtotal: fmt(partsSubtotal),
    laborSubtotal: fmt(laborSubtotal),
    grandTotal: fmt(grandTotal),
    totalsSource,
    zonesHaveStaleLaborData,
  };
}
