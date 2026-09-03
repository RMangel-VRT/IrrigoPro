import { parseBudgetGoalInput } from "@workspace/shared";
import { createSingleUseConfirmation } from "./single-use-confirmation";

export type BudgetGoalPasteRow = {
  rowNumber: number;
  customerName: string;
  goalText: string;
  goal: number | null;
  valid: boolean;
  reason: string | null;
};

export type BudgetGoalCustomer = {
  id: number;
  name: string;
  annualBudgetGoal: string | number | null;
};

export type BudgetGoalClassification =
  | "matched"
  | "unchanged"
  | "unmatched"
  | "ambiguous"
  | "invalid";

export type ClassifiedBudgetGoalRow = BudgetGoalPasteRow & {
  status: BudgetGoalClassification;
  customerId: number | null;
  matchedCustomerName: string | null;
};

const HEADER_NAMES = new Set(["customer", "customer name", "name", "property", "property name"]);
const HEADER_GOALS = new Set(["goal", "annual goal", "annual budget goal", "budget", "budget goal"]);

function isHeader(name: string, goal: string): boolean {
  return HEADER_NAMES.has(name.trim().toLowerCase()) && HEADER_GOALS.has(goal.trim().toLowerCase());
}

/**
 * Parse exactly two columns from tab- or comma-separated pasted text.
 * Blank lines are intentionally omitted and a header is omitted only when both
 * column labels are recognizable.
 */
export function parseBudgetGoalPaste(text: string): BudgetGoalPasteRow[] {
  const rows: BudgetGoalPasteRow[] = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let firstDataLine = true;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const separator = line.includes("\t") ? "\t" : ",";
    const splitColumns = line.split(separator);
    // For comma-separated rows, commas after the first delimiter belong to
    // the money value (for example: Acme,$1,250). A tab-separated row remains
    // strict because spreadsheet paste supplies one tab per column.
    const columns = separator === "," && splitColumns.length > 2
      ? [splitColumns[0], splitColumns.slice(1).join(",")]
      : splitColumns;
    const customerName = (columns[0] ?? "").trim();
    const goalText = columns.length === 2 ? (columns[1] ?? "").trim() : "";
    if (firstDataLine && columns.length === 2 && isHeader(customerName, goalText)) {
      firstDataLine = false;
      continue;
    }
    firstDataLine = false;

    if (columns.length !== 2) {
      rows.push({
        rowNumber: index + 1,
        customerName,
        goalText,
        goal: null,
        valid: false,
        reason: "Expected exactly two columns separated by a tab or comma.",
      });
      continue;
    }
    if (!customerName) {
      rows.push({
        rowNumber: index + 1,
        customerName,
        goalText,
        goal: null,
        valid: false,
        reason: "Customer name is required.",
      });
      continue;
    }
    const goal = parseBudgetGoalInput(goalText);
    rows.push({
      rowNumber: index + 1,
      customerName,
      goalText,
      goal,
      valid: goal !== null,
      reason: goal === null ? "Annual goal must be a non-negative amount." : null,
    });
  }
  return rows;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function sameMoney(left: string | number | null, right: number): boolean {
  if (left == null) return false;
  const parsed = parseBudgetGoalInput(left);
  return parsed !== null && Math.round(parsed * 100) === Math.round(right * 100);
}

export function classifyBudgetGoalRows(
  rows: BudgetGoalPasteRow[],
  customers: BudgetGoalCustomer[],
): ClassifiedBudgetGoalRow[] {
  const byName = new Map<string, BudgetGoalCustomer[]>();
  for (const customer of customers) {
    const key = normalizedName(customer.name);
    const matches = byName.get(key) ?? [];
    matches.push(customer);
    byName.set(key, matches);
  }
  const inputCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.valid) inputCounts.set(normalizedName(row.customerName), (inputCounts.get(normalizedName(row.customerName)) ?? 0) + 1);
  }

  return rows.map((row) => {
    if (!row.valid || row.goal === null) {
      return { ...row, status: "invalid", customerId: null, matchedCustomerName: null };
    }
    const key = normalizedName(row.customerName);
    const matches = byName.get(key) ?? [];
    if (matches.length === 0) {
      return {
        ...row,
        status: "unmatched",
        customerId: null,
        matchedCustomerName: null,
        reason: "No customer with this exact name exists in the selected company.",
      };
    }
    if (matches.length > 1 || (inputCounts.get(key) ?? 0) > 1) {
      return {
        ...row,
        status: "ambiguous",
        customerId: null,
        matchedCustomerName: null,
        reason: matches.length > 1
          ? "More than one customer has this exact name in the selected company."
          : "This customer name appears more than once in the pasted rows.",
      };
    }
    const customer = matches[0];
    const unchanged = sameMoney(customer.annualBudgetGoal, row.goal);
    return {
      ...row,
      status: unchanged ? "unchanged" : "matched",
      customerId: customer.id,
      matchedCustomerName: customer.name,
      reason: unchanged ? "The annual goal already matches; no update is needed." : null,
    };
  });
}

export function canonicalBudgetGoalRows(rows: BudgetGoalPasteRow[]): string {
  const canonical = rows.map((row) => ({
    customerName: normalizedName(row.customerName),
    goal: row.goal === null ? null : row.goal.toFixed(2),
    invalidGoalText: row.goal === null ? row.goalText.trim() : null,
    valid: row.valid,
  }));
  canonical.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(canonical);
}

export interface BudgetGoalConfirmationClaims {
  userId: unknown;
  companyId: number;
  year: number;
  canonicalRows: string;
}

export const BUDGET_GOAL_CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const confirmation = createSingleUseConfirmation({
  scope: "bulk-budget-goals-confirmation-v1",
  ttlMs: BUDGET_GOAL_CONFIRMATION_TTL_MS,
  messages: {
    required: "Review the budget preview before applying changes. No customers were updated.",
    mismatch: "The budget paste no longer matches the preview. Preview it again; no customers were updated.",
    expired: "The budget preview has expired. Preview the paste again; no customers were updated.",
    used: "That budget preview was already applied. Preview the paste again; no customers were updated.",
  },
});

function fingerprint(claims: BudgetGoalConfirmationClaims): string {
  return `${String(claims.userId ?? "")}|${claims.companyId}|${claims.year}|${claims.canonicalRows}`;
}

export function issueBudgetGoalConfirmation(
  claims: BudgetGoalConfirmationClaims,
  now: Date,
): { token: string; expiresAt: Date } {
  return confirmation.issue(fingerprint(claims), now);
}

export type BudgetGoalConfirmationCheck =
  | { ok: true }
  | { ok: false; status: number; reason: string; message: string };

export function verifyBudgetGoalConfirmation(
  token: unknown,
  claims: BudgetGoalConfirmationClaims,
  now: Date,
): BudgetGoalConfirmationCheck {
  return confirmation.verify(token, fingerprint(claims), now);
}