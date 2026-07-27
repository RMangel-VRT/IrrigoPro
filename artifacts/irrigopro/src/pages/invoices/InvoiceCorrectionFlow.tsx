// Task #1710 — Invoice Correction & Reissue (Guided Dispute Flow)
//
// 5-step flow: Dispute → Correct → Document → Review → Reissue
// Launched from the Invoices page for issued invoices.
// company_admin and billing_manager only.

import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  ChevronRight,
  ChevronLeft,
  Loader2,
  CheckCircle2,
  FileText,
  Edit3,
  BookOpen,
  Eye,
  RefreshCw,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

function parseApiErrorCode(err: Error): string | null {
  try {
    const colon = err.message.indexOf(': ');
    if (colon < 0) return null;
    const body = JSON.parse(err.message.slice(colon + 2));
    return typeof body?.code === 'string' ? body.code : null;
  } catch {
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

interface Invoice {
  id: number;
  invoiceNumber: string;
  customerName: string;
  customerEmail: string;
  totalAmount: string;
  status: string;
}

interface Ticket {
  ticketType: "billing_sheet" | "work_order" | "wcb";
  ticketId: number;
  description: string;
  workDate: string | null;
  partsSubtotal: string;
  laborSubtotal: string;
  totalAmount: string;
  ticketNumber: string | null;
}

interface CorrectionLine {
  ticketType: "billing_sheet" | "work_order" | "wcb";
  ticketId: number;
  beforeParts?: string;
  beforeLabor?: string;
  beforeTotal?: string;
  afterParts?: string;
  afterLabor?: string;
  afterTotal?: string;
  action: "zero_line" | "adjust" | "exclude";
  lineNote?: string;
}

interface Correction {
  id: number;
  status: string;
  reasonCategory: string | null;
  requestSource: string | null;
  requestedBy: string | null;
  reasonDetail: string | null;
  evidenceUrl: string | null;
  evidenceNote: string | null;
  originalTotal: string | null;
  correctedTotal: string | null;
  deltaAmount: string | null;
}

export type Step = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS: Record<Step, string> = {
  1: "Dispute",
  2: "Correct",
  3: "Document",
  4: "Review",
  5: "Reissue",
};

const STEP_ICONS: Record<Step, React.ReactNode> = {
  1: <AlertCircle className="w-4 h-4" />,
  2: <Edit3 className="w-4 h-4" />,
  3: <BookOpen className="w-4 h-4" />,
  4: <Eye className="w-4 h-4" />,
  5: <RefreshCw className="w-4 h-4" />,
};

const REASON_CATEGORIES = [
  { value: "customer_dispute", label: "Customer Dispute" },
  { value: "pricing_error", label: "Pricing Error" },
  { value: "duplicate_charge", label: "Duplicate Charge" },
  { value: "goodwill_credit", label: "Goodwill Credit" },
  { value: "scope_change", label: "Scope Change" },
  { value: "tech_error", label: "Tech Error" },
  { value: "other", label: "Other" },
] as const;

const REQUEST_SOURCES = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "in_person", label: "In Person" },
  { value: "sms", label: "SMS" },
  { value: "other", label: "Other" },
] as const;

const LINE_ACTIONS = [
  { value: "zero_line", label: "Zero Out Line" },
  { value: "adjust", label: "Adjust Amount" },
  { value: "exclude", label: "Exclude Ticket" },
] as const;

function formatCurrency(amount: string | number | null | undefined) {
  const num = typeof amount === "string" ? parseFloat(amount) : (amount ?? 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num || 0);
}

