// Pure CSV construction for the single-invoice export.
//
// Split out of `invoice-csv.ts` by Task #1889 for one reason: the CSV is a
// customer-shareable artifact, so "internal A/R notes never reach it" has to
// be proven against real generated output rather than asserted about intent —
// and the proof lives with the PDF and email proofs in the api-server test
// group, which cannot import a module that pulls in the browser query client.
// Nothing here touches the DOM, the network, or a Vite alias, so it can be
// imported from a plain Node test.
//
// The column list below is written out explicitly and no code in this file
// iterates the keys of an invoice object. That is deliberate: a field added to
// the invoice payload — an A/R note preview, for instance — cannot leak into
// the export by being enumerated. If you change that, you break the guarantee.

export interface InvoiceCsvHeader {
  invoiceNumber: string;
  customerName: string;
  customerEmail: string;
  periodStart: string;
  periodEnd: string;
  invoiceMonth: number;
  invoiceYear: number;
  status: string;
  totalAmount: string | number;
  partsSubtotal?: string | number | null;
  laborSubtotal?: string | number | null;
  quickbooksInvoiceId?: string | null;
  sentAt?: string | null;
  createdAt?: string | null;
  dueDate?: string | null;
}

export interface AuditItem {
  id: number;
  sourceType: string;
  sourceId?: number | null;
  workOrderId?: number | null;
  billingSheetId?: number | null;
  description: string;
  workDate: string | null;
  ticketTotal: number;
}

export interface AuditResponse {
  invoiceId: number;
  items: AuditItem[];
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(values: Array<string | number | null | undefined>): string {
  return values.map(csvEscape).join(",");
}

function toIsoDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function toNum(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function buildSingleInvoiceCsv(
  invoice: InvoiceCsvHeader,
  audit: AuditResponse,
): string {
  const total = toNum(invoice.totalAmount);
  const parts = toNum(invoice.partsSubtotal);
  const labor = toNum(invoice.laborSubtotal);
  const subtotal = parts + labor;
  const tax = Math.max(0, +(total - subtotal).toFixed(2));
  const issued = toIsoDate(invoice.sentAt ?? invoice.createdAt);
  const due = toIsoDate(invoice.dueDate);
  const qbStatus = invoice.quickbooksInvoiceId ? "Synced" : "Not synced";
  const periodStart = toIsoDate(invoice.periodStart);
  const periodEnd = toIsoDate(invoice.periodEnd);

  const lines: string[] = [];

  // Header section: key/value rows. An explicit list — never a key walk over
  // the invoice object. See the note at the top of this file.
  lines.push(row(["Invoice Number", invoice.invoiceNumber]));
  lines.push(row(["Customer", invoice.customerName]));
  lines.push(row(["Customer Email", invoice.customerEmail || ""]));
  lines.push(row(["Billing Period Start", periodStart]));
  lines.push(row(["Billing Period End", periodEnd]));
  lines.push(row(["Status", invoice.status]));
  lines.push(row(["QuickBooks Sync Status", qbStatus]));
  lines.push(row(["Subtotal", formatMoney(subtotal)]));
  lines.push(row(["Tax", formatMoney(tax)]));
  lines.push(row(["Total", formatMoney(total)]));
  lines.push(row(["Issued Date", issued]));
  lines.push(row(["Due Date", due]));

  // Blank separator row
  lines.push("");

  // Line items section
  lines.push(row(["Type", "Number", "Date", "Description", "Total"]));
  let itemsSum = 0;
  for (const item of audit.items) {
    const isWo = item.sourceType === "work_order";
    const type = isWo ? "WO" : "BS";
    const refId = isWo
      ? item.workOrderId ?? item.sourceId ?? ""
      : item.billingSheetId ?? item.sourceId ?? "";
    const number = `${type}-${refId}`;
    const date = toIsoDate(item.workDate);
    const ticketTotal = toNum(item.ticketTotal);
    itemsSum += ticketTotal;
    lines.push(
      row([type, number, date, item.description ?? "", formatMoney(ticketTotal)]),
    );
  }

  // Totals row uses the invoice total (matches the PDF, even if line items don't perfectly sum)
  lines.push(row(["", "", "", "Total", formatMoney(total)]));

  return lines.join("\r\n") + "\r\n";
}

export function singleInvoiceCsvFilename(invoice: {
  invoiceNumber: string;
  invoiceYear: number;
  invoiceMonth: number;
}): string {
  const month = String(invoice.invoiceMonth).padStart(2, "0");
  return `invoice-${invoice.invoiceNumber}-${invoice.invoiceYear}-${month}.csv`;
}
