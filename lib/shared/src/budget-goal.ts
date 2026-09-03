/**
 * The forgiving annual-goal parser used by both the customer form and the
 * administrator bulk budget workflow. Keep this intentionally permissive:
 * spreadsheet values commonly arrive with currency symbols, commas, or
 * whitespace.
 */
export function parseBudgetGoalInput(value: unknown): number | null {
  if (value == null) return null;
  const cleaned = String(value).trim().replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}