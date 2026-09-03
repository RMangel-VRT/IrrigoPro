import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { apiRequest } from "@/lib/queryClient";
import { PageContainer, PageContent, PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { 
  ClipboardPaste, CheckCircle2, AlertCircle, XCircle, 
  Info, Calendar, Copy, ChevronRight, Calculator,
  FileText
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Company } from "@workspace/db/schema";

type PreviewRow = {
  rowNumber: number;
  customerName: string;
  goalText: string;
  status: "matched" | "unchanged" | "unmatched" | "ambiguous" | "invalid";
  customerId: number | null;
  matchedCustomerName: string | null;
  goal: number | null;
  beforeGoal: number | null;
  reason: string | null;
  months: Array<{ month: number; amount: number; isManualOverride: boolean }>;
  preservedManualOverrides: number[];
};

type PreviewResponse = {
  year: number;
  companyId: number;
  rows: PreviewRow[];
  counts: {
    total: number;
    matched: number;
    unchanged: number;
    unmatched: number;
    ambiguous: number;
    invalid: number;
  };
  confirmationToken: string;
  confirmationExpiresAt: string;
};

type ConfirmResult = {
  rowNumber: number;
  customerName: string;
  customerId: number | null;
  outcome: "skipped" | "changed" | "failed";
  status: string;
  reason: string;
  beforeGoal?: number | string | null;
  afterGoal?: number | string | null;
  months?: Array<{ month: number; amount: number; isManualOverride?: boolean }>;
};

const formatCurrency = (amount: number | null | undefined) => {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
};

export default function AdminBudgetGoals() {
  const { user } = useAuth();
  const { toast } = useToast();
  
  const [year, setYear] = useState<string>(new Date().getFullYear().toString());
  const [text, setText] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState(
    user?.role === "company_admin" && user.companyId ? String(user.companyId) : "",
  );
  
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  
  const [isConfirming, setIsConfirming] = useState(false);
  const [results, setResults] = useState<ConfirmResult[] | null>(null);
  const { data: companies = [], isLoading: isLoadingCompanies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
    enabled: user?.role === "super_admin",
  });

  const targetCompanyId = user?.role === "super_admin"
    ? (selectedCompanyId ? Number(selectedCompanyId) : null)
    : (user?.companyId ?? null);

  const resetPreview = () => {
    setPreview(null);
    setResults(null);
  };

  const handlePreview = async () => {
    if (!text.trim()) {
      toast({ title: "Please paste your budget goals data", variant: "destructive" });
      return;
    }
    const numYear = parseInt(year, 10);
    if (isNaN(numYear) || numYear < 2000 || numYear > 2100) {
      toast({ title: "Please enter a valid year", variant: "destructive" });
      return;
    }
    if (!targetCompanyId) {
      toast({ title: "Choose a company", variant: "destructive" });
      return;
    }

    setIsPreviewing(true);
    setPreview(null);
    setResults(null);
    try {
      const res = await apiRequest("/api/admin/budget-goals/preview", "POST", {
        year: numYear,
        companyId: targetCompanyId,
        text,
      });
      setPreview(res);
    } catch (error: any) {
      toast({ 
        title: "Preview Failed", 
        description: error.message || "Could not preview data.",
        variant: "destructive" 
      });
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    
    setIsConfirming(true);
    try {
      const res = await apiRequest("/api/admin/budget-goals/confirm", "POST", {
        year: preview.year,
        companyId: preview.companyId,
        text,
        confirmationToken: preview.confirmationToken,
      });
      setResults(res.results);
      const changed = res.summary?.changed ?? res.results.filter((row: ConfirmResult) => row.outcome === "changed").length;
      toast({
        title: changed > 0 ? "Budget goals updated" : "No changes were needed",
        description: changed > 0 ? `${changed} customer goal${changed === 1 ? "" : "s"} updated.` : "Every row was skipped or unchanged.",
      });
    } catch (error: any) {
      toast({ 
        title: "Import Failed", 
        description: error.message || "An error occurred during import.",
        variant: "destructive" 
      });
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReset = () => {
    setText("");
    setPreview(null);
    setResults(null);
  };

  const copyResults = useCallback(() => {
    if (!results) return;
    const text = results.map(r => {
      const goals = r.afterGoal == null
        ? ""
        : ` | Goal: ${formatCurrency(r.beforeGoal == null ? null : Number(r.beforeGoal))} -> ${formatCurrency(Number(r.afterGoal))}`;
      const months = r.months?.length
        ? ` | Months: ${r.months.map((month) => `${new Date(2000, month.month - 1, 1).toLocaleString("en-US", { month: "short" })} ${formatCurrency(month.amount)}${month.isManualOverride ? " (manual)" : ""}`).join(", ")}`
        : "";
      return `Row ${r.rowNumber}: ${r.customerName} - ${r.outcome.toUpperCase()} (${r.status}) - ${r.reason}${goals}${months}`;
    }
    ).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied to clipboard" });
    });
  }, [results, toast]);

  if (user?.role !== "company_admin" && user?.role !== "super_admin") {
    return (
      <PageContainer>
        <PageContent>
          <div className="text-center py-16">
            <Calculator className="w-16 h-16 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Access Restricted</h3>
            <p className="text-slate-500">Only administrators can manage bulk budget goals.</p>
          </div>
        </PageContent>
      </PageContainer>
    );
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "matched": return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
      case "unchanged": return <Info className="w-4 h-4 text-slate-400" />;
      case "ambiguous": return <AlertCircle className="w-4 h-4 text-amber-500" />;
      case "unmatched": return <XCircle className="w-4 h-4 text-red-500" />;
      case "invalid": return <XCircle className="w-4 h-4 text-red-500" />;
      default: return <Info className="w-4 h-4 text-slate-400" />;
    }
  };

  const getOutcomeColor = (outcome: string) => {
    switch (outcome) {
      case "changed": return "text-emerald-700 bg-emerald-50 ring-emerald-200";
      case "skipped": return "text-slate-600 bg-slate-50 ring-slate-200";
      case "failed": return "text-red-700 bg-red-50 ring-red-200";
      default: return "text-slate-600 bg-slate-50 ring-slate-200";
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Annual Budget Planning"
        subtitle="Import and review annual goals from a spreadsheet"
      />

      <PageContent className="space-y-6 max-w-5xl mx-auto">
        {!preview && !results && (
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-sky-600" />
                Paste Budget Data
              </CardTitle>
              <CardDescription>
                Copy exactly two columns from Excel or Google Sheets: Customer Name and Annual Goal.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-32">
                  <label className="text-sm font-medium text-slate-700 mb-1.5 block">Target Year</label>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <Input
                      type="number"
                      value={year}
                      onChange={(e) => {
                        setYear(e.target.value);
                        resetPreview();
                      }}
                      className="pl-9"
                    />
                  </div>
                </div>
                {user.role === "super_admin" && (
                  <div className="min-w-64">
                    <label className="text-sm font-medium text-slate-700 mb-1.5 block">Company</label>
                    <Select
                      value={selectedCompanyId}
                      onValueChange={(value) => {
                        setSelectedCompanyId(value);
                        resetPreview();
                      }}
                      disabled={isLoadingCompanies}
                    >
                      <SelectTrigger aria-label="Company">
                        <SelectValue placeholder={isLoadingCompanies ? "Loading companies..." : "Choose a company"} />
                      </SelectTrigger>
                      <SelectContent>
                        {companies.map((company) => (
                          <SelectItem key={company.id} value={String(company.id)}>
                            {company.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 mb-1.5 block">Spreadsheet Data (TSV / CSV)</label>
                <Textarea
                  placeholder="Paste rows here..."
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    resetPreview();
                  }}
                  className="min-h-[240px] font-mono text-sm leading-relaxed whitespace-pre"
                  disabled={!targetCompanyId}
                />
              </div>

              <div className="flex justify-end">
                <Button 
                  onClick={handlePreview} 
                  disabled={isPreviewing || !text.trim() || !targetCompanyId}
                  className="btn-primary-gradient"
                >
                  <ClipboardPaste className="w-4 h-4 mr-2" />
                  {isPreviewing ? "Analyzing..." : "Preview Import"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {preview && !results && (
          <div className="space-y-6 animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-900">Preview Results for {preview.year}</h2>
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={() => setPreview(null)} disabled={isConfirming}>
                  Edit Data
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center">
                <div className="text-2xl font-bold text-emerald-600 mb-1">{preview.counts.matched}</div>
                <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Ready</div>
              </div>
              <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center">
                <div className="text-2xl font-bold text-slate-400 mb-1">{preview.counts.unchanged}</div>
                <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Unchanged</div>
              </div>
              <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center">
                <div className="text-2xl font-bold text-amber-500 mb-1">{preview.counts.ambiguous}</div>
                <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Ambiguous</div>
              </div>
              <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center">
                <div className="text-2xl font-bold text-red-500 mb-1">{preview.counts.unmatched}</div>
                <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Unmatched</div>
              </div>
              <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-sm flex flex-col items-center justify-center text-center">
                <div className="text-2xl font-bold text-red-500 mb-1">{preview.counts.invalid}</div>
                <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Invalid</div>
              </div>
            </div>

            {preview.counts.matched === 0 && (
              <div className="p-6 bg-amber-50 text-amber-800 rounded-xl border border-amber-200">
                <p className="font-medium">No updates ready to be applied.</p>
                <p className="text-sm mt-1 opacity-90">Please ensure customer names match exactly and goals are numeric.</p>
              </div>
            )}

            <Card className="border-slate-200 shadow-sm overflow-hidden bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-slate-600">Row</th>
                      <th className="px-4 py-3 font-semibold text-slate-600">Customer</th>
                      <th className="px-4 py-3 font-semibold text-slate-600">Goal</th>
                      <th className="px-4 py-3 font-semibold text-slate-600">Status & Context</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {[...preview.rows].sort((left, right) => {
                      const leftException = left.status === "matched" || left.status === "unchanged" ? 1 : 0;
                      const rightException = right.status === "matched" || right.status === "unchanged" ? 1 : 0;
                      return leftException - rightException || left.rowNumber - right.rowNumber;
                    }).map((row) => (
                      <tr key={row.rowNumber} className={cn("hover:bg-slate-50/50", row.status !== "matched" && row.status !== "unchanged" && "bg-red-50/20")}>
                        <td className="px-4 py-4 align-top text-slate-500 font-medium">#{row.rowNumber}</td>
                        <td className="px-4 py-4 align-top">
                          <div className="font-medium text-slate-900">{row.customerName || "(Blank)"}</div>
                          {row.customerId && (
                            <a
                              href={`/customers/${row.customerId}/profile#budget`}
                              className="mt-1 inline-block text-xs font-medium text-sky-700 hover:underline"
                            >
                              Open customer budget
                            </a>
                          )}
                          {row.matchedCustomerName && row.matchedCustomerName !== row.customerName && (
                            <div className="text-xs text-emerald-600 mt-0.5">Matched as: {row.matchedCustomerName}</div>
                          )}
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="font-medium text-slate-900">{formatCurrency(row.goal)}</div>
                          {row.beforeGoal !== null && row.beforeGoal !== row.goal && (
                            <div className="text-xs text-slate-400 line-through mt-0.5">{formatCurrency(row.beforeGoal)}</div>
                          )}
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="flex items-start gap-2">
                            <div className="mt-0.5 shrink-0">{getStatusIcon(row.status)}</div>
                            <div className="space-y-1">
                              <span className={cn(
                                "capitalize text-xs font-bold tracking-wider",
                                row.status === "matched" ? "text-emerald-600" :
                                row.status === "unchanged" ? "text-slate-500" :
                                row.status === "ambiguous" ? "text-amber-600" : "text-red-600"
                              )}>
                                {row.status}
                              </span>
                              {row.reason && (
                                <p className="text-slate-600 leading-snug">{row.reason}</p>
                              )}
                              {row.months && row.months.length > 0 && (
                                <div className="flex flex-wrap gap-1 pt-1" aria-label={`Seasonal amounts for ${row.customerName}`}>
                                  {row.months.map((month) => (
                                    <span
                                      key={month.month}
                                      className={cn(
                                        "rounded border px-1.5 py-0.5 text-[11px] font-medium",
                                        month.isManualOverride
                                          ? "border-amber-200 bg-amber-50 text-amber-800"
                                          : "border-slate-200 bg-slate-50 text-slate-600",
                                      )}
                                    >
                                      {new Date(2000, month.month - 1, 1).toLocaleString("en-US", { month: "short" })} {formatCurrency(month.amount)}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {row.preservedManualOverrides && row.preservedManualOverrides.length > 0 && (
                                <p className="text-xs text-amber-600 font-medium bg-amber-50 inline-block px-1.5 py-0.5 rounded">
                                  Preserved {row.preservedManualOverrides.length} manual {row.preservedManualOverrides.length === 1 ? 'override' : 'overrides'}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card className="border-sky-200 bg-sky-50/70 shadow-sm">
              <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-slate-900">Ready to update {preview.counts.matched} customer{preview.counts.matched === 1 ? "" : "s"}</p>
                  <p className="text-sm text-slate-600">Only rows marked matched will be changed. Every other row will be recorded as skipped.</p>
                </div>
                <Button
                  onClick={handleConfirm}
                  disabled={isConfirming || preview.counts.matched === 0}
                  className="btn-primary-gradient shrink-0"
                >
                  {isConfirming ? "Confirming..." : `Confirm ${preview.counts.matched} Updates`}
                  {!isConfirming && <ChevronRight className="w-4 h-4 ml-1" />}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {results && (
          <div className="space-y-6 animate-slide-up">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-900">Import Complete</h2>
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={copyResults}>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Log
                </Button>
                <Button onClick={handleReset} className="btn-primary-gradient">
                  Import More
                </Button>
              </div>
            </div>

            <Card className="border-slate-200 shadow-sm overflow-hidden bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-slate-600 w-16">Row</th>
                      <th className="px-4 py-3 font-semibold text-slate-600">Customer</th>
                      <th className="px-4 py-3 font-semibold text-slate-600 w-24">Outcome</th>
                      <th className="px-4 py-3 font-semibold text-slate-600">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {results.map((r, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/50">
                        <td className="px-4 py-4 align-top text-slate-500 font-medium">#{r.rowNumber}</td>
                        <td className="px-4 py-4 align-top font-medium text-slate-900">
                          {r.customerName || "(Blank)"}
                        </td>
                        <td className="px-4 py-4 align-top">
                          <span className={cn(
                            "inline-flex items-center px-2 py-1 rounded-md text-xs font-semibold ring-1 ring-inset uppercase tracking-wider",
                            getOutcomeColor(r.outcome)
                          )}>
                            {r.outcome}
                          </span>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="text-slate-600 leading-snug">{r.reason}</div>
                          {r.afterGoal != null && (
                            <div className="mt-1 text-xs font-medium text-slate-700">
                              Goal: {formatCurrency(r.beforeGoal == null ? null : Number(r.beforeGoal))} to {formatCurrency(Number(r.afterGoal))}
                            </div>
                          )}
                          {r.months && r.months.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {r.months.map((month) => (
                                <span
                                  key={month.month}
                                  className={cn(
                                    "rounded border px-1.5 py-0.5 text-[11px]",
                                    month.isManualOverride
                                      ? "border-amber-200 bg-amber-50 text-amber-800"
                                      : "border-slate-200 bg-slate-50 text-slate-600",
                                  )}
                                >
                                  {new Date(2000, month.month - 1, 1).toLocaleString("en-US", { month: "short" })} {formatCurrency(month.amount)}
                                  {month.isManualOverride ? " manual" : ""}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </PageContent>
    </PageContainer>
  );
}
