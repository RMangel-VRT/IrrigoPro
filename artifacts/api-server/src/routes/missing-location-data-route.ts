import type { Express, RequestHandler } from "express";
import type {
  BillingSheet,
  FieldWorkType,
  LocationConfidence,
  LocationGateViolation,
  WorkOrder,
} from "@workspace/db";
import {
  checkLocationGate,
  deriveLocationConfidence,
} from "@workspace/db";
import { requireLocationReportRead } from "./role-guards";

export type MissingLocationTicketType = "work_order" | "billing_sheet";

export interface MissingLocationReportRow {
  ticketType: MissingLocationTicketType;
  ticketId: number;
  ticketNumber: string;
  customerId: number | null;
  customerName: string;
  branchName: string | null;
  technicianId: number | null;
  technicianName: string;
  workDate: string | null;
  status: string;
  violations: LocationGateViolation[];
  confidence: LocationConfidence;
  companyId: number | null;
  companyName: string | null;
  canonicalPath: string;
}

export interface MissingLocationReportResponse {
  count: number;
  rows: MissingLocationReportRow[];
}

export interface MissingLocationDataStorage {
  getWorkOrders(companyId: number | null): Promise<WorkOrder[]>;
  getAllBillingSheets(companyId: number | null): Promise<BillingSheet[]>;
  getFieldWorkTypes(companyId: number | null, activeOnly?: boolean): Promise<FieldWorkType[]>;
  getCompanies(): Promise<Array<{ id: number; name: string }>>;
}

interface ReportFilters {
  ticketType: "all" | MissingLocationTicketType;
  ticketId: number | null;
  technicianId: number | null;
  technicianText: string | null;
  from: Date | null;
  toExclusive: Date | null;
  lowConfidenceOnly: boolean;
}

