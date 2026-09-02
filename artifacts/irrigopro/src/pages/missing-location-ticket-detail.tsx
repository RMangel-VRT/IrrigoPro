import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, AlertTriangle, MapPinOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageContainer, PageContent, PageHeader } from "@/components/ui/page-header";

type TicketType = "work_order" | "billing_sheet";

type Row = {
  ticketType: TicketType;
  ticketId: number;
  ticketNumber: string;
  customerName: string;
  branchName: string | null;
  technicianName: string;
  workDate: string | null;
  status: string;
  violations: string[];
  confidence: "high" | "low" | "unknown";
  companyName: string | null;
};

const violationLabels: Record<string, string> = {
  pin_missing: "Pin missing",
  work_type_missing: "Work type missing",
  controller_missing: "Controller missing",
  zone_missing: "Zone missing",
  details_missing: "Details missing",
};

function requestedTicketId(ticketType: TicketType): number | null {
  const key = ticketType === "work_order" ? "openWorkOrder" : "openSheet";
  const value = Number(new URLSearchParams(window.location.search).get(key));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export default function MissingLocationTicketDetail({
  ticketType,
}: {
  ticketType: TicketType;
}) {
  const ticketId = requestedTicketId(ticketType);
  const queryUrl = ticketId == null
    ? null
    : `/api/reports/missing-location-data?ticketType=${ticketType}&ticketId=${ticketId}`;
  const { data, isLoading, isError } = useQuery<{ rows: Row[] }>({
    queryKey: [queryUrl],
    enabled: queryUrl != null,
  });
  const row = data?.rows[0] ?? null;

  return (
    <PageContainer>
      <PageHeader
        title={row?.ticketNumber ?? "Location audit detail"}
        subtitle="Read-only ticket location policy findings."
      />
      <PageContent>
        <Button variant="outline" asChild className="mb-4">
          <Link href="/reports/missing-location-data">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Missing Location Data
          </Link>
        </Button>

        {ticketId == null ? (
          <Card>
            <CardContent className="py-12 text-center">
              <MapPinOff className="mx-auto mb-3 h-10 w-10 text-slate-400" />
              <p className="font-medium">Choose a ticket from the report.</p>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <Card><CardContent className="space-y-3 py-8">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-20 w-full" />
          </CardContent></Card>
        ) : isError ? (
          <Card><CardContent className="py-12 text-center text-red-700">
            <AlertTriangle className="mx-auto mb-3 h-10 w-10" />
            Unable to load this audit record.
          </CardContent></Card>
        ) : row == null ? (
          <Card><CardContent className="py-12 text-center">
            This ticket no longer has a location-policy finding, or it is not available to your company.
          </CardContent></Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {row.ticketNumber}
                <Badge variant="outline">{row.ticketType === "work_order" ? "Work order" : "Billing sheet"}</Badge>
                <Badge variant={row.confidence === "low" ? "destructive" : "secondary"}>
                  {row.confidence} confidence
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <div><p className="text-xs uppercase text-muted-foreground">Customer</p><p>{row.customerName}</p></div>
              <div><p className="text-xs uppercase text-muted-foreground">Branch</p><p>{row.branchName ?? "—"}</p></div>
              <div><p className="text-xs uppercase text-muted-foreground">Technician</p><p>{row.technicianName}</p></div>
              <div><p className="text-xs uppercase text-muted-foreground">Work date</p><p>{row.workDate ? new Date(row.workDate).toLocaleDateString() : "—"}</p></div>
              <div><p className="text-xs uppercase text-muted-foreground">Status</p><p className="capitalize">{row.status.replace(/_/g, " ")}</p></div>
              <div><p className="text-xs uppercase text-muted-foreground">Company</p><p>{row.companyName ?? "—"}</p></div>
              <div className="sm:col-span-2">
                <p className="mb-2 text-xs uppercase text-muted-foreground">Findings</p>
                <div className="flex flex-wrap gap-2">
                  {row.violations.length === 0 ? (
                    <Badge variant="outline">Low-confidence manual pin</Badge>
                  ) : row.violations.map((violation) => (
                    <Badge key={violation} variant="destructive">
                      {violationLabels[violation] ?? violation.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </PageContent>
    </PageContainer>
  );
}