import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { 
  ArrowLeft, 
  RefreshCw, 
  MapPinOff, 
  Lock, 
  AlertTriangle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageContainer, PageContent, PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function useDebounce<T>(value: T, delay?: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay || 500);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

interface Row {
  ticketType: 'work_order' | 'billing_sheet';
  ticketId: number;
  ticketNumber: string;
  customerName: string;
  branchName: string | null;
  technicianId: number | null;
  technicianName: string;
  workDate: string | null;
  status: string;
  violations: string[];
  confidence: 'high' | 'low' | 'unknown';
  companyId: number | null;
  companyName: string | null;
  canonicalPath: string;
}

interface ReportResponse {
  count: number;
  rows: Row[];
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

function sourceLabel(source: string): string {
  return source === "billing_sheet" ? "BS" : source === "work_order" ? "WO" : source;
}

const violationLabels: Record<string, string> = {
  pin_missing: "Pin missing",
  work_type_missing: "Work type missing",
  controller_missing: "Controller missing",
  zone_missing: "Zone missing",
  details_missing: "Details missing",
};

function ConfidenceBadge({ level }: { level: Row['confidence'] }) {
  switch (level) {
    case 'high':
      return <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 hover:bg-emerald-200 border-transparent shadow-none">High</Badge>;
    case 'low':
      return <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-200 border-transparent shadow-none">Low</Badge>;
    default:
      return <Badge variant="secondary" className="bg-slate-100 text-slate-800 hover:bg-slate-200 border-transparent shadow-none capitalize">{level}</Badge>;
  }
}

export default function MissingLocationDataReportPage() {
  const [ticketType, setTicketType] = useState<string>("all");
  const [technicianInput, setTechnicianInput] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [lowConfidenceOnly, setLowConfidenceOnly] = useState<boolean>(false);

  const debouncedTechnician = useDebounce(technicianInput, 400);

  const queryUrl = (() => {
    const qs = new URLSearchParams();
    if (ticketType && ticketType !== "all") qs.set("ticketType", ticketType);
    if (debouncedTechnician) qs.set("technician", debouncedTechnician);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (lowConfidenceOnly) qs.set("lowConfidenceOnly", "true");
    
    const params = qs.toString();
    return `/api/reports/missing-location-data${params ? `?${params}` : ""}`;
  })();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ReportResponse>({
    queryKey: [queryUrl],
  });

  const isForbidden = isError && error instanceof Error && /^403[:\s]/.test(error.message);

  const rows = data?.rows ?? [];
  const count = data?.count ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title="Missing Location Data Report"
        subtitle="Audit work orders and billing sheets with missing requirements or low-confidence manual pins."
      />
      
      <PageContent>
        <div className="flex flex-wrap items-center justify-between mb-4 gap-4">
          <Link href="/" className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-report"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Card className="mb-4 shadow-sm border-slate-200">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-full sm:w-auto flex-1 min-w-[150px]">
                <Label htmlFor="ticket-type" className="text-xs font-medium text-slate-500 mb-2 block">Ticket Type</Label>
                <Select value={ticketType} onValueChange={setTicketType}>
                  <SelectTrigger id="ticket-type" data-testid="select-ticket-type">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="work_order">Work Order</SelectItem>
                    <SelectItem value="billing_sheet">Billing Sheet</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-full sm:w-auto flex-1 min-w-[150px]">
                <Label htmlFor="technician" className="text-xs font-medium text-slate-500 mb-2 block">Technician</Label>
                <Input 
                  id="technician"
                  type="text" 
                  placeholder="Name or ID" 
                  value={technicianInput} 
                  onChange={(e) => setTechnicianInput(e.target.value)} 
                  data-testid="input-technician" 
                />
              </div>

              <div className="w-full sm:w-auto flex-1 min-w-[140px]">
                <Label htmlFor="from-date" className="text-xs font-medium text-slate-500 mb-2 block">From Date</Label>
                <Input 
                  id="from-date"
                  type="date" 
                  value={from} 
                  onChange={(e) => setFrom(e.target.value)} 
                  data-testid="input-from-date" 
                />
              </div>

              <div className="w-full sm:w-auto flex-1 min-w-[140px]">
                <Label htmlFor="to-date" className="text-xs font-medium text-slate-500 mb-2 block">To Date</Label>
                <Input 
                  id="to-date"
                  type="date" 
                  value={to} 
                  onChange={(e) => setTo(e.target.value)} 
                  data-testid="input-to-date" 
                />
              </div>

              <div className="w-full sm:w-auto flex items-center space-x-2 h-10 px-1">
                <Checkbox 
                  id="low-confidence" 
                  checked={lowConfidenceOnly} 
                  onCheckedChange={(c) => setLowConfidenceOnly(!!c)} 
                  data-testid="checkbox-low-confidence" 
                />
                <Label htmlFor="low-confidence" className="text-sm font-medium leading-none cursor-pointer">
                  Low confidence only
                </Label>
              </div>
              
              <div className="w-full sm:w-auto">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    setTicketType("all");
                    setTechnicianInput("");
                    setFrom("");
                    setTo("");
                    setLowConfidenceOnly(false);
                  }}
                  data-testid="button-clear-filters"
                >
                  Clear
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <Card>
            <CardContent className="py-8 space-y-3">
              <Skeleton className="h-6 w-1/3" />
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-6 w-1/2" />
            </CardContent>
          </Card>
        ) : isForbidden ? (
          <Card>
            <CardContent className="py-12 text-center" data-testid="report-no-access">
              <Lock className="w-12 h-12 text-slate-400 mx-auto mb-3" />
              <h3 className="text-lg font-semibold mb-1">You don't have permission to view this report</h3>
              <p className="text-sm text-slate-500 mb-4">
                This report is limited to authorized personnel.
              </p>
            </CardContent>
          </Card>
        ) : isError ? (
          <Card>
            <CardContent className="py-12 text-center text-red-600" data-testid="report-error">
              <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-3" />
              <h3 className="text-lg font-semibold mb-1 text-slate-900">Failed to load report data</h3>
              <p className="text-sm text-slate-500 mb-6">
                There was an error communicating with the server.
              </p>
              <Button variant="outline" onClick={() => refetch()} data-testid="button-retry-report">
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center" data-testid="report-empty">
              <MapPinOff className="w-12 h-12 text-emerald-500 mx-auto mb-3 opacity-80" />
              <h3 className="text-lg font-semibold mb-1 text-slate-900">All clear</h3>
              <p className="text-sm text-slate-500">
                No tickets are missing location data for the selected criteria.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="shadow-sm border-slate-200">
            <CardHeader className="bg-slate-50/50 border-b border-slate-100 py-4">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base text-slate-800">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                {count} {count === 1 ? 'ticket' : 'tickets'} missing location data
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-white border-b border-slate-200">
                    <tr>
                      <th className="p-3 font-semibold text-slate-600">Type</th>
                      <th className="p-3 font-semibold text-slate-600">Number</th>
                      <th className="p-3 font-semibold text-slate-600">Customer</th>
                      <th className="p-3 font-semibold text-slate-600">Company</th>
                      <th className="p-3 font-semibold text-slate-600">Date</th>
                      <th className="p-3 font-semibold text-slate-600">Technician</th>
                      <th className="p-3 font-semibold text-slate-600">Violations</th>
                      <th className="p-3 font-semibold text-slate-600">Confidence</th>
                      <th className="p-3 font-semibold text-slate-600">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r) => (
                      <tr key={`${r.ticketType}-${r.ticketId}`} className="hover:bg-slate-50/70 transition-colors group" data-testid={`row-ticket-${r.ticketId}`}>
                        <td className="p-3 align-top">
                          <Badge variant="secondary" className="font-mono text-[10px] uppercase tracking-wider bg-slate-100 text-slate-600 hover:bg-slate-200 border-none shadow-none mt-0.5">
                            {sourceLabel(r.ticketType)}
                          </Badge>
                        </td>
                        <td className="p-3 font-mono text-xs align-top pt-3.5">
                          <Link 
                            href={r.canonicalPath} 
                            className="text-blue-600 hover:text-blue-800 hover:underline font-medium" 
                            data-testid={`link-ticket-${r.ticketId}`}
                          >
                            {r.ticketNumber}
                          </Link>
                        </td>
                        <td className="p-3 align-top max-w-[200px]">
                          <div className="font-medium text-slate-900 truncate" title={r.customerName}>{r.customerName}</div>
                          {r.branchName && <div className="text-xs text-slate-500 truncate" title={r.branchName}>{r.branchName}</div>}
                        </td>
                        <td className="p-3 align-top text-slate-600 whitespace-nowrap">
                          {r.companyName ?? "—"}
                        </td>
                        <td className="p-3 text-slate-600 whitespace-nowrap align-top pt-3.5">{fmtDate(r.workDate)}</td>
                        <td className="p-3 text-slate-900 whitespace-nowrap align-top pt-3.5">
                          <div className="truncate max-w-[150px]" title={r.technicianName}>
                            {r.technicianName}
                          </div>
                          {r.technicianId && <div className="text-xs text-slate-400 font-mono">#{r.technicianId}</div>}
                        </td>
                        <td className="p-3 align-top">
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {r.violations.map(v => (
                              <Badge key={v} variant="outline" className="text-[10px] text-red-700 border-red-200 bg-red-50 font-normal py-0">
                                {violationLabels[v] ?? v.replace(/_/g, " ")}
                              </Badge>
                            ))}
                            {r.violations.length === 0 && <span className="text-slate-300 text-xs">—</span>}
                          </div>
                        </td>
                        <td className="p-3 align-top pt-3.5">
                          <ConfidenceBadge level={r.confidence} />
                        </td>
                        <td className="p-3 align-top pt-3.5">
                          <Badge variant="outline" className="capitalize text-slate-600 font-normal whitespace-nowrap">
                            {r.status.replace(/_/g, ' ')}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </PageContent>
    </PageContainer>
  );
}