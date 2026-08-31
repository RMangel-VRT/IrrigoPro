import { useState, useEffect } from "react";
import { ActivityTab } from "@/components/activity/ActivityTab";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest, authedPdfUrl } from "@/lib/queryClient";
import { CheckCircle, XCircle, FileText, Users, Calendar, DollarSign, Wrench, Edit2, Mail, MapPin, ExternalLink, Send, Eye, Download, Trash2, Link as LinkIcon, Copy, PenLine, ChevronUp, ChevronDown } from "lucide-react";
import { EstimateMediaBlock } from "@/components/estimates/estimate-media-block";
import { ApprovalSignatureBlock } from "@/components/estimates/approval-signature-block";
import { buildMapsUrl } from "@/lib/maps-url";
import type { Estimate } from "@workspace/db/schema";
import { isInspectionOriginEstimate } from "@/lib/estimate-zone-grouping";
import { EstimateZoneGroupedView } from "@/components/estimates/estimate-zone-grouped-view";
import { ResendConfirmDialog } from "@/components/estimates/resend-confirm-dialog";
import { ConvertToWorkOrderModal } from "@/components/estimates/convert-to-work-order-modal";
import { useEstimateResend } from "@/hooks/use-estimate-resend";
import {
  SendEstimateDialog,
  type SendEstimatePayload,
} from "@/components/estimates/send-estimate-dialog";
import { sendEstimateEmail } from "@/lib/email";
import {
  canDeleteEstimateAs,
  customerResponseLabelOf,
  isApproved,
  isAwaitingCustomerReply,
  isConvertedToWorkOrder,
  isDraft,
  isExpired,
  isPendingReview,
  isRejected,
  isSent,
  lifecycleOf,
  reviewStageLabelOf,
  type LifecycleStatus,
} from "@workspace/shared";
import { EstimateListStatusBadge } from "@/components/estimates/list/estimate-list-status-badge";
import { formatEstimateNumber, buildEstimatePdfFilename } from "@workspace/shared";

interface EstimateDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: number | null;
  onEdit?: (estimateId: number) => void;
}

// Task #630 — keep this in lockstep with the server-side
// `ESTIMATE_PDF_READ_ROLES` set in routes.ts. If a role isn't in this
// list the View/Download PDF buttons don't render at all, so the user
// never sees an action that would 403 against the PDF endpoint. The
// server still enforces the gate authoritatively — this is just
// UI hygiene.
// TODO(roles): migrate to a capability from lib/shared/src/roles.ts (hasCapability). Inventory: docs/roles-migration-inventory.md
const PDF_READ_ROLES = new Set<string>([
  "super_admin",
  "company_admin",
  "billing_manager",
  "irrigation_manager",
]);

// Task #634 / #658 — the role × lifecycle delete matrix lives in
// `@/lib/lifecycle` (`canDeleteEstimateAs`) so this modal and the
// estimate list row stay in lockstep. The server is still the
// authoritative gate.

function readCurrentUserRole(): string | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem("user");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { role?: string };
    return typeof parsed?.role === "string" ? parsed.role : null;
  } catch {
    return null;
  }
}


