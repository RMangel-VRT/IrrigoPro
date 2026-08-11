import { apiRequest } from "@/lib/queryClient";
// Task #1889 — the pure builder now lives in `invoice-csv-builder.ts` so the
// "A/R notes never reach a customer-shareable artifact" proof can import it
// from a plain Node test alongside the PDF and email proofs. Re-exported here
// so every existing call site keeps importing from `@/lib/invoice-csv`.
import {
  buildSingleInvoiceCsv,
  singleInvoiceCsvFilename,
  type AuditResponse,
  type InvoiceCsvHeader,
} from "./invoice-csv-builder";

export {
  buildSingleInvoiceCsv,
  singleInvoiceCsvFilename,
  type AuditItem,
  type AuditResponse,
  type InvoiceCsvHeader,
} from "./invoice-csv-builder";

export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function fetchInvoiceAudit(invoiceId: number): Promise<AuditResponse> {
  return await apiRequest(`/api/invoices/${invoiceId}/audit`);
}

export async function exportSingleInvoiceCsv(
  invoice: InvoiceCsvHeader & { id: number },
): Promise<void> {
  const audit = await fetchInvoiceAudit(invoice.id);
  const csv = buildSingleInvoiceCsv(invoice, audit);
  downloadCsv(csv, singleInvoiceCsvFilename(invoice));
}