function ticketTypeLabel(type: Ticket["ticketType"]) {
  switch (type) {
    case "billing_sheet": return "Billing Sheet";
    case "work_order": return "Work Order";
    case "wcb": return "Wet Check Billing";
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StepNav({ current, completedSteps }: { current: Step; completedSteps: Set<Step> }) {
  const steps: Step[] = [1, 2, 3, 4, 5];
  return (
    <div className="flex items-center gap-1 text-xs mb-6">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-1">
          <div
            className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-colors ${
              step === current
                ? "bg-blue-600 text-white"
                : completedSteps.has(step)
                ? "bg-emerald-100 text-emerald-700"
                : "bg-gray-100 text-gray-400"
            }`}
          >
            {completedSteps.has(step) && step !== current ? (
              <CheckCircle2 className="w-3.5 h-3.5" />
            ) : (
              STEP_ICONS[step]
            )}
            {STEP_LABELS[step]}
          </div>
          {i < steps.length - 1 && (
            <ChevronRight className="w-3 h-3 text-gray-300" />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Step 1: Dispute ────────────────────────────────────────────────────────

function DisputeStep({
  tickets,
  selectedTicketIds,
  onToggle,
}: {
  tickets: Ticket[];
  selectedTicketIds: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (tickets.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400">
        <FileText className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p>No tickets found on this invoice.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600 mb-4">
        Select the ticket(s) you want to dispute or correct. You can edit each one in the next step.
      </p>
      {tickets.map((t) => {
        const key = `${t.ticketType}:${t.ticketId}`;
        const checked = selectedTicketIds.has(key);
        return (
          <div
            key={key}
            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              checked ? "border-blue-300 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
            }`}
            onClick={() => onToggle(key)}
          >
            <Checkbox
              checked={checked}
              onCheckedChange={() => onToggle(key)}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  {ticketTypeLabel(t.ticketType)}
                </Badge>
                {t.ticketNumber && (
                  <span className="text-xs text-gray-500">#{t.ticketNumber}</span>
                )}
              </div>
              <p className="text-sm font-medium text-gray-900 mt-1 truncate">{t.description}</p>
              {t.workDate && (
                <p className="text-xs text-gray-400">
                  {new Date(t.workDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-bold text-gray-900">{formatCurrency(t.totalAmount)}</p>
              <p className="text-xs text-gray-400">
                P: {formatCurrency(t.partsSubtotal)} / L: {formatCurrency(t.laborSubtotal)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Step 2: Correct ────────────────────────────────────────────────────────

function CorrectStep({
  selectedTickets,
  lines,
  onLinesChange,
  originalInvoiceTotal,
}: {
  selectedTickets: Ticket[];
  lines: CorrectionLine[];
  onLinesChange: (lines: CorrectionLine[]) => void;
  originalInvoiceTotal: string;
}) {
  const correctedTotal = useMemo(() => {
    let total = parseFloat(originalInvoiceTotal);
    for (const ticket of selectedTickets) {
      const line = lines.find(
        (l) => l.ticketType === ticket.ticketType && l.ticketId === ticket.ticketId,
      );
      if (!line) continue;
      const before = parseFloat(ticket.totalAmount);
      const after = line.action === "exclude" ? 0 : parseFloat(line.afterTotal ?? ticket.totalAmount);
      total = total - before + after;
    }
    return total;
  }, [lines, selectedTickets, originalInvoiceTotal]);

  const updateLine = (ticketType: Ticket["ticketType"], ticketId: number, update: Partial<CorrectionLine>) => {
    onLinesChange(
      lines.map((l) =>
        l.ticketType === ticketType && l.ticketId === ticketId ? { ...l, ...update } : l,
      ),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-200">
        <span className="text-sm text-blue-700 font-medium">Corrected Invoice Total</span>
        <span className="text-lg font-bold text-blue-800">{formatCurrency(correctedTotal)}</span>
      </div>
      <p className="text-sm text-gray-500">Original: {formatCurrency(originalInvoiceTotal)}</p>

      {selectedTickets.map((ticket) => {
        const line = lines.find(
          (l) => l.ticketType === ticket.ticketType && l.ticketId === ticket.ticketId,
        ) ?? {
          ticketType: ticket.ticketType,
          ticketId: ticket.ticketId,
          action: "adjust" as const,
          beforeTotal: ticket.totalAmount,
          afterTotal: ticket.totalAmount,
        };

        return (
          <div key={`${ticket.ticketType}:${ticket.ticketId}`} className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">{ticketTypeLabel(ticket.ticketType)}</Badge>
              {ticket.ticketNumber && <span className="text-xs text-gray-500">#{ticket.ticketNumber}</span>}
              <span className="text-sm font-medium text-gray-900 truncate flex-1">{ticket.description}</span>
              <span className="text-sm font-bold text-gray-700 shrink-0">{formatCurrency(ticket.totalAmount)}</span>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Action</label>
              <Select
                value={line.action}
                onValueChange={(v) =>
                  updateLine(ticket.ticketType, ticket.ticketId, {
                    action: v as CorrectionLine["action"],
                    afterTotal: v === "exclude" ? "0.00" : ticket.totalAmount,
                    afterParts: v === "exclude" ? "0.00" : ticket.partsSubtotal,
                    afterLabor: v === "exclude" ? "0.00" : ticket.laborSubtotal,
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINE_ACTIONS.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {line.action === "adjust" && (
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Corrected Parts ($)</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.afterParts ?? ticket.partsSubtotal}
                    onChange={(e) => {
                      const parts = parseFloat(e.target.value) || 0;
                      const labor = parseFloat(line.afterLabor ?? ticket.laborSubtotal) || 0;
                      updateLine(ticket.ticketType, ticket.ticketId, {
                        afterParts: e.target.value,
                        afterTotal: (parts + labor).toFixed(2),
                      });
                    }}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Corrected Labor ($)</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.afterLabor ?? ticket.laborSubtotal}
                    onChange={(e) => {
                      const parts = parseFloat(line.afterParts ?? ticket.partsSubtotal) || 0;
                      const labor = parseFloat(e.target.value) || 0;
                      updateLine(ticket.ticketType, ticket.ticketId, {
                        afterLabor: e.target.value,
                        afterTotal: (parts + labor).toFixed(2),
                      });
                    }}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">New Total ($)</label>
                  <Input
                    readOnly
                    value={line.afterTotal ?? ticket.totalAmount}
                    className="bg-gray-50"
                  />
                </div>
              </div>
            )}

            {line.action === "zero_line" && (
              <div className="text-sm text-amber-700 bg-amber-50 rounded p-2">
                This ticket will be zeroed out — all amounts set to $0.00.
              </div>
            )}

            {line.action === "exclude" && (
              <div className="text-sm text-red-700 bg-red-50 rounded p-2">
                This ticket will be excluded from the reissued invoice entirely.
              </div>
            )}

            <div>
              <label className="text-xs text-gray-500 block mb-1">Line Note (optional)</label>
              <Input
                placeholder="Reason for this specific line change…"
                value={line.lineNote ?? ""}
                onChange={(e) =>
                  updateLine(ticket.ticketType, ticket.ticketId, { lineNote: e.target.value })
                }
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Step 3: Document ────────────────────────────────────────────────────────

interface DocumentFields {
  reasonCategory: string;
  requestSource: string;
  requestedBy: string;
  reasonDetail: string;
  evidenceUrl: string;
  evidenceNote: string;
}

function DocumentStep({
  fields,
  onChange,
}: {
  fields: DocumentFields;
  onChange: (fields: DocumentFields) => void;
}) {
  const set = (key: keyof DocumentFields, value: string) =>
    onChange({ ...fields, [key]: value });

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Document why this correction is being made. This information is permanently auditable.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-gray-700 block mb-1">
            Reason Category <span className="text-red-500">*</span>
          </label>
          <Select
            value={fields.reasonCategory}
            onValueChange={(v) => set("reasonCategory", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select reason…" />
            </SelectTrigger>
            <SelectContent>
              {REASON_CATEGORIES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-700 block mb-1">
            Request Source <span className="text-red-500">*</span>
          </label>
          <Select
            value={fields.requestSource}
            onValueChange={(v) => set("requestSource", v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="How was it received?" />
            </SelectTrigger>
            <SelectContent>
              {REQUEST_SOURCES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-gray-700 block mb-1">
          Requested By <span className="text-red-500">*</span>
        </label>
        <Input
          placeholder="Customer name or contact…"
          value={fields.requestedBy}
          onChange={(e) => set("requestedBy", e.target.value)}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-gray-700 block mb-1">
          Reason Detail <span className="text-red-500">*</span>
        </label>
        <Textarea
          placeholder="Explain the dispute or reason for correction in full…"
          rows={4}
          value={fields.reasonDetail}
          onChange={(e) => set("reasonDetail", e.target.value)}
        />
      </div>

      <div className="border-t pt-3">
        <p className="text-xs font-medium text-gray-700 mb-2">Evidence (optional)</p>
        <div className="space-y-2">
          <Input
            placeholder="Evidence URL (screenshot, email, document link…)"
            value={fields.evidenceUrl}
            onChange={(e) => set("evidenceUrl", e.target.value)}
          />
          <Input
            placeholder="Evidence note…"
            value={fields.evidenceNote}
            onChange={(e) => set("evidenceNote", e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

// ── Step 4: Review ─────────────────────────────────────────────────────────

function ReviewStep({
  invoice,
  selectedTickets,
  lines,
  docFields,
}: {
  invoice: Invoice;
  selectedTickets: Ticket[];
  lines: CorrectionLine[];
  docFields: DocumentFields;
}) {
  const correctedTotal = useMemo(() => {
    let total = parseFloat(invoice.totalAmount);
    for (const ticket of selectedTickets) {
      const line = lines.find(
        (l) => l.ticketType === ticket.ticketType && l.ticketId === ticket.ticketId,
      );
      if (!line) continue;
      const before = parseFloat(ticket.totalAmount);
      const after = line.action === "exclude" ? 0 : parseFloat(line.afterTotal ?? ticket.totalAmount);
      total = total - before + after;
    }
    return total;
  }, [lines, selectedTickets, invoice.totalAmount]);

  const delta = correctedTotal - parseFloat(invoice.totalAmount);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Financial Summary
        </div>
        <div className="p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Original Total</span>
            <span className="font-medium">{formatCurrency(invoice.totalAmount)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Corrected Total</span>
            <span className="font-bold text-blue-700">{formatCurrency(correctedTotal)}</span>
          </div>
          <div className="flex justify-between text-sm border-t pt-2">
            <span className="text-gray-600">Adjustment</span>
            <span
              className={`font-bold ${delta < 0 ? "text-emerald-600" : delta > 0 ? "text-amber-600" : "text-gray-500"}`}
            >
              {delta >= 0 ? "+" : ""}{formatCurrency(delta)}
            </span>
          </div>
        </div>
      </div>

      {selectedTickets.length > 0 && (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Ticket Changes
          </div>
          <div className="divide-y">
            {selectedTickets.map((ticket) => {
              const line = lines.find(
                (l) => l.ticketType === ticket.ticketType && l.ticketId === ticket.ticketId,
              );
              const afterTotal =
                line?.action === "exclude"
                  ? 0
                  : line?.action === "zero_line"
                  ? 0
                  : parseFloat(line?.afterTotal ?? ticket.totalAmount);
              return (
                <div key={`${ticket.ticketType}:${ticket.ticketId}`} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs text-gray-400">{ticketTypeLabel(ticket.ticketType)}</span>
                      {ticket.ticketNumber && (
                        <span className="text-xs text-gray-400 ml-1">#{ticket.ticketNumber}</span>
                      )}
                      <p className="font-medium text-gray-800 truncate max-w-xs">{ticket.description}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-gray-400 text-xs line-through">{formatCurrency(ticket.totalAmount)}</p>
                      <p className={`font-bold ${line?.action === "exclude" || line?.action === "zero_line" ? "text-red-600" : "text-blue-700"}`}>
                        {formatCurrency(afterTotal)}
                      </p>
                    </div>
                  </div>
                  {line?.lineNote && (
                    <p className="text-xs text-gray-500 mt-1 italic">"{line.lineNote}"</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Reason & Evidence
        </div>
        <div className="p-4 space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="text-gray-500 w-28 shrink-0">Category:</span>
            <span className="font-medium text-gray-800">
              {REASON_CATEGORIES.find((r) => r.value === docFields.reasonCategory)?.label ?? docFields.reasonCategory}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 w-28 shrink-0">Source:</span>
            <span className="font-medium text-gray-800">
              {REQUEST_SOURCES.find((r) => r.value === docFields.requestSource)?.label ?? docFields.requestSource}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 w-28 shrink-0">Requested by:</span>
            <span className="font-medium text-gray-800">{docFields.requestedBy}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-500 w-28 shrink-0">Detail:</span>
            <span className="text-gray-700 break-words">{docFields.reasonDetail}</span>
          </div>
          {docFields.evidenceUrl && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-28 shrink-0">Evidence:</span>
              <a
                href={docFields.evidenceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline break-all"
              >
                {docFields.evidenceUrl}
              </a>
            </div>
          )}
          {docFields.evidenceNote && (
            <div className="flex gap-2">
              <span className="text-gray-500 w-28 shrink-0">Evidence note:</span>
              <span className="text-gray-700">{docFields.evidenceNote}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step 5: Reissue ────────────────────────────────────────────────────────

function ReissueStep({
  invoice,
  correctionId,
  reissuedInvoice,
  onReissue,
  isReissuing,
  qbSyncState,
  qbSyncError,
  qbSyncCode,
  onQbSync,
  isQbSyncing,
}: {
  invoice: Invoice;
  correctionId: number | null;
  reissuedInvoice: { id: number; invoiceNumber: string; totalAmount: string; revision: number } | null;
  onReissue: () => void;
  isReissuing: boolean;
  qbSyncState: "idle" | "synced" | "failed";
  qbSyncError: string | null;
  qbSyncCode: string | null;
  onQbSync: () => void;
  isQbSyncing: boolean;
}) {
  if (reissuedInvoice) {
    return (
      <div className="space-y-4 text-center py-4">
        <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
        <h3 className="text-lg font-semibold text-gray-900">Invoice Reissued</h3>
        <p className="text-gray-600 text-sm">
          Rev {reissuedInvoice.revision} at the same number (
          <strong>#{reissuedInvoice.invoiceNumber}</strong>) — corrected total{" "}
          <strong>{formatCurrency(reissuedInvoice.totalAmount)}</strong>.
        </p>
        <p className="text-gray-600 text-sm">
          Previous version kept as history, excluded from totals.
        </p>

        {qbSyncState === "synced" ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800 text-left flex gap-2 items-start">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              QuickBooks updated — invoice #{reissuedInvoice.invoiceNumber},{" "}
              {formatCurrency(reissuedInvoice.totalAmount)}.
            </span>
          </div>
        ) : qbSyncState === "failed" ? (
          <div className="space-y-2">
            {qbSyncCode === "QB_AUTH_EXPIRED" ? (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 text-left space-y-2">
                <div className="flex gap-2 items-start">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    <strong>QuickBooks session expired.</strong> Reconnect QuickBooks in Settings, then retry the update here.
                  </span>
                </div>
                <a
                  href="/quickbooks"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700"
                >
                  Go to QuickBooks Settings →
                </a>
              </div>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700 text-left">
                <strong>QuickBooks update failed.</strong>{" "}
                {qbSyncError ?? "Unknown error."} The app-side reissue is saved — retry when ready.
              </div>
            )}
            <Button
              onClick={onQbSync}
              disabled={isQbSyncing}
              variant="outline"
              className="w-full"
            >
              {isQbSyncing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Updating QuickBooks…
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Retry QuickBooks Update
                </>
              )}
            </Button>
          </div>
        ) : (
          <Button
            onClick={onQbSync}
            disabled={isQbSyncing}
            className="w-full bg-blue-600 hover:bg-blue-700"
          >
            {isQbSyncing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Updating QuickBooks…
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                Update QuickBooks
              </>
            )}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        You are about to reissue invoice <strong>#{invoice.invoiceNumber}</strong>.
      </p>
      <ul className="space-y-2 text-sm">
        <li className="flex gap-2 text-gray-700">
          <CheckCircle2 className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
          Rev N at the same number (<strong>#{invoice.invoiceNumber}</strong>) — same invoice
          number, corrected amount, no suffix.
        </li>
        <li className="flex gap-2 text-gray-700">
          <CheckCircle2 className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
          Previous version kept as history, excluded from totals.
        </li>
        <li className="flex gap-2 text-gray-700">
          <CheckCircle2 className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
          All correction data permanently recorded for audit purposes.
        </li>
        <li className="flex gap-2 text-blue-700">
          <CheckCircle2 className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
          QuickBooks will be updated in place — same invoice, corrected amount, no duplicate.
        </li>
      </ul>
      <Button
        onClick={onReissue}
        disabled={isReissuing || correctionId == null}
        className="w-full bg-blue-600 hover:bg-blue-700"
      >
        {isReissuing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Reissuing…
          </>
        ) : (
          <>
            <RefreshCw className="w-4 h-4 mr-2" />
            Confirm Reissue
          </>
        )}
      </Button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface InvoiceCorrectionFlowProps {
  invoice: Invoice;
  open: boolean;
  onClose: () => void;
}

export function InvoiceCorrectionFlow({
  invoice,
  open,
  onClose,
}: InvoiceCorrectionFlowProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>(1);
  const [completedSteps, setCompletedSteps] = useState<Set<Step>>(new Set());
  const [correctionId, setCorrectionId] = useState<number | null>(null);
  const [selectedTicketKeys, setSelectedTicketKeys] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<CorrectionLine[]>([]);
  const [docFields, setDocFields] = useState<DocumentFields>({
    reasonCategory: "",
    requestSource: "",
    requestedBy: "",
    reasonDetail: "",
    evidenceUrl: "",
    evidenceNote: "",
  });
  const [reissuedInvoice, setReissuedInvoice] = useState<{
    id: number;
    invoiceNumber: string;
    totalAmount: string;
    revision: number;
  } | null>(null);
  const [qbSyncState, setQbSyncState] = useState<"idle" | "synced" | "failed">("idle");
  const [qbSyncError, setQbSyncError] = useState<string | null>(null);
  const [qbSyncCode, setQbSyncCode] = useState<string | null>(null);
  const [partialPaymentBlocked, setPartialPaymentBlocked] = useState(false);

  // Fetch tickets for this invoice.
  const { data: ticketsData, isLoading: ticketsLoading } = useQuery<{
    invoiceId: number;
    tickets: Ticket[];
  }>({
    queryKey: ["/api/invoices", invoice.id, "correction-tickets"],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${invoice.id}/correction-tickets`);
      if (!res.ok) throw new Error("Failed to load tickets");
      return res.json();
    },
    enabled: open,
  });

  const tickets = ticketsData?.tickets ?? [];

  // Reset state when closed.
  useEffect(() => {
    if (!open) {
      setStep(1);
      setCompletedSteps(new Set());
      setCorrectionId(null);
      setSelectedTicketKeys(new Set());
      setLines([]);
      setDocFields({
        reasonCategory: "",
        requestSource: "",
        requestedBy: "",
        reasonDetail: "",
        evidenceUrl: "",
        evidenceNote: "",
      });
      setReissuedInvoice(null);
      setQbSyncState("idle");
      setQbSyncError(null);
      setQbSyncCode(null);
      setPartialPaymentBlocked(false);
    }
  }, [open]);

  const selectedTickets = useMemo(
    () =>
      tickets.filter((t) => selectedTicketKeys.has(`${t.ticketType}:${t.ticketId}`)),
    [tickets, selectedTicketKeys],
  );

  // Open correction mutation (creates draft).
  const openMutation = useMutation({
    mutationFn: () => apiRequest("/api/invoice-corrections", "POST", { invoiceId: invoice.id }),
    onSuccess: (data: any) => {
      setCorrectionId(data.correction.id);
    },
    onError: (err: Error) => {
      const code = parseApiErrorCode(err);
      if (code === "PARTIALLY_PAID_RECONCILE_IN_QBO") {
        setPartialPaymentBlocked(true);
      } else {
        toast({ title: "Failed to open correction", description: err.message, variant: "destructive" });
      }
    },
  });

  // Update correction (save lines + doc fields).
  const updateMutation = useMutation({
    mutationFn: (body: object) =>
      apiRequest(`/api/invoice-corrections/${correctionId}`, "PATCH", body),
    onError: (err: Error) => {
      toast({ title: "Failed to save correction", description: err.message, variant: "destructive" });
    },
  });

  // Cancel correction (no body needed — just a POST to the cancel endpoint).

  const handleCancel = async () => {
    if (correctionId) {
      try {
        await fetch(`/api/invoice-corrections/${correctionId}/cancel`, { method: "POST" });
      } catch {}
    }
    onClose();
  };

  // Reissue mutation.
  const reissueMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/invoice-corrections/${correctionId}/reissue`, "POST"),
    onSuccess: (data: any) => {
      setReissuedInvoice(data.reissuedInvoice);
      setCompletedSteps((prev) => new Set([...prev, 5]));
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
      toast({ title: "Invoice reissued successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Reissue failed", description: err.message, variant: "destructive" });
    },
  });

  // QuickBooks sync mutation — deliberate user action after reissue.
  const qbSyncMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/invoice-corrections/${correctionId}/qb-sync`, "POST"),
    onSuccess: () => {
      setQbSyncState("synced");
      setQbSyncError(null);
      setQbSyncCode(null);
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
    onError: (err: Error) => {
      setQbSyncState("failed");
      setQbSyncError(err.message);
      setQbSyncCode(parseApiErrorCode(err));
    },
  });

  const toggleTicket = (key: string) => {
    setSelectedTicketKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Handle stepping forward.
  const canProceed = () => {
    switch (step) {
      case 1:
        return selectedTicketKeys.size > 0;
      case 2:
        return lines.length > 0;
      case 3:
        return (
          !!docFields.reasonCategory &&
          !!docFields.requestSource &&
          !!docFields.requestedBy.trim() &&
          !!docFields.reasonDetail.trim()
        );
      case 4:
        return true;
      case 5:
        return !reissuedInvoice;
    }
  };

  const handleNext = async () => {
    switch (step) {
      case 1: {
        // Initialize lines from selected tickets (preserve any existing line values).
        const initialLines: CorrectionLine[] = selectedTickets.map((t) => {
          const existing = lines.find(
            (l) => l.ticketType === t.ticketType && l.ticketId === t.ticketId,
          );
          return (
            existing ?? {
              ticketType: t.ticketType,
              ticketId: t.ticketId,
              beforeParts: t.partsSubtotal,
              beforeLabor: t.laborSubtotal,
              beforeTotal: t.totalAmount,
              afterParts: t.partsSubtotal,
              afterLabor: t.laborSubtotal,
              afterTotal: t.totalAmount,
              action: "adjust" as const,
            }
          );
        });
        setLines(initialLines);

        // Open the correction draft if not already created.
        if (!correctionId) {
          await openMutation.mutateAsync();
        }
        break;
      }

      case 2: {
        // Save lines to backend.
        if (correctionId) {
          await updateMutation.mutateAsync({ lines });
        }
        break;
      }

      case 3: {
        // Save doc fields.
        if (correctionId) {
          await updateMutation.mutateAsync({
            status: "reviewed",
            reasonCategory: docFields.reasonCategory || undefined,
            requestSource: docFields.requestSource || undefined,
            requestedBy: docFields.requestedBy || undefined,
            reasonDetail: docFields.reasonDetail || undefined,
            evidenceUrl: docFields.evidenceUrl || undefined,
            evidenceNote: docFields.evidenceNote || undefined,
          });
        }
        break;
      }
    }

    setCompletedSteps((prev) => new Set([...prev, step]));
    setStep((prev) => Math.min(prev + 1, 5) as Step);
  };

  const handleBack = () => {
    setStep((prev) => Math.max(prev - 1, 1) as Step);
  };

  const isLoading =
    ticketsLoading ||
    openMutation.isPending ||
    updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCancel(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-600" />
            Correct &amp; Reissue Invoice #{invoice.invoiceNumber}
          </DialogTitle>
          <DialogDescription>
            {invoice.customerName} · {formatCurrency(invoice.totalAmount)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-1 py-2">
          <StepNav current={step} completedSteps={completedSteps} />

          <div className="min-h-[250px]">
            {ticketsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              </div>
            ) : step === 1 ? (
              <div className="space-y-4">
                {partialPaymentBlocked && (
                  <div className="flex gap-3 items-start rounded-lg border border-amber-300 bg-amber-50 p-4">
                    <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="space-y-1 text-sm">
                      <p className="font-semibold text-amber-900">
                        Partial payment recorded in QuickBooks
                      </p>
                      <p className="text-amber-800">
                        This invoice has a partial payment applied in QBO. Void or remove the payment
                        in QuickBooks first, then return here to correct the invoice.
                      </p>
                      <a
                        href="/quickbooks"
                        className="inline-flex items-center gap-1 text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700 mt-1"
                      >
                        Go to QuickBooks Settings →
                      </a>
                    </div>
                  </div>
                )}
                <DisputeStep
                  tickets={tickets}
                  selectedTicketIds={selectedTicketKeys}
                  onToggle={toggleTicket}
                />
              </div>
            ) : step === 2 ? (
              <CorrectStep
                selectedTickets={selectedTickets}
                lines={lines}
                onLinesChange={setLines}
                originalInvoiceTotal={invoice.totalAmount}
              />
            ) : step === 3 ? (
              <DocumentStep fields={docFields} onChange={setDocFields} />
            ) : step === 4 ? (
              <ReviewStep
                invoice={invoice}
                selectedTickets={selectedTickets}
                lines={lines}
                docFields={docFields}
              />
            ) : (
              <ReissueStep
                invoice={invoice}
                correctionId={correctionId}
                reissuedInvoice={reissuedInvoice}
                onReissue={() => reissueMutation.mutate()}
                isReissuing={reissueMutation.isPending}
                qbSyncState={qbSyncState}
                qbSyncError={qbSyncError}
                qbSyncCode={qbSyncCode}
                onQbSync={() => qbSyncMutation.mutate()}
                isQbSyncing={qbSyncMutation.isPending}
              />
            )}
          </div>
        </div>

        <DialogFooter className="flex items-center gap-2 pt-3 border-t">
          {!reissuedInvoice && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              className="mr-auto text-gray-500"
            >
              <X className="w-4 h-4 mr-1" />
              Cancel
            </Button>
          )}

          {step > 1 && !reissuedInvoice && (
            <Button variant="outline" onClick={handleBack} disabled={isLoading}>
              <ChevronLeft className="w-4 h-4 mr-1" />
              Back
            </Button>
          )}

          {step < 5 && (
            <Button
              onClick={handleNext}
              disabled={!canProceed() || isLoading}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Continue
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          )}

          {reissuedInvoice && (
            <Button onClick={onClose} className="bg-emerald-600 hover:bg-emerald-700">
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
