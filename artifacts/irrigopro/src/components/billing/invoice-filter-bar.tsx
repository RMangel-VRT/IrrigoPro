/**
 * The collapsed invoice filter bar (Task #1942).
 *
 * What was here before: twelve controls across two rows, permanently on
 * screen, most of them at their default value most of the time. What is here
 * now: one search box, one Filters button, and a chip for each filter that is
 * actually doing something.
 *
 * This is a presentation change only. Every control writes the same
 * `?param=` it wrote before, the server applies them exactly as it did, and a
 * link built with the old row still opens the same view — the chips are just
 * the first place the active ones become visible without opening anything.
 */

import { Filter, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AR_SORT_KEYS,
  AR_SORT_LABELS,
  REMINDER_FILTER_LABELS,
  describeActiveFilters,
  type ArQuery,
  type ArSortKey,
  type PaymentStatusFilter,
  type ReminderFilter,
  type SentFilter,
} from "@/lib/invoice-ar-query";

export function InvoiceFilterBar({
  searchTerm,
  onSearchChange,
  query,
  onPatch,
  onClearAll,
  hasActiveFilters,
  customerOptions,
  monthFilter,
  monthOptions,
  onMonthChange,
}: {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  query: ArQuery;
  onPatch: (patch: Partial<ArQuery>) => void;
  onClearAll: () => void;
  hasActiveFilters: boolean;
  customerOptions: { id: number; name: string }[];
  monthFilter: string;
  monthOptions: { value: string; label: string }[];
  onMonthChange: (value: string) => void;
}) {
  const chips = describeActiveFilters(query, (id) =>
    customerOptions.find((c) => String(c.id) === id)?.name,
  );
  const activeCount = chips.length + (monthFilter !== "all" ? 1 : 0);

  return (
    <div className="mb-4" data-testid="ar-filters">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            placeholder="Search invoice # or customer…"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
            aria-label="Search by invoice number or customer name"
            data-testid="invoice-search-input"
          />
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="sm:w-auto" data-testid="invoice-filters-button">
              <Filter className="mr-2 h-4 w-4" />
              Filters
              {activeCount > 0 && (
                <Badge className="ml-2 bg-blue-100 text-blue-800" data-testid="invoice-filters-count">
                  {activeCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[22rem] max-h-[70vh] overflow-y-auto">
            <div className="space-y-3">
              {/* Task #1942 — no Aging control here. The four cards above the
                  toolbar are where a bucket is chosen, and a second, differently
                  shaped control for the same `?aging=` parameter is exactly the
                  redundancy this layout exists to remove. Deep links and the
                  removable chip still carry the parameter. */}
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-gray-500">Payment</Label>
                <Select
                  value={query.paymentStatus}
                  onValueChange={(v) => onPatch({ paymentStatus: v as PaymentStatusFilter })}
                >
                  <SelectTrigger data-testid="ar-filter-payment-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any payment</SelectItem>
                    <SelectItem value="unpaid">Unpaid</SelectItem>
                    <SelectItem value="partially_paid">Partially paid</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <Label className="text-xs text-gray-500">Sent</Label>
                <Select value={query.sent} onValueChange={(v) => onPatch({ sent: v as SentFilter })}>
                  <SelectTrigger data-testid="ar-filter-sent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Sent or not</SelectItem>
                    <SelectItem value="sent">Sent</SelectItem>
                    <SelectItem value="unsent">Never sent</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Task #1887 — runs on the server, over the whole invoice set. */}
              <div className="flex flex-col gap-1">
                <Label className="text-xs text-gray-500">Reminders</Label>
                <Select
                  value={query.reminders}
                  onValueChange={(v) => onPatch({ reminders: v as ReminderFilter })}
                >
                  <SelectTrigger data-testid="ar-filter-reminders">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(REMINDER_FILTER_LABELS) as ReminderFilter[]).map((key) => (
                      <SelectItem key={key} value={key} data-testid={`ar-filter-reminders-${key}`}>
                        {REMINDER_FILTER_LABELS[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <Label className="text-xs text-gray-500">Customer</Label>
                <Select
                  value={query.customerId === "" ? "all" : query.customerId}
                  onValueChange={(v) => onPatch({ customerId: v === "all" ? "" : v })}
                >
                  <SelectTrigger data-testid="ar-filter-customer">
                    <SelectValue placeholder="All customers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All customers</SelectItem>
                    {customerOptions.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <Label className="text-xs text-gray-500">Billing month</Label>
                <Select value={monthFilter} onValueChange={onMonthChange}>
                  <SelectTrigger data-testid="ar-filter-month">
                    <SelectValue placeholder="All months" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All months</SelectItem>
                    {monthOptions.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-gray-500" htmlFor="ar-date-from">
                    Created from
                  </Label>
                  <Input
                    id="ar-date-from"
                    type="date"
                    value={query.dateFrom}
                    onChange={(e) => onPatch({ dateFrom: e.target.value })}
                    data-testid="ar-filter-date-from"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-gray-500" htmlFor="ar-date-to">
                    to
                  </Label>
                  <Input
                    id="ar-date-to"
                    type="date"
                    value={query.dateTo}
                    onChange={(e) => onPatch({ dateTo: e.target.value })}
                    data-testid="ar-filter-date-to"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-gray-500" htmlFor="ar-amount-min">
                    Amount min
                  </Label>
                  <Input
                    id="ar-amount-min"
                    type="number"
                    inputMode="decimal"
                    value={query.amountMin}
                    onChange={(e) => onPatch({ amountMin: e.target.value })}
                    data-testid="ar-filter-amount-min"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-gray-500" htmlFor="ar-amount-max">
                    Amount max
                  </Label>
                  <Input
                    id="ar-amount-max"
                    type="number"
                    inputMode="decimal"
                    value={query.amountMax}
                    onChange={(e) => onPatch({ amountMax: e.target.value })}
                    data-testid="ar-filter-amount-max"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Checkbox
                  id="ar-flagged-only"
                  checked={query.flagged}
                  onCheckedChange={(v) => onPatch({ flagged: v === true })}
                  data-testid="ar-filter-flagged"
                />
                <Label htmlFor="ar-flagged-only" className="text-sm text-gray-700">
                  Flagged only
                </Label>
              </div>

              {/* The A/R sort travels in the same URL as the filters, so it
                  lives beside them rather than only on a column header. */}
              <div className="flex flex-col gap-1 border-t pt-3">
                <Label className="text-xs text-gray-500">Sort by</Label>
                <div className="flex gap-2">
                  <Select
                    value={query.sort ?? "none"}
                    onValueChange={(v) =>
                      onPatch(v === "none" ? { sort: null } : { sort: v as ArSortKey })
                    }
                  >
                    <SelectTrigger data-testid="ar-sort-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Newest first (default)</SelectItem>
                      {AR_SORT_KEYS.map((key) => (
                        <SelectItem key={key} value={key} data-testid={`ar-sort-option-${key}`}>
                          {AR_SORT_LABELS[key]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!query.sort}
                    onClick={() => onPatch({ dir: query.dir === "desc" ? "asc" : "desc" })}
                    data-testid="ar-sort-direction"
                  >
                    {query.dir === "desc" ? "High → low" : "Low → high"}
                  </Button>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {(chips.length > 0 || monthFilter !== "all" || hasActiveFilters) && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="ar-filter-chips">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700"
              data-testid={`ar-filter-chip-${chip.key}`}
            >
              {chip.label}
              <button
                type="button"
                onClick={() => onPatch(chip.clear)}
                className="text-gray-400 hover:text-gray-700"
                aria-label={`Remove filter: ${chip.label}`}
                data-testid={`ar-filter-chip-remove-${chip.key}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {monthFilter !== "all" && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700"
              data-testid="ar-filter-chip-month"
            >
              {monthOptions.find((m) => m.value === monthFilter)?.label ?? monthFilter}
              <button
                type="button"
                onClick={() => onMonthChange("all")}
                className="text-gray-400 hover:text-gray-700"
                aria-label="Remove filter: billing month"
                data-testid="ar-filter-chip-remove-month"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {(hasActiveFilters || monthFilter !== "all") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-gray-500"
              onClick={onClearAll}
              data-testid="ar-filter-clear"
            >
              Clear all
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
