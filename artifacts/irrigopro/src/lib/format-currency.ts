/** One money formatter for the invoice A/R surfaces (Task #1942). */
export function formatCurrency(amount: string | number): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number.isFinite(num) ? num : 0,
  );
}