export function EstimateDetailModal({ open, onOpenChange, estimateId, onEdit }: EstimateDetailModalProps) {
  const { toast } = useToast();
  const [isConverting, setIsConverting] = useState(false);
  const [showConvertDialog, setShowConvertDialog] = useState(false);
  const [showResendDialog, setShowResendDialog] = useState(false);
  const { resendEstimate, isResending } = useEstimateResend();
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [isViewingPdf, setIsViewingPdf] = useState(false);
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showUnapproveDialog, setShowUnapproveDialog] = useState(false);
  const [showUnrejectDialog, setShowUnrejectDialog] = useState(false);
  // Task #680 — Mark as Sent dialog state. `markSentResult` holds the
  // freshly minted customer approval URL after a successful mark so
  // the same dialog can flip to "Done — copy this link".
  const [showMarkSentDialog, setShowMarkSentDialog] = useState(false);
  const [markSentResult, setMarkSentResult] = useState<{
    approvalToken: string;
    url: string;
  } | null>(null);
  const [actionsOpen, setActionsOpen] = useState(true);

  // Reset the mobile action drawer to open whenever a different estimate
  // is loaded so users always see the actions immediately on open.
  useEffect(() => {
    setActionsOpen(true);
  }, [estimateId]);

  // Compute once per mount — the user's role rarely changes during a
  // session and we don't want this gate to flicker as React re-renders.
  const currentRole = readCurrentUserRole();
  const canSeeEstimatePdf = currentRole != null && PDF_READ_ROLES.has(currentRole);
  // Task #680 — same gate as the server's `requireEstimateApprovalAccess`.
  // Field techs do not see Email / Mark as Sent.
  const SEND_ROLES = new Set<string>([
    "super_admin",
    "company_admin",
    "billing_manager",
    "irrigation_manager",
  ]);
  const canSendEstimate = currentRole != null && SEND_ROLES.has(currentRole);
  // Task #365 — matches the server's resend role gate (irrigation_manager
  // can resend; billing_manager cannot). Mirrors the backend check in
  // POST /api/estimates/:id/resend.
  const RESEND_ROLES = new Set<string>([
    "super_admin",
    "company_admin",
    "irrigation_manager",
  ]);
  const canResendEstimate = currentRole != null && RESEND_ROLES.has(currentRole);

  const buildApprovalUrl = (token: string) => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/estimate-approval/${token}`;
  };

  const copyApprovalUrl = async (url: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast({
        title: "Link copied",
        description: "Customer approval link copied to clipboard.",
      });
    } catch {
      toast({
        title: "Couldn't copy",
        description: "Select the link and copy it manually.",
        variant: "destructive",
      });
    }
  };

  const { data: estimate, isLoading } = useQuery<any>({
    queryKey: ["/api/estimates", estimateId],
    enabled: !!estimateId && open,
  });

  // Open the PDF as a blob URL in a new tab so we can surface a loading
  // state while puppeteer renders, and so we can show a toast if the
  // server returns an error (a direct anchor would silently render an
  // error page in the new tab).
  // Task #630 — extract the server's `{ message }` when the PDF
  // endpoint returns a JSON error. Previously this only surfaced
  // "Failed (403)" style strings, which hid the real cause (typically
  // "Access denied. Estimate approval and customer delivery are
  // restricted to billing managers and administrators.") from the user.
  const extractPdfError = async (res: Response): Promise<string> => {
    try {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = (await res.json()) as { message?: string };
        if (body?.message) return body.message;
      } else {
        const text = await res.text();
        if (text) return text;
      }
    } catch {
      // fall through to status-only message
    }
    return `Failed (${res.status})`;
  };

  const handleViewPdf = async () => {
    if (!estimateId || isViewingPdf) return;
    setIsViewingPdf(true);
    try {
      const url = authedPdfUrl(`/api/estimates/${estimateId}/pdf`);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(await extractPdfError(res));
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const win = window.open(objUrl, "_blank", "noopener,noreferrer");
      if (!win) {
        toast({
          title: "Pop-up blocked",
          description: "Allow pop-ups for this site or use Download PDF instead.",
          variant: "destructive",
        });
      }
      setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
    } catch (err) {
      toast({
        title: "Couldn't open PDF",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsViewingPdf(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!estimateId || isDownloadingPdf) return;
    setIsDownloadingPdf(true);
    try {
      const url = authedPdfUrl(`/api/estimates/${estimateId}/pdf`, { download: "1" });
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(await extractPdfError(res));
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      const num = estimate?.estimateNumber as string | undefined;
      const customerName = (estimate as { customerName?: string } | undefined)?.customerName;
      a.download = num ? buildEstimatePdfFilename(num, customerName) : "estimate.pdf";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    } catch (err) {
      toast({
        title: "Couldn't download PDF",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  const handleConfirmResend = async (payload: Parameters<typeof resendEstimate>[1]) => {
    if (!estimateId) return;
    try {
      await resendEstimate(estimateId, payload);
      setShowResendDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
    } catch {
      // Error toast surfaced by hook; keep dialog open for retry.
    }
  };

  const approveEstimateMutation = useMutation({
    mutationFn: async () => {
      return apiRequest(`/api/estimates/${estimateId}/approve`, 'PATCH');
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Estimate approved successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
    },
    onError: (error) => {
      toast({
        title: "Error", 
        description: "Failed to approve estimate",
        variant: "destructive",
      });
    },
  });

  const sendApprovalEmailMutation = useMutation({
    mutationFn: async (payload: SendEstimatePayload) => {
      if (!estimateId) throw new Error("Missing estimate id");
      return sendEstimateEmail(estimateId, payload);
    },
    onSuccess: (_data, vars) => {
      toast({
        title: "Estimate sent",
        description: `Sent to ${vars.to}${vars.cc.length ? `, cc ${vars.cc.join(", ")}` : ""}`,
      });
      setShowSendDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
    },
    onError: (error: any) => {
      toast({
        title: "Couldn't send estimate",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  // Task #680 — Mark as Sent (no email). The endpoint mints the
  // approval token and flips internalStatus → sent_to_customer; we
  // stash the resulting URL so the dialog can offer "Copy link".
  const markSentMutation = useMutation({
    mutationFn: async () => {
      if (!estimateId) throw new Error("Missing estimate id");
      return apiRequest(`/api/estimates/${estimateId}/mark-sent`, "POST");
    },
    onSuccess: (data: any) => {
      const token = data?.approvalToken as string | undefined;
      // Prefer the server-built URL so the link matches what the
      // email flow would have used (APP_BASE_URL/production domain).
      // Fall back to constructing from the current origin if the
      // server didn't include it.
      const url = (data?.approvalUrl as string | undefined) ||
        (token ? buildApprovalUrl(token) : "");
      if (token && url) {
        setMarkSentResult({ approvalToken: token, url });
      }
      toast({
        title: "Estimate marked as sent",
        description: "No email was sent. Copy the customer link to share it.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't mark as sent",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const rejectEstimateMutation = useMutation({
    mutationFn: async () => {
      return apiRequest(`/api/estimates/${estimateId}/reject`, 'PATCH');
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Estimate rejected",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to reject estimate", 
        variant: "destructive",
      });
    },
  });

  const convertToWorkOrderMutation = useMutation({
    mutationFn: async (assignedTechnicianId: number) => {
      return apiRequest(`/api/estimates/${estimateId}/convert-to-work-order`, 'POST', {
        assignedTechnicianId,
      });
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Estimate converted to work order successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
      onOpenChange(false);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to convert estimate to work order",
        variant: "destructive",
      });
    },
  });

  const unapproveEstimateMutation = useMutation({
    mutationFn: async () => {
      if (!estimateId) throw new Error("Missing estimate id");
      return apiRequest(`/api/estimates/${estimateId}/unapprove`, "POST");
    },
    onSuccess: () => {
      toast({
        title: "Estimate reverted to sent",
        description: "The approval has been undone. The linked work order (if pending) was deleted.",
      });
      setShowUnapproveDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/work-orders"] });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't revert estimate",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
      setShowUnapproveDialog(false);
    },
  });

  const unrejectedEstimateMutation = useMutation({
    mutationFn: async () => {
      if (!estimateId) throw new Error("Missing estimate id");
      return apiRequest(`/api/estimates/${estimateId}/unreject`, "POST");
    },
    onSuccess: () => {
      toast({
        title: "Estimate reverted to sent",
        description: "The rejection has been undone. The estimate is back in Sent status.",
      });
      setShowUnrejectDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/estimates", estimateId] });
      queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't revert estimate",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
      setShowUnrejectDialog(false);
    },
  });

  const deleteEstimateMutation = useMutation({
    mutationFn: async () => {
      if (!estimateId) throw new Error("Missing estimate id");
      await apiRequest(`/api/estimates/${estimateId}`, "DELETE");
    },
    onSuccess: () => {
      toast({
        title: "Estimate deleted",
        description: `Estimate ${formatEstimateNumber(estimate?.estimateNumber)} was deleted.`.trim(),
      });
      setShowDeleteDialog(false);
      // Task #634 — invalidate every cache surface that could be
      // displaying this estimate (lists, dashboards, customer profile)
      // including query-string variants like `?includeDeleted=1`.
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey?.[0];
          return (
            typeof k === "string" &&
            (k.startsWith("/api/estimates") ||
              k.startsWith("/api/dashboard") ||
              k.startsWith("/api/customers"))
          );
        },
      });
      onOpenChange(false);
    },
    onError: (err) => {
      toast({
        title: "Couldn't delete estimate",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  // Unapprove is restricted to company_admin and super_admin — mirrors
  // the server-side ESTIMATE_UNAPPROVE_ROLES guard. The button is shown
  // for any approved estimate regardless of WO conversion status; if the
  // linked WO has progressed past pending the API returns 409 with a
  // human-readable message so the admin knows to cancel it first.
  const UNAPPROVE_ROLES = new Set<string>(["super_admin", "company_admin"]);
  const canUnapproveEstimate =
    currentRole != null &&
    UNAPPROVE_ROLES.has(currentRole) &&
    isApproved(estimate ?? null);

  // Unreject — mirrors the server-side ESTIMATE_UNREJECT_ROLES guard.
  // Only company_admin and super_admin may undo an accidental rejection.
  const UNREJECT_ROLES = new Set<string>(["super_admin", "company_admin"]);
  const canUnrejectEstimate =
    currentRole != null &&
    UNREJECT_ROLES.has(currentRole) &&
    isRejected(estimate ?? null);

  // Task #634 — show the Delete control only on still-draft rows. The
  // server enforces the same precondition; this just avoids surfacing
  // an action that will 409 the moment the user clicks it.
  const isEstimateDeleted = Boolean(
    (estimate as { deletedAt?: Date | string | null } | undefined)?.deletedAt,
  );
  const deletedAtDisplay = (() => {
    const raw = (estimate as { deletedAt?: Date | string | null } | undefined)
      ?.deletedAt;
    if (!raw) return null;
    try {
      return new Date(raw as string | Date).toLocaleString();
    } catch {
      return null;
    }
  })();
  const deletedByDisplay =
    (estimate as { deletedBy?: number | null } | undefined)?.deletedBy ?? null;
  // Task #658 — Delete is now allowed on `draft` AND `pending_review`,
  // with the role × lifecycle matrix mirroring the server.
  const canDeleteEstimate =
    canDeleteEstimateAs(currentRole, estimate ?? null) && !isEstimateDeleted;
  const isPendingDelete =
    canDeleteEstimate && isPendingReview(estimate ?? null);

  const handleConvertToWorkOrder = async (assignedTechnicianId: number) => {
    if (!estimateId) return;
    setIsConverting(true);
    try {
      await convertToWorkOrderMutation.mutateAsync(assignedTechnicianId);
      setShowConvertDialog(false);
    } finally {
      setIsConverting(false);
    }
  };

  const formatCurrency = (amount: number | string) => {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(numAmount);
  };

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  // Task #637 — these two helpers split the raw `status` /
  // `internalStatus` enums into the user-facing "Review stage" and
  // "Customer response" axes. The headline badge is always the
  // computed `lifecycleStatus` (rendered via EstimateListStatusBadge);
  // these labels are the secondary detail row below it. Raw enum
  // values never reach the screen — unknown values fall through to
  // "—". See docs/estimate-system.md §1.
  // Task #638 — axis-label helpers live in `@/lib/lifecycle` so this
  // file no longer reads `estimate.status` / `estimate.internalStatus`
  // directly; the lifecycle module is the single owner of the raw
  // enum → human-readable mapping.

  if (!estimateId) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-4xl max-h-[95vh] overflow-hidden p-0 flex flex-col sm:max-w-3xl md:max-w-4xl">
        <DialogHeader className="p-4 sm:p-6 border-b border-gray-200 flex-shrink-0">
          <DialogTitle className="flex items-center space-x-2 text-lg sm:text-xl">
            <FileText className="w-5 h-5" />
            <span>Estimate Details</span>
            {/* Task #637 — headline lifecycle badge in the modal
                header, matching the list rows and board columns so
                all three surfaces agree on the single status. */}
            {estimate ? (
              <span className="ml-2">
                <EstimateListStatusBadge status={lifecycleOf(estimate)} />
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="p-4 sm:p-6 space-y-4">
            <div className="animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-1/2"></div>
            </div>
          </div>
        ) : estimate ? (
          <>
            {/* Slice 3 — "From Wet Check #X" lineage banner.
                Rendered above the status banner so the wet-check origin
                is immediately visible when opening an inspection-sourced
                estimate. Only shown when originWetCheckId is set. */}
            {estimate.originWetCheckId != null && (
              <div
                className="bg-teal-50 border-b border-teal-200 px-4 py-2.5 flex items-center gap-2 text-sm text-teal-800 flex-shrink-0"
                data-testid="from-wet-check-banner"
              >
                <LinkIcon className="w-4 h-4 text-teal-600 flex-shrink-0" />
                <span>
                  From Wet Check{" "}
                  <a
                    href={`/wet-checks/${estimate.originWetCheckId}/review`}
                    className="font-semibold underline hover:text-teal-600"
                    data-testid="from-wet-check-link"
                  >
                    #{estimate.originWetCheckId}
                  </a>
                </span>
              </div>
            )}

            {/* Prominent Status Banner for Approved Estimates.
                Task #638 — distinguish "approved but not yet
                converted" from "converted to work order" via the
                lifecycle predicates instead of raw enum reads. */}
            {isApproved(estimate) && !isConvertedToWorkOrder(estimate) && (
              <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4 sm:p-6 flex-shrink-0 border-b">
                <div className="flex items-center justify-center space-x-3">
                  <CheckCircle className="w-8 h-8 flex-shrink-0" />
                  <div className="text-center">
                    <h3 className="text-xl sm:text-2xl font-bold">✓ ESTIMATE APPROVED</h3>
                    <p className="text-green-100 text-sm sm:text-base mt-1">
                      Customer approved this estimate • Ready to convert to work order
                    </p>
                  </div>
                  <CheckCircle className="w-8 h-8 flex-shrink-0" />
                </div>
              </div>
            )}

            {/* Prominent Status Banner for Converted to Work Order */}
            {isConvertedToWorkOrder(estimate) && (
              <div className="bg-gradient-to-r from-purple-500 to-indigo-600 text-white p-4 sm:p-6 flex-shrink-0 border-b">
                <div className="flex items-center justify-center space-x-3">
                  <Wrench className="w-8 h-8 flex-shrink-0" />
                  <div className="text-center">
                    <h3 className="text-xl sm:text-2xl font-bold">⚡ CONVERTED TO WORK ORDER</h3>
                    <p className="text-purple-100 text-sm sm:text-base mt-1">
                      This estimate has been converted • Work order is now active
                    </p>
                  </div>
                  <Wrench className="w-8 h-8 flex-shrink-0" />
                </div>
              </div>
            )}

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              <div className="space-y-4 sm:space-y-6">
            {/* Approval signature — shown when the customer drew or typed a
                signature during the online approval flow (Task #1500). */}
            {(isApproved(estimate) || isConvertedToWorkOrder(estimate)) && (
              <ApprovalSignatureBlock
                approvalSignatureType={estimate.approvalSignatureType as string | null | undefined}
                approvalSignatureData={estimate.approvalSignatureData}
                approvalSignerName={estimate.approvalSignerName}
                approvalSignedAt={estimate.approvalSignedAt as string | null | undefined}
                approvalSignerIp={estimate.approvalSignerIp}
                approvalConsentText={estimate.approvalConsentText}
                approvalConsentAcceptedAt={estimate.approvalConsentAcceptedAt as string | null | undefined}
              />
            )}
            {/* Header Information */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center space-x-2">
                    <FileText className="w-5 h-5" />
                    <span>Estimate Information</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <span className="font-medium text-gray-700">Estimate Number:</span>
                    <p className="text-lg font-semibold text-gray-900">{formatEstimateNumber(estimate.estimateNumber)}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Project Name:</span>
                    <p className="text-gray-900">{estimate.projectName}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Status:</span>
                    {/* Task #637 — the headline lifecycle badge lives
                        in the DialogHeader as the single source of
                        truth. Here we keep only the celebratory
                        accent line for the two terminal-success
                        cases plus the two axis-specific labels
                        ("Review stage" + "Customer response") so the
                        screen exposes what moved last without
                        duplicating the badge itself. */}
                    {isApproved(estimate) && (
                      <div className="mt-1 text-sm font-medium">
                        {isConvertedToWorkOrder(estimate) ? (
                          <span className="text-purple-600">Work Order Active!</span>
                        ) : (
                          <span className="text-green-600">Customer Approved!</span>
                        )}
                      </div>
                    )}
                    {/* Task #638 — the two axis labels read the raw
                        enums *only* via these dedicated label helpers
                        in this file. The labels are the documented
                        secondary detail surface (per
                        docs/estimate-system.md) and are intentionally
                        scoped to the modal. */}
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs text-gray-600">
                      <div>
                        <span className="font-medium text-gray-500">Review stage:</span>{' '}
                        <span data-testid="status-review-stage">
                          {reviewStageLabelOf(estimate)}
                        </span>
                      </div>
                      <div>
                        <span className="font-medium text-gray-500">Customer response:</span>{' '}
                        <span data-testid="status-customer-response">
                          {customerResponseLabelOf(estimate)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Created Date:</span>
                    <p className="text-gray-900">{formatDate(estimate.createdAt)}</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center space-x-2">
                    <Users className="w-5 h-5" />
                    <span>Customer Information</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <span className="font-medium text-gray-700">Customer Name:</span>
                    <p className="text-gray-900">{estimate.customerName}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Email:</span>
                    <p className="text-gray-900">{estimate.customerEmail}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Phone:</span>
                    <p className="text-gray-900">{estimate.customerPhone || 'Not provided'}</p>
                  </div>
                  <div>
                    <span className="font-medium text-gray-700">Address:</span>
                    <p className="text-gray-900">{estimate.customerAddress || 'Not provided'}</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Pinned Work Location (Task #348) */}
            {estimate.workLocationLat != null && estimate.workLocationLng != null && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center space-x-2">
                    <MapPin className="w-5 h-5 text-blue-600" />
                    <span>Pinned Work Location</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {estimate.workLocationAddress && (
                    <div>
                      <span className="font-medium text-gray-700">Address:</span>
                      <p className="text-gray-900">{estimate.workLocationAddress}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-gray-600 font-mono">
                      {parseFloat(estimate.workLocationLat).toFixed(6)}, {parseFloat(estimate.workLocationLng).toFixed(6)}
                    </span>
                    {(() => {
                      const mapsUrl = buildMapsUrl({
                        lat: estimate.workLocationLat,
                        lng: estimate.workLocationLng,
                        address: estimate.workLocationAddress,
                        label:
                          estimate.workLocationAddress ||
                          estimate.customerAddress ||
                          estimate.customerName,
                      });
                      if (!mapsUrl) return null;
                      return (
                        <a
                          href={mapsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 underline"
                          data-testid="link-view-on-map"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          View on map
                        </a>
                      );
                    })()}
                  </div>
                  {(estimate.controllerLetter || estimate.zoneNumber) && (
                    <div>
                      <span className="font-medium text-gray-700">Controller / Zone:</span>
                      <p className="text-gray-900">
                        {estimate.controllerLetter ? `Controller ${estimate.controllerLetter}` : ''}
                        {estimate.controllerLetter && estimate.zoneNumber ? ' · ' : ''}
                        {estimate.zoneNumber ? `Zone ${estimate.zoneNumber}` : ''}
                      </p>
                    </div>
                  )}
                  <div className="rounded-lg overflow-hidden border border-gray-200">
                    <iframe
                      title="Pinned work location"
                      width="100%"
                      height="220"
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      src={`https://www.openstreetmap.org/export/embed.html?bbox=${parseFloat(estimate.workLocationLng) - 0.003}%2C${parseFloat(estimate.workLocationLat) - 0.002}%2C${parseFloat(estimate.workLocationLng) + 0.003}%2C${parseFloat(estimate.workLocationLat) + 0.002}&layer=mapnik&marker=${estimate.workLocationLat}%2C${estimate.workLocationLng}`}
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Scope of Work (Task #603) — display the saved scope so
                managers/admins can read it without exporting the PDF. */}
            {estimate.workDescription && estimate.workDescription.trim() && (
              <Card data-testid="estimate-detail-scope-of-work">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Scope of Work</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-gray-900 whitespace-pre-wrap">
                    {estimate.workDescription}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Project Details */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Project Details</CardTitle>
              </CardHeader>
              <CardContent>
                {estimate.projectDescription && (
                  <div className="mb-4">
                    <span className="font-medium text-gray-700">Description:</span>
                    <p className="text-gray-900 mt-1">{estimate.projectDescription}</p>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="bg-blue-50 p-4 rounded-lg">
                    <div className="flex items-center space-x-2">
                      <DollarSign className="w-5 h-5 text-blue-600" />
                      <span className="font-medium text-blue-900">Total Amount</span>
                    </div>
                    <p className="text-2xl font-bold text-blue-900 mt-1">
                      {formatCurrency(estimate.totalAmount)}
                    </p>
                  </div>
                  <div className="bg-green-50 p-4 rounded-lg">
                    <div className="flex items-center space-x-2">
                      <Wrench className="w-5 h-5 text-green-600" />
                      <span className="font-medium text-green-900">Labor Hours</span>
                    </div>
                    <p className="text-2xl font-bold text-green-900 mt-1">
                      {estimate.totalLaborHours || 0}h
                    </p>
                  </div>
                  <div className="bg-purple-50 p-4 rounded-lg">
                    <div className="flex items-center space-x-2">
                      <Calendar className="w-5 h-5 text-purple-600" />
                      <span className="font-medium text-purple-900">Line Items</span>
                    </div>
                    <p className="text-2xl font-bold text-purple-900 mt-1">
                      {estimate.items?.length || 0}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Site Photos & Attachments — Task #666 */}
            <EstimateMediaBlock
              photos={Array.isArray(estimate.photos) ? estimate.photos : []}
              attachments={Array.isArray(estimate.attachments) ? estimate.attachments : []}
              testIdPrefix="estimate"
            />

            {/* Line Items — flat for non-inspection, zone-grouped for inspection-origin */}
            {estimate.items && estimate.items.length > 0 && (
              isInspectionOriginEstimate(estimate.items) ? (
                <EstimateZoneGroupedView
                  items={estimate.items}
                  laborRate={parseFloat(estimate.laborRate) || 0}
                  partsSubtotal={parseFloat(estimate.partsSubtotal) || 0}
                  laborSubtotal={parseFloat(estimate.laborSubtotal) || 0}
                  totalAmount={parseFloat(estimate.totalAmount) || 0}
                  totalLaborHours={parseFloat(estimate.totalLaborHours) || 0}
                  canSeePricing={true}
                />
              ) : (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Line Items</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-gray-700">
                          <th className="py-2 pr-2">Part</th>
                          <th className="py-2 pr-2 text-right">Qty</th>
                          <th className="py-2 pr-2 text-right">Unit $</th>
                          <th className="py-2 pr-2 text-right">Labor h</th>
                          <th className="py-2 pr-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {estimate.items.map((item: any) => (
                          <tr key={item.id} className="border-b last:border-b-0 align-top">
                            <td className="py-2 pr-2">
                              <div className="font-medium text-gray-900">{item.partName}</div>
                              {item.description && (
                                <div className="text-xs text-gray-600 mt-0.5">{item.description}</div>
                              )}
                            </td>
                            <td className="py-2 pr-2 text-right">{item.quantity}</td>
                            <td className="py-2 pr-2 text-right">{formatCurrency(item.partPrice)}</td>
                            <td className="py-2 pr-2 text-right">{item.laborHours}</td>
                            <td className="py-2 pr-2 text-right font-semibold">{formatCurrency(item.totalPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
              )
            )}

            {/* Customer Signature — only rendered when the customer signed via
                the approval flow (approvalSignatureType is set). Shows the
                drawn image or typed-name display alongside signer name, date,
                and IP so managers can audit the approval at a glance. */}
            {estimate.approvalSignatureType && (
              <Card data-testid="estimate-detail-signature-block">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center space-x-2">
                    <PenLine className="w-5 h-5 text-green-600" />
                    <span>Customer Signature</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {estimate.approvalSignatureType === "drawn" &&
                    estimate.approvalSignatureData && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
                          Drawn Signature
                        </p>
                        <div className="inline-block rounded-lg border border-gray-200 bg-white p-2 shadow-sm">
                          <img
                            src={estimate.approvalSignatureData}
                            alt="Customer signature"
                            className="max-h-24 max-w-xs object-contain"
                            data-testid="signature-image"
                          />
                        </div>
                      </div>
                    )}

                  {estimate.approvalSignatureType === "typed" &&
                    estimate.approvalSignatureData && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wide">
                          Typed Signature
                        </p>
                        <div
                          className="inline-block rounded-lg border border-gray-200 bg-white px-6 py-3 shadow-sm"
                          data-testid="signature-typed"
                        >
                          <span className="font-signature text-2xl text-gray-800 italic">
                            {estimate.approvalSignatureData}
                          </span>
                        </div>
                      </div>
                    )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm pt-1">
                    {estimate.approvalSignerName && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                          Signer Name
                        </p>
                        <p className="text-gray-900 font-medium" data-testid="signature-signer-name">
                          {estimate.approvalSignerName}
                        </p>
                      </div>
                    )}
                    {estimate.approvalSignedAt && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                          Signed
                        </p>
                        <p className="text-gray-900" data-testid="signature-signed-at">
                          {new Date(estimate.approvalSignedAt).toLocaleString("en-US", {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </p>
                      </div>
                    )}
                    {estimate.approvalSignerIp && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">
                          IP Address
                        </p>
                        <p className="text-gray-600 font-mono text-xs" data-testid="signature-signer-ip">
                          {estimate.approvalSignerIp}
                        </p>
                      </div>
                    )}
                  </div>

                  {estimate.approvalConsentText && (
                    <details className="text-xs text-gray-500 pt-1">
                      <summary className="cursor-pointer hover:text-gray-700 select-none">
                        Consent text shown to customer
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap bg-gray-50 rounded p-3 border border-gray-100 leading-relaxed">
                        {estimate.approvalConsentText}
                      </p>
                    </details>
                  )}
                </CardContent>
              </Card>
            )}
              </div>
            </div>

            {/* Fixed Footer with Actions — Task #630.
                Wraps cleanly on small viewports (375px phone, 768px
                tablet, 1024×600 laptop). Secondary actions (Close,
                View, Download, Resend, Edit) live in a wrap-capable
                group on the left; primary actions (Email, Approve,
                Reject, Convert to Work Order) stay anchored to the
                right and also wrap if necessary. The footer itself
                is flex-shrink-0 so the scrollable body above it
                takes the overflow instead of pushing the footer off
                screen. */}
            <div
              className="flex-shrink-0 p-4 sm:p-6 border-t border-gray-200 bg-gray-50"
              data-testid="detail-modal-footer"
            >
              {/* Mobile-only pill handle — hidden on sm+ */}
              <div className="flex justify-center mb-2 sm:hidden">
                <button
                  type="button"
                  onClick={() => setActionsOpen((prev) => !prev)}
                  aria-expanded={actionsOpen}
                  aria-controls="detail-modal-footer-actions"
                  className="flex items-center gap-1 px-4 py-1 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-600 text-sm transition-colors"
                >
                  {actionsOpen ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </button>
              </div>
              {/* Collapsible region — full-height on sm+, animated on mobile */}
              <div
                id="detail-modal-footer-actions"
                className={`overflow-hidden transition-all duration-200 sm:max-h-none sm:overflow-visible${actionsOpen ? " max-h-[600px]" : " max-h-0"}`}
              >
              <div className="flex flex-col-reverse sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-3">
                <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-3">
                  <Button
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    className="w-full sm:w-auto"
                    data-testid="detail-modal-close"
                  >
                    Close
                  </Button>
                  {isEstimateDeleted && (
                    <div
                      className="w-full text-xs text-gray-600 bg-amber-50 border border-amber-200 rounded px-3 py-2"
                      data-testid="detail-modal-deleted-banner"
                    >
                      This estimate was deleted
                      {deletedByDisplay != null ? ` by user #${deletedByDisplay}` : ""}
                      {deletedAtDisplay ? ` on ${deletedAtDisplay}` : ""}. It is
                      preserved for audit only — actions are disabled.
                    </div>
                  )}
                  {canSeeEstimatePdf && !isEstimateDeleted && (
                    <>
                      <Button
                        variant="outline"
                        onClick={handleViewPdf}
                        disabled={isViewingPdf}
                        className="w-full sm:w-auto"
                        data-testid="detail-modal-view-pdf"
                      >
                        <Eye className="w-4 h-4 mr-2" />
                        {isViewingPdf ? "Opening..." : "View PDF"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleDownloadPdf}
                        disabled={isDownloadingPdf}
                        className="w-full sm:w-auto"
                        data-testid="detail-modal-download-pdf"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        {isDownloadingPdf ? "Preparing..." : "Download PDF"}
                      </Button>
                    </>
                  )}
                  {/* Task #365 — show Resend for expired OR for sent-but-not-yet-responded estimates,
                      gated to irrigation_manager / company_admin / super_admin */}
                  {(isExpired(estimate) || (isSent(estimate) && isAwaitingCustomerReply(estimate))) &&
                    !isEstimateDeleted && canResendEstimate && (
                    <Button
                      onClick={() => setShowResendDialog(true)}
                      variant="outline"
                      className="border-orange-200 text-orange-700 hover:bg-orange-50 w-full sm:w-auto"
                      data-testid="detail-modal-resend"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      Resend
                    </Button>
                  )}
                  {canDeleteEstimate && (
                    <Button
                      variant="outline"
                      onClick={() => setShowDeleteDialog(true)}
                      disabled={deleteEstimateMutation.isPending}
                      className="border-red-200 text-red-700 hover:bg-red-50 w-full sm:w-auto"
                      data-testid="detail-modal-delete"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      {deleteEstimateMutation.isPending ? "Deleting…" : "Delete"}
                    </Button>
                  )}
                  {!isConvertedToWorkOrder(estimate) && onEdit && !isEstimateDeleted && (
                    <Button
                      onClick={() => {
                        onEdit(estimateId!);
                        onOpenChange(false);
                      }}
                      variant="outline"
                      className="border-blue-200 text-blue-600 hover:bg-blue-50 w-full sm:w-auto"
                      data-testid="detail-modal-edit"
                    >
                      <Edit2 className="w-4 h-4 mr-2" />
                      {isDraft(estimate) ? 'Continue editing' : 'Edit Estimate'}
                    </Button>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:gap-3 sm:justify-end">
                  {/* Approval Actions for Pending Estimates.
                      Task #638 — gated by `isAwaitingCustomerReply`
                      so we don't surface Approve/Reject after the
                      customer has already responded. */}
                  {isAwaitingCustomerReply(estimate) && !isEstimateDeleted && (
                    <>
                      {/* Task #680 — Copy approval link for any sent
                          estimate with a non-expired token, so users
                          can re-share the existing link without
                          re-sending or re-marking. */}
                      {canSendEstimate && isSent(estimate) && estimate.approvalToken && (() => {
                        const expiresAt = estimate.tokenExpiresAt ? new Date(estimate.tokenExpiresAt) : null;
                        const tokenValid = !expiresAt || expiresAt.getTime() > Date.now();
                        if (!tokenValid) return null;
                        return (
                          <Button
                            variant="outline"
                            onClick={() => copyApprovalUrl(buildApprovalUrl(estimate.approvalToken))}
                            className="w-full sm:w-auto"
                            data-testid="detail-modal-copy-approval-link"
                          >
                            <LinkIcon className="w-4 h-4 mr-2" />
                            Copy approval link
                          </Button>
                        );
                      })()}
                      {/* Email + Mark-as-Sent are only valid when the
                          estimate is in `pending_review` lifecycle
                          (internal pending_approval / approved_internal).
                          Explicitly excludes sent / expired / approved /
                          rejected / draft so we never show an action
                          the server will reject with a 400. */}
                      {canSendEstimate && isPendingReview(estimate) && (
                        <Button
                          onClick={() => setShowSendDialog(true)}
                          disabled={sendApprovalEmailMutation?.isPending}
                          className="bg-blue-600 hover:bg-blue-700 w-full sm:w-auto"
                          data-testid="detail-modal-send-email"
                        >
                          <Mail className="w-4 h-4 mr-2" />
                          {sendApprovalEmailMutation?.isPending ? 'Sending...' : 'Email Customer'}
                        </Button>
                      )}
                      {canSendEstimate && isPendingReview(estimate) && (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setMarkSentResult(null);
                            setShowMarkSentDialog(true);
                          }}
                          disabled={markSentMutation.isPending}
                          className="w-full sm:w-auto"
                          data-testid="detail-modal-mark-sent"
                        >
                          <LinkIcon className="w-4 h-4 mr-2" />
                          Mark as Sent
                        </Button>
                      )}
                      <Button
                        onClick={() => approveEstimateMutation.mutate()}
                        disabled={approveEstimateMutation.isPending}
                        className="bg-green-600 hover:bg-green-700 w-full sm:w-auto"
                        data-testid="detail-modal-approve"
                      >
                        <CheckCircle className="w-4 h-4 mr-2" />
                        {approveEstimateMutation.isPending ? 'Approving...' : 'Approve'}
                      </Button>
                      <Button
                        onClick={() => rejectEstimateMutation.mutate()}
                        disabled={rejectEstimateMutation.isPending}
                        variant="destructive"
                        className="w-full sm:w-auto"
                        data-testid="detail-modal-reject"
                      >
                        <XCircle className="w-4 h-4 mr-2" />
                        {rejectEstimateMutation.isPending ? 'Rejecting...' : 'Reject'}
                      </Button>
                    </>
                  )}

                  {/* Convert to Work Order for Approved Estimates.
                      Task #638 — uses `isApproved` (lifecycle) +
                      `!isConvertedToWorkOrder` so a converted
                      estimate doesn't re-offer the conversion. */}
                  {isApproved(estimate) && !isConvertedToWorkOrder(estimate) && !isEstimateDeleted && (
                    <Button
                      onClick={() => setShowConvertDialog(true)}
                      disabled={isConverting}
                      className="bg-blue-600 hover:bg-blue-700 w-full sm:w-auto"
                      data-testid="detail-modal-convert"
                    >
                      <Wrench className="w-4 h-4 mr-2" />
                      {isConverting ? 'Converting...' : 'Convert to Work Order'}
                    </Button>
                  )}

                  {/* Unapprove — visible only to company_admin and super_admin
                      when the estimate is approved but not yet converted. */}
                  {canUnapproveEstimate && !isEstimateDeleted && (
                    <Button
                      variant="outline"
                      onClick={() => setShowUnapproveDialog(true)}
                      disabled={unapproveEstimateMutation.isPending}
                      className="border-amber-300 text-amber-700 hover:bg-amber-50 w-full sm:w-auto"
                      data-testid="detail-modal-unapprove"
                    >
                      <XCircle className="w-4 h-4 mr-2" />
                      {unapproveEstimateMutation.isPending ? "Reverting…" : "Unapprove"}
                    </Button>
                  )}
                  {/* Unreject — visible only to company_admin and super_admin
                      when the estimate is in the rejected lifecycle. */}
                  {canUnrejectEstimate && !isEstimateDeleted && (
                    <Button
                      variant="outline"
                      onClick={() => setShowUnrejectDialog(true)}
                      disabled={unrejectedEstimateMutation.isPending}
                      className="border-amber-300 text-amber-700 hover:bg-amber-50 w-full sm:w-auto"
                      data-testid="detail-modal-unreject"
                    >
                      <XCircle className="w-4 h-4 mr-2" />
                      {unrejectedEstimateMutation.isPending ? "Reverting…" : "Revert to Sent"}
                    </Button>
                  )}
                </div>
              </div>
              </div>
            </div>

            {/* Task #641 — Activity feed */}
            <div className="border-t border-gray-200" data-testid="estimate-activity-section">
              <div className="px-4 sm:px-6 py-3 bg-gray-50 text-sm font-semibold">
                Activity
              </div>
              <ActivityTab resource="estimates" id={estimate.id} />
            </div>
          </>
        ) : (
          <div className="text-center py-8">
            <p className="text-gray-500">Estimate not found</p>
          </div>
        )}
      </DialogContent>
      <ResendConfirmDialog
        estimate={estimate ?? null}
        open={showResendDialog}
        onOpenChange={setShowResendDialog}
        onConfirm={handleConfirmResend}
        isResending={isResending}
        isExpiredResend={isExpired(estimate)}
      />
      <ConvertToWorkOrderModal
        isOpen={showConvertDialog}
        onClose={() => setShowConvertDialog(false)}
        isLoading={isConverting}
        onConfirm={(assignedTechnicianId) => {
          void handleConvertToWorkOrder(assignedTechnicianId);
        }}
      />
      <SendEstimateDialog
        open={showSendDialog}
        onOpenChange={setShowSendDialog}
        estimateNumber={estimate?.estimateNumber ? formatEstimateNumber(estimate.estimateNumber) : null}
        customerName={estimate?.customerName ?? null}
        customerEmail={estimate?.customerEmail ?? null}
        isSending={sendApprovalEmailMutation.isPending}
        onSend={(payload) => sendApprovalEmailMutation.mutate(payload)}
      />
      {/* Task #680 — Mark as Sent confirm + result dialog. Pre-confirm
          shows the warning copy; on success the same dialog flips to
          show the freshly minted customer approval URL with a Copy
          button. */}
      <AlertDialog
        open={showMarkSentDialog}
        onOpenChange={(open) => {
          setShowMarkSentDialog(open);
          if (!open) setMarkSentResult(null);
        }}
      >
        <AlertDialogContent data-testid="mark-sent-dialog">
          {markSentResult ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Estimate marked as sent</AlertDialogTitle>
                <AlertDialogDescription>
                  No email was sent. Share this approval link with the customer
                  however you like — the link and the estimate both expire 30
                  days from when it was sent.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-2">
                <div
                  className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono break-all"
                  data-testid="mark-sent-approval-url"
                >
                  {markSentResult.url}
                </div>
                <Button
                  variant="outline"
                  onClick={() => copyApprovalUrl(markSentResult.url)}
                  className="w-full"
                  data-testid="mark-sent-copy-url"
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copy link
                </Button>
              </div>
              <AlertDialogFooter>
                <AlertDialogAction
                  onClick={() => {
                    setShowMarkSentDialog(false);
                    setMarkSentResult(null);
                  }}
                  data-testid="mark-sent-done"
                >
                  Done
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Mark this estimate as sent?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will advance the estimate to Sent and generate a customer
                  approval link, but will <span className="font-semibold">NOT</span>{" "}
                  send an email. Use this when you've delivered the estimate
                  outside IrrigoPro (printed, hand-delivered, or sent from a
                  personal email).
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={markSentMutation.isPending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={markSentMutation.isPending}
                  onClick={(e) => {
                    e.preventDefault();
                    markSentMutation.mutate();
                  }}
                  data-testid="mark-sent-confirm"
                >
                  {markSentMutation.isPending ? "Marking…" : "Mark as Sent"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={showUnapproveDialog} onOpenChange={setShowUnapproveDialog}>
        <AlertDialogContent data-testid="unapprove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this estimate to Sent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will undo the customer approval and step the estimate back to{" "}
              <span className="font-semibold">Sent</span>. If a work order was
              created from this approval and is still in{" "}
              <span className="font-semibold">pending</span> status, it will be
              permanently deleted.
              <br />
              <br />
              If the work order has already been assigned or started, you must
              cancel it first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unapproveEstimateMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={unapproveEstimateMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                unapproveEstimateMutation.mutate();
              }}
              className="bg-amber-600 hover:bg-amber-700"
              data-testid="unapprove-confirm"
            >
              {unapproveEstimateMutation.isPending ? "Reverting…" : "Revert to Sent"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={showUnrejectDialog} onOpenChange={setShowUnrejectDialog}>
        <AlertDialogContent data-testid="unreject-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this estimate to Sent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will undo the rejection and step the estimate back to{" "}
              <span className="font-semibold">Sent</span> status. The customer
              will not be notified automatically — use the existing resend flow
              if you want to re-deliver the estimate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unrejectedEstimateMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={unrejectedEstimateMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                unrejectedEstimateMutation.mutate();
              }}
              className="bg-amber-600 hover:bg-amber-700"
              data-testid="unreject-confirm"
            >
              {unrejectedEstimateMutation.isPending ? "Reverting…" : "Revert to Sent"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent data-testid="detail-modal-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isPendingDelete
                ? "Delete this pending estimate?"
                : "Delete this draft estimate?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isPendingDelete ? (
                <>
                  Estimate{" "}
                  <span className="font-medium">{formatEstimateNumber(estimate?.estimateNumber)}</span>{" "}
                  for{" "}
                  <span className="font-medium">{estimate?.customerName}</span>{" "}
                  has been submitted for approval. Deleting it will hide it
                  from every list; admins can still see it for audit.
                </>
              ) : (
                <>
                  Estimate{" "}
                  <span className="font-medium">{formatEstimateNumber(estimate?.estimateNumber)}</span>{" "}
                  for{" "}
                  <span className="font-medium">{estimate?.customerName}</span>{" "}
                  will be removed from lists and dashboards. The row is
                  preserved for audit and can be restored by a super admin if
                  needed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteEstimateMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              disabled={deleteEstimateMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                deleteEstimateMutation.mutate();
              }}
              data-testid="detail-modal-delete-confirm"
            >
              {deleteEstimateMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