function parseDateBoundary(value: unknown, endOfDay: boolean): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? "00:00:00.000" : "00:00:00.000"}Z`)
    : new Date(raw);
  if (!Number.isFinite(date.getTime())) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date;
}

function parseFilters(req: any): { filters?: ReportFilters; error?: string } {
  const requestedType = typeof req.query.ticketType === "string"
    ? req.query.ticketType.trim().toLowerCase()
    : "all";
  if (
    requestedType !== "all" &&
    requestedType !== "work_order" &&
    requestedType !== "billing_sheet"
  ) {
    return { error: "ticketType must be all, work_order, or billing_sheet." };
  }

  let ticketId: number | null = null;
  if (req.query.ticketId !== undefined && String(req.query.ticketId).trim() !== "") {
    ticketId = Number(String(req.query.ticketId).trim());
    if (!Number.isSafeInteger(ticketId) || ticketId < 1) {
      return { error: "ticketId must be a positive integer." };
    }
  }

  const rawTechnicianId = req.query.technicianId ?? req.query.technician;
  let technicianId: number | null = null;
  let technicianText: string | null = null;
  if (rawTechnicianId !== undefined && String(rawTechnicianId).trim() !== "") {
    const value = String(rawTechnicianId).trim();
    if (/^\d+$/.test(value)) {
      technicianId = Number(value);
      if (!Number.isSafeInteger(technicianId) || technicianId < 1) {
        return { error: "technicianId must be a positive integer." };
      }
    } else if (req.query.technicianId !== undefined) {
      return { error: "technicianId must be a positive integer." };
    } else {
      technicianText = value.toLocaleLowerCase();
    }
  }

  const from = parseDateBoundary(req.query.from, false);
  const toExclusive = parseDateBoundary(req.query.to, true);
  if (req.query.from !== undefined && req.query.from !== "" && from === null) {
    return { error: "from must be a valid date." };
  }
  if (req.query.to !== undefined && req.query.to !== "" && toExclusive === null) {
    return { error: "to must be a valid date." };
  }
  if (from && toExclusive && from >= toExclusive) {
    return { error: "from must be on or before to." };
  }

  const lowConfidenceOnly =
    req.query.lowConfidenceOnly === true ||
    ["true", "1", "yes"].includes(String(req.query.lowConfidenceOnly ?? "").toLowerCase());

  return {
    filters: {
      ticketType: requestedType as ReportFilters["ticketType"],
      ticketId,
      technicianId,
      technicianText,
      from,
      toExclusive,
      lowConfidenceOnly,
    },
  };
}

function asIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function rowMatchesFilters(
  row: MissingLocationReportRow,
  filters: ReportFilters,
): boolean {
  if (filters.ticketType !== "all" && row.ticketType !== filters.ticketType) return false;
  if (filters.ticketId !== null && row.ticketId !== filters.ticketId) return false;
  if (filters.technicianId !== null && row.technicianId !== filters.technicianId) return false;
  if (
    filters.technicianText !== null &&
    !row.technicianName.toLocaleLowerCase().includes(filters.technicianText)
  ) return false;
  const workTime = row.workDate ? new Date(row.workDate).getTime() : NaN;
  if (filters.from && (!Number.isFinite(workTime) || workTime < filters.from.getTime())) return false;
  if (filters.toExclusive && (!Number.isFinite(workTime) || workTime >= filters.toExclusive.getTime())) return false;
  if (filters.lowConfidenceOnly && row.confidence !== "low") return false;
  return true;
}

function makeRow(
  ticketType: MissingLocationTicketType,
  ticket: WorkOrder | BillingSheet,
  rule: FieldWorkType[] | undefined,
  companyName: string | null,
): MissingLocationReportRow | null {
  const fieldWorkType = ticket.fieldWorkType ?? null;
  const selectedRule = rule?.find((candidate) => candidate.code === fieldWorkType) ?? null;
  const violations = checkLocationGate(
    {
      workLocationLat: ticket.workLocationLat,
      workLocationLng: ticket.workLocationLng,
      fieldWorkType,
      fieldWorkTypeDetails: ticket.fieldWorkTypeDetails ?? null,
      controllerLetter: ticket.controllerLetter ?? null,
      zoneNumber: ticket.zoneNumber ?? null,
    },
    selectedRule,
  );
  const confidence = deriveLocationConfidence({
    workLocationSource: ticket.workLocationSource ?? null,
    workLocationGpsError: ticket.workLocationGpsError ?? null,
  });

  // A low-confidence manual pin is a separate audit concern even when the
  // required fields are otherwise complete. The normal report includes it;
  // the low-confidence toggle narrows to this subset.
  if (violations.length === 0 && confidence !== "low") return null;

  const companyId = ticket.companyId ?? null;
  const isWorkOrder = ticketType === "work_order";
  const workOrder = isWorkOrder ? ticket as WorkOrder : null;
  const billingSheet = isWorkOrder ? null : ticket as BillingSheet;
  const ticketId = ticket.id;
  return {
    ticketType,
    ticketId,
    ticketNumber: isWorkOrder
      ? workOrder!.workOrderNumber
      : billingSheet!.billingNumber,
    customerId: ticket.customerId ?? null,
    customerName: ticket.customerName,
    branchName: ticket.branchName ?? null,
    technicianId: isWorkOrder
      ? workOrder!.assignedTechnicianId ?? null
      : billingSheet!.technicianId ?? null,
    technicianName: isWorkOrder
      ? workOrder!.assignedTechnicianName ?? "Unassigned"
      : billingSheet!.technicianName,
    workDate: asIso(isWorkOrder ? workOrder!.scheduledDate ?? workOrder!.createdAt : billingSheet!.workDate),
    status: ticket.status,
    violations,
    confidence,
    companyId,
    companyName,
    canonicalPath: isWorkOrder
      ? `/work-orders?openWorkOrder=${ticketId}`
      : `/billing-sheets?openSheet=${ticketId}`,
  };
}

function sortRows(a: MissingLocationReportRow, b: MissingLocationReportRow): number {
  const dateDifference =
    (b.workDate ? new Date(b.workDate).getTime() : 0) -
    (a.workDate ? new Date(a.workDate).getTime() : 0);
  if (dateDifference !== 0) return dateDifference;
  if (a.ticketType !== b.ticketType) return a.ticketType === "work_order" ? -1 : 1;
  if (a.ticketNumber !== b.ticketNumber) return a.ticketNumber.localeCompare(b.ticketNumber);
  return a.ticketId - b.ticketId;
}

export function registerMissingLocationDataRoute(
  app: Express,
  storage: MissingLocationDataStorage,
  requireAuthentication: RequestHandler,
): void {
  app.get(
    "/api/reports/missing-location-data",
    requireAuthentication,
    requireLocationReportRead,
    async (req: any, res) => {
      try {
        const parsed = parseFilters(req);
        if (parsed.error) {
          res.status(400).json({ message: parsed.error });
          return;
        }

        const role = req.authenticatedUserRole;
        const isSuperAdmin = role === "super_admin";
        const companyId: number | null = isSuperAdmin
          ? null
          : (req.authenticatedUserCompanyId ?? null);
        if (!isSuperAdmin && companyId === null) {
          res.status(403).json({ message: "Access denied: no company context." });
          return;
        }

        const filters = parsed.filters!;
        const shouldReadWorkOrders = filters.ticketType !== "billing_sheet";
        const shouldReadBillingSheets = filters.ticketType !== "work_order";
        const [workOrders, billingSheets, companies] = await Promise.all([
          shouldReadWorkOrders ? storage.getWorkOrders(companyId) : Promise.resolve([] as WorkOrder[]),
          shouldReadBillingSheets
            ? storage.getAllBillingSheets(companyId)
            : Promise.resolve([] as BillingSheet[]),
          storage.getCompanies(),
        ]);

        const companyNames = new Map(companies.map((company) => [company.id, company.name]));
        const companyIds = new Set<number>();
        for (const ticket of [...workOrders, ...billingSheets]) {
          if (ticket.companyId != null) companyIds.add(ticket.companyId);
        }
        const rulesByCompany = new Map<number, FieldWorkType[]>();
        await Promise.all(
          [...companyIds].map(async (id) => {
            rulesByCompany.set(id, await storage.getFieldWorkTypes(id, false));
          }),
        );

        const rows = [
          ...workOrders
            .map((ticket) => makeRow(
              "work_order",
              ticket,
              ticket.companyId == null ? undefined : rulesByCompany.get(ticket.companyId),
              ticket.companyId == null ? null : companyNames.get(ticket.companyId) ?? `Company ${ticket.companyId}`,
            ))
            .filter((row): row is MissingLocationReportRow => row !== null),
          ...billingSheets
            .map((ticket) => makeRow(
              "billing_sheet",
              ticket,
              ticket.companyId == null ? undefined : rulesByCompany.get(ticket.companyId),
              ticket.companyId == null ? null : companyNames.get(ticket.companyId) ?? `Company ${ticket.companyId}`,
            ))
            .filter((row): row is MissingLocationReportRow => row !== null),
        ]
          .filter((row) => rowMatchesFilters(row, filters))
          .sort(sortRows);

        const response: MissingLocationReportResponse = { count: rows.length, rows };
        res.json(response);
      } catch (error) {
        console.error("Missing location data report failed:", error);
        res.status(500).json({ message: "Failed to fetch missing location data report." });
      }
    },
  );
}
