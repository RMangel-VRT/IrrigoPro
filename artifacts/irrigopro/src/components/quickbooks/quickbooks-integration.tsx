import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { hasCapability, CAN_MANAGE_QUICKBOOKS } from "@workspace/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { 
  ExternalLink, 
  CheckCircle, 
  Clock, 
  AlertTriangle, 
  RefreshCw,
  Building,
  Calendar,
  DollarSign,
  ShieldAlert,
  Activity,
  XCircle,
  AlertCircle
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, adaptiveRefetchInterval, useArrayQuery } from "@/lib/queryClient";
import { format, formatDistanceToNow } from "date-fns";
import { formatEstimateNumber } from "@workspace/shared";

interface QuickBooksConnectionProps {
  className?: string;
}

interface QbConnectionStatus {
  companyId: string | null;
  companyName: string | null;
  isConnected: boolean;
  lastSync: string | null;
  connectionStatus?: string;
  reconnectRequiredReason?: string | null;
  error?: string;
}

interface QBConnectionHealth {
  realmId: string;
  companyId: string;
  connectionStatus: string;
  isTokenValid: boolean;
  tokenExpiresAt: string | null;
  tokenExpiresInMs: number | null;
  lastRefreshAttempt: string | null;
  lastRefreshSuccess: string | null;
  lastRefreshFailure: string | null;
  lastFailureReason: string | null;
  reconnectRequired: boolean;
  tokenEnvironment: string;
  updatedAt: string | null;
}

interface QBHealthResponse {
  connections: QBConnectionHealth[];
  count: number;
  checkedAt: string;
}

function ConnectionHealthPanel() {
  const { data: health, isLoading, refetch } = useQuery<QBHealthResponse>({
    queryKey: ["/api/quickbooks/health"],
    retry: false,
    throwOnError: false,
    // Task #532 — back off this 60s health poll on slow connections.
    // The hidden-tab pause is already handled globally by
    // refetchIntervalInBackground=false in queryClient defaults.
    refetchInterval: adaptiveRefetchInterval(60_000),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading connection health...
      </div>
    );
  }

  if (!health || !health.connections?.length) {
    return (
      <Alert>
        <Activity className="h-4 w-4" />
        <AlertDescription>
          No QuickBooks connections found. Connect an account to see health data.
        </AlertDescription>
      </Alert>
    );
  }

  const getStatusBadge = (conn: QBConnectionHealth) => {
    if (conn.reconnectRequired) {
      return <Badge className="bg-red-100 text-red-800"><ShieldAlert className="w-3 h-3 mr-1" />Reconnect Required</Badge>;
    }
    if (!conn.isTokenValid) {
      return <Badge className="bg-orange-100 text-orange-800"><XCircle className="w-3 h-3 mr-1" />Token Expired</Badge>;
    }
    if (conn.connectionStatus === "error") {
      return <Badge className="bg-red-100 text-red-800"><AlertTriangle className="w-3 h-3 mr-1" />Error</Badge>;
    }
    if (conn.connectionStatus === "connected") {
      return <Badge className="bg-green-100 text-green-800"><CheckCircle className="w-3 h-3 mr-1" />Healthy</Badge>;
    }
    return <Badge variant="outline">{conn.connectionStatus}</Badge>;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Checked {formatDistanceToNow(new Date(health.checkedAt), { addSuffix: true })}
        </span>
        <Button size="sm" variant="ghost" onClick={() => refetch()} className="h-6 px-2 text-xs">
          <RefreshCw className="w-3 h-3 mr-1" />
          Refresh
        </Button>
      </div>

      {health.connections.map((conn) => (
        <div key={conn.realmId} className="border rounded-lg p-3 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium">
              <Building className="w-4 h-4 text-muted-foreground" />
              <span className="font-mono text-xs">{conn.realmId}</span>
              <Badge variant="outline" className="text-xs">{conn.tokenEnvironment}</Badge>
            </div>
            {getStatusBadge(conn)}
          </div>

          <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3 flex-shrink-0" />
              <span>
                Token expires:{" "}
                {conn.tokenExpiresAt
                  ? `${format(new Date(conn.tokenExpiresAt), "MMM d, yyyy HH:mm")} (${
                      conn.tokenExpiresInMs != null
                        ? conn.tokenExpiresInMs > 0
                          ? `in ${Math.round(conn.tokenExpiresInMs / 60000)}m`
                          : `${Math.abs(Math.round(conn.tokenExpiresInMs / 60000))}m ago`
                        : "unknown"
                    })`
                  : "unknown"}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <CheckCircle className="w-3 h-3 flex-shrink-0 text-green-500" />
              <span>
                Last success:{" "}
                {conn.lastRefreshSuccess
                  ? formatDistanceToNow(new Date(conn.lastRefreshSuccess), { addSuffix: true })
                  : "never"}
              </span>
            </div>

            {conn.lastRefreshFailure && (
              <div className="flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 text-red-500 mt-0.5" />
                <span className="text-red-600">
                  Last failure:{" "}
                  {formatDistanceToNow(new Date(conn.lastRefreshFailure), { addSuffix: true })}
                  {conn.lastFailureReason && (
                    <span className="block text-red-500 font-mono text-xs mt-0.5 break-all">
                      {conn.lastFailureReason}
                    </span>
                  )}
                </span>
              </div>
            )}

            {conn.lastRefreshAttempt && (
              <div className="flex items-center gap-1">
                <Activity className="w-3 h-3 flex-shrink-0" />
                <span>
                  Last attempt:{" "}
                  {formatDistanceToNow(new Date(conn.lastRefreshAttempt), { addSuffix: true })}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

type ConnectErrorKind = "not_configured" | "oauth_failed" | "network" | "unknown";

interface ConnectError {
  kind: ConnectErrorKind;
  message: string;
}

/**
 * Parse the error thrown by apiRequest into a structured ConnectError.
 *
 * apiRequest throws `new Error(\`\${status}: \${bodyText}\`)` for HTTP errors
 * and a TypeError for fetch-level network failures.
 */
function parseConnectError(error: unknown): ConnectError {
  // Network / fetch failure — no HTTP response at all
  if (error instanceof TypeError) {
    return {
      kind: "network",
      message:
        "Could not reach the server. Check your internet connection and try again.",
    };
  }

  if (!(error instanceof Error)) {
    return { kind: "unknown", message: "An unexpected error occurred. Please try again." };
  }

  // Try to extract the status code and JSON body from the message
  const match = error.message.match(/^(\d+):\s*([\s\S]*)$/);
  if (!match) {
    return { kind: "unknown", message: error.message || "An unexpected error occurred." };
  }

  const status = parseInt(match[1], 10);
  const bodyText = match[2].trim();

  let serverMessage = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed?.message) serverMessage = parsed.message as string;
  } catch {
    // body wasn't JSON — use raw text
  }

  if (status === 400) {
    // Both "credentials" and "redirect URI" cases are configuration problems
    return {
      kind: "not_configured",
      message: serverMessage,
    };
  }

  if (status === 500) {
    return {
      kind: "oauth_failed",
      message:
        "The QuickBooks authorization request failed on the server. Please try again. " +
        "If this keeps happening, verify your Intuit app credentials in the Intuit Developer Portal.",
    };
  }

  return { kind: "unknown", message: serverMessage || "An unexpected error occurred." };
}

export function QuickBooksIntegration({ className }: QuickBooksConnectionProps) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<ConnectError | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const search = useSearch();

  // Read role + companyId from the session stored in localStorage.
  const { userRole, userCompanyId } = (() => {
    try {
      const u = JSON.parse(localStorage.getItem("user") || "{}");
      return { userRole: u.role as string | undefined, userCompanyId: String(u.companyId ?? "") };
    } catch {
      return { userRole: undefined, userCompanyId: "" };
    }
  })();

  // Task #1886 — mirrors the server gate on /api/quickbooks/connection/stale,
  // which moved from an inline company_admin / billing_manager allowlist to
  // CAN_MANAGE_QUICKBOOKS. Kept in step so the bookkeeper actually issues the
  // query she is now authorized to make.
  const { data: staleStatus } = useQuery<{ stale: boolean; count: number }>({
    queryKey: ["/api/quickbooks/connection/stale"],
    enabled: hasCapability(userRole, CAN_MANAGE_QUICKBOOKS),
    staleTime: 30_000,
    retry: false,
    throwOnError: false,
  });


  // Phase 5b — QB Harden #5: surface credential/env mismatch errors that were
  // forwarded from the OAuth callback via ?qb_connect_error=<message>.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const qbConnectError = params.get("qb_connect_error");
    if (!qbConnectError) return;

    toast({
      title: "QuickBooks Connection Failed",
      description: qbConnectError,
      variant: "destructive",
    });

    // Remove the param from the URL without adding a history entry.
    params.delete("qb_connect_error");
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
    window.history.replaceState(null, "", newUrl);
  }, [search, toast]);

  // Fetch QuickBooks connection status
  const { data: connectionStatus, isLoading: loadingConnection, error: connectionError } = useQuery<QbConnectionStatus>({
    queryKey: ["/api/quickbooks/connection"],
    enabled: true,
    retry: false,
    throwOnError: false
  });

  const isReconnectRequired = connectionStatus?.connectionStatus === 'reconnect_required';

  // Fetch estimates for sync status
  const { data: estimates = [], error: estimatesError } = useArrayQuery<any>({
    queryKey: ["/api/estimates"],
    enabled: true,
    retry: false,
    throwOnError: false
  });

  // Customer sync mutation
  const syncCustomersMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("/api/quickbooks/sync-customers", "POST");
    },
    onSuccess: (data) => {
      toast({
        title: "Customer Sync Complete",
        description: data.message || `${data.customersAdded || 0} added, ${data.customersAlreadySynced || 0} already synced`,
        variant: "default"
      });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/billing-preview"] });
    },
    onError: (error) => {
      console.error("Customer sync error:", error);
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync customers from QuickBooks",
        variant: "destructive"
      });
    }
  });

  // QuickBooks connection handler with structured error reporting
  const handleQuickBooksConnect = async () => {
    if (isConnecting) return;

    setIsConnecting(true);
    setConnectError(null);

    try {
      const response = await apiRequest('/api/quickbooks/auth');

      if (!response?.authUrl) {
        throw new Error("No authUrl in response");
      }

      toast({
        title: "Connecting to QuickBooks",
        description: "You'll be redirected to QuickBooks to authorize the connection.",
      });

      setTimeout(() => {
        window.location.href = response.authUrl;
      }, 1500);
    } catch (error) {
      const parsed = parseConnectError(error);
      setConnectError(parsed);

      const toastDescriptions: Record<ConnectErrorKind, string> = {
        not_configured: "QuickBooks is not configured. Contact your administrator.",
        oauth_failed: "OAuth request failed. Please try again.",
        network: "Network error. Check your connection and try again.",
        unknown: "Failed to connect to QuickBooks. Please try again.",
      };

      toast({
        title: "QuickBooks Connection Failed",
        description: toastDescriptions[parsed.kind],
        variant: "destructive",
      });
    } finally {
      setIsConnecting(false);
    }
  };

  // Sync estimate to QuickBooks
  const syncEstimateMutation = useMutation({
    mutationFn: async (estimateId: number) => {
      const data = await apiRequest(`/api/quickbooks/sync-estimate/${estimateId}`, "POST");
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Estimate Synced",
        description: `Estimate has been synchronized with QuickBooks. QB ID: ${data.quickbooksId}`
      });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
    },
    onError: () => {
      toast({
        title: "Sync Failed",
        description: "Failed to sync estimate to QuickBooks. Please try again.",
        variant: "destructive"
      });
    }
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "synced": return "bg-green-100 text-green-800";
      case "pending": return "bg-yellow-100 text-yellow-800";
      case "failed": return "bg-red-100 text-red-800";
      default: return "bg-gray-100 text-gray-800";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "synced": return <CheckCircle className="w-4 h-4 text-green-600" />;
      case "pending": return <Clock className="w-4 h-4 text-yellow-600" />;
      case "failed": return <AlertTriangle className="w-4 h-4 text-red-600" />;
      default: return <RefreshCw className="w-4 h-4 text-gray-600" />;
    }
  };

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ExternalLink className="w-5 h-5" />
            QuickBooks Online Integration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Connection Status */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Connection Status</h3>
              {isReconnectRequired ? (
                <Badge className="bg-red-100 text-red-800">
                  <ShieldAlert className="w-3 h-3 mr-1" />
                  Reconnect Required
                </Badge>
              ) : connectionStatus?.isConnected ? (
                <Badge className="bg-green-100 text-green-800">
                  <CheckCircle className="w-3 h-3 mr-1" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="outline">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  Not Connected
                </Badge>
              )}
            </div>

            {/* Reconnect Required Banner */}
            {isReconnectRequired && (
              <div className="space-y-3">
                <Alert className="border-red-300 bg-red-50">
                  <ShieldAlert className="h-5 w-5 text-red-600" />
                  <AlertTitle className="text-red-900 font-semibold">QuickBooks Reauthorization Required</AlertTitle>
                  <AlertDescription className="text-red-800 mt-1">
                    {connectionStatus?.reconnectRequiredReason || "Your QuickBooks authorization has expired or been revoked. You must reconnect to continue syncing data."}
                  </AlertDescription>
                  <div className="mt-3">
                    <button
                      onClick={handleQuickBooksConnect}
                      disabled={isConnecting}
                      className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400 font-medium"
                      data-testid="quickbooks-reconnect-btn"
                      type="button"
                    >
                      {isConnecting ? "Connecting..." : "Reconnect to QuickBooks"}
                    </button>
                  </div>
                </Alert>

                {connectError && (
                  <Alert className={
                    connectError.kind === "not_configured"
                      ? "border-amber-300 bg-amber-50"
                      : "border-red-300 bg-red-50"
                  }>
                    {connectError.kind === "not_configured" ? (
                      <ShieldAlert className="h-4 w-4 text-amber-600" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-red-600" />
                    )}
                    <AlertTitle className={
                      connectError.kind === "not_configured"
                        ? "text-amber-900 font-semibold"
                        : "text-red-900 font-semibold"
                    }>
                      {connectError.kind === "not_configured" && "QuickBooks Not Configured"}
                      {connectError.kind === "oauth_failed" && "Authorization Failed"}
                      {connectError.kind === "network" && "Network Error"}
                      {connectError.kind === "unknown" && "Connection Failed"}
                    </AlertTitle>
                    <AlertDescription className={
                      connectError.kind === "not_configured"
                        ? "text-amber-800 text-sm"
                        : "text-red-800 text-sm"
                    }>
                      {connectError.message}
                      {connectError.kind === "oauth_failed" && (
                        <a
                          href="https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block mt-1 underline text-red-700 hover:text-red-900"
                        >
                          View Intuit OAuth documentation
                          <ExternalLink className="inline w-3 h-3 ml-1" />
                        </a>
                      )}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {!isReconnectRequired && connectionStatus?.isConnected ? (
              <div className="p-4 bg-green-50 rounded-lg">
                <div className="flex items-center gap-3">
                  <Building className="w-5 h-5 text-green-600" />
                  <div>
                    <p className="font-medium text-green-900">{connectionStatus.companyName}</p>
                    <p className="text-sm text-green-700">Company ID: {connectionStatus.companyId}</p>
                  </div>
                </div>
                {connectionStatus.lastSync && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-green-700">
                    <Calendar className="w-4 h-4" />
                    Last sync: {format(new Date(connectionStatus.lastSync), "PPP")}
                  </div>
                )}

                {/* Customer Sync Section */}
                <div className="mt-4 pt-4 border-t border-green-200">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-medium text-green-900">Customer Data</h4>
                    <Button
                      onClick={() => syncCustomersMutation.mutate()}
                      disabled={syncCustomersMutation.isPending}
                      size="sm"
                      className="bg-green-600 hover:bg-green-700"
                    >
                      {syncCustomersMutation.isPending ? (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                          Syncing...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="w-4 h-4 mr-2" />
                          Import Customers
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-sm text-green-700">
                    Import existing customers from QuickBooks to populate your IrrigoPro customer list.
                  </p>
                </div>
              </div>
            ) : !isReconnectRequired ? (
              <div className="p-4 bg-blue-50 rounded-lg space-y-3">
                <p className="text-blue-900">
                  Connect your QuickBooks Online account to automatically sync estimates, invoices, and customer data.
                </p>
                <button 
                  onClick={handleQuickBooksConnect}
                  disabled={isConnecting}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
                  data-testid="quickbooks-connect-btn"
                  type="button"
                >
                  {isConnecting ? "Connecting..." : "Connect to QuickBooks"}
                </button>

                {connectError && (
                  <Alert className={
                    connectError.kind === "not_configured"
                      ? "border-amber-300 bg-amber-50"
                      : "border-red-300 bg-red-50"
                  }>
                    {connectError.kind === "not_configured" ? (
                      <ShieldAlert className="h-4 w-4 text-amber-600" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-red-600" />
                    )}
                    <AlertTitle className={
                      connectError.kind === "not_configured"
                        ? "text-amber-900 font-semibold"
                        : "text-red-900 font-semibold"
                    }>
                      {connectError.kind === "not_configured" && "QuickBooks Not Configured"}
                      {connectError.kind === "oauth_failed" && "Authorization Failed"}
                      {connectError.kind === "network" && "Network Error"}
                      {connectError.kind === "unknown" && "Connection Failed"}
                    </AlertTitle>
                    <AlertDescription className={
                      connectError.kind === "not_configured"
                        ? "text-amber-800 text-sm"
                        : "text-red-800 text-sm"
                    }>
                      {connectError.message}
                      {connectError.kind === "oauth_failed" && (
                        <a
                          href="https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block mt-1 underline text-red-700 hover:text-red-900"
                        >
                          View Intuit OAuth documentation
                          <ExternalLink className="inline w-3 h-3 ml-1" />
                        </a>
                      )}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            ) : null}
          </div>

          <Separator />

          {/* Connection Health Panel */}
          <div className="space-y-3">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Activity className="w-5 h-5" />
              Connection Health
            </h3>
            <ConnectionHealthPanel />
          </div>

          {/* Connection issue detection — visible to roles with
              CAN_MANAGE_QUICKBOOKS only when a stale QB row is detected.
              Hidden when healthy. */}
          {hasCapability(userRole, CAN_MANAGE_QUICKBOOKS) && staleStatus?.stale && (
            <>
              <Separator />
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-500" />
                  Connection Issue Detected
                </h3>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-3">
                  <p className="text-xs text-amber-900 font-medium">
                    Your QuickBooks connection needs to be completed.
                  </p>
                  <p className="text-xs text-amber-700">
                    Click Connect to QuickBooks above to finish setup. Once authorized,
                    invoices and customer syncs will resume automatically.
                  </p>
                  <button
                    onClick={handleQuickBooksConnect}
                    disabled={isConnecting}
                    className="w-full px-3 py-2 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:bg-gray-400 font-medium"
                    type="button"
                  >
                    {isConnecting ? "Connecting…" : "Re-authorize QuickBooks"}
                  </button>
                </div>
              </div>
            </>
          )}

          <Separator />

          {/* Sync Status */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Sync Status</h3>
            
            {estimates.length === 0 ? (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  No estimates available to sync. Create an estimate to get started.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3">
                {estimates.map((estimate: any) => (
                  <div key={estimate.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex items-center gap-3">
                      {getStatusIcon("not-synced")}
                      <div>
                        <p className="font-medium">{formatEstimateNumber(estimate.estimateNumber)}</p>
                        <p className="text-sm text-muted-foreground">
                          {estimate.customerName} - ${estimate.totalAmount}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={getStatusColor("not-synced")}>
                        Not Synced
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => syncEstimateMutation.mutate(estimate.id)}
                        disabled={!connectionStatus?.isConnected || syncEstimateMutation.isPending}
                      >
                        {syncEstimateMutation.isPending ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          "Sync"
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Features */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">Integration Features</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-3 bg-gray-50 rounded-lg">
                <h4 className="font-medium mb-2">Automatic Sync</h4>
                <p className="text-sm text-muted-foreground">
                  Estimates and invoices are automatically synchronized with QuickBooks Online
                </p>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <h4 className="font-medium mb-2">Customer Management</h4>
                <p className="text-sm text-muted-foreground">
                  Customer data is synchronized between both systems
                </p>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <h4 className="font-medium mb-2">Real-time Updates</h4>
                <p className="text-sm text-muted-foreground">
                  Payment status and invoice updates are reflected in real-time
                </p>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <h4 className="font-medium mb-2">Detailed Reporting</h4>
                <p className="text-sm text-muted-foreground">
                  Generate comprehensive reports combining field and financial data
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
