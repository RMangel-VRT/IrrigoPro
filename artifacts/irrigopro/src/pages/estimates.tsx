import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useArrayQuery } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { EstimateWizard } from "@/components/estimates/estimate-wizard";
import { EstimateDetailModal } from "@/components/estimates/estimate-detail-modal";
import { QuickBooksIntegration } from "@/components/quickbooks/quickbooks-integration";
import { EstimateBoard } from "@/components/estimates/board/estimate-board";
import { EstimateList, type EstimateFilterState } from "@/components/estimates/list/estimate-list";
import {
  BoardListToggle,
  type EstimatesView,
} from "@/components/estimates/board-list-toggle";
import { EstimateBoardFilter } from "@/components/estimates/board/estimate-board-filter";
import { useState, useEffect } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { safeGet, safeSet } from "@/utils/safeStorage";
import type { Customer, Estimate } from "@workspace/db/schema";

const VIEW_PREF_KEY = "estimates_view_preference";

export default function Estimates() {
  const [showEstimateWizard, setShowEstimateWizard] = useState(false);
  const [selectedEstimateId, setSelectedEstimateId] = useState<number | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [editEstimateId, setEditEstimateId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [view, setView] = useState<EstimatesView>(() => {
    const stored = safeGet(VIEW_PREF_KEY);
    return stored === "list" ? "list" : "board";
  });
  const [filters, setFilters] = useState<EstimateFilterState>({
    customerIds: [],
    statuses: [],
  });

  const queryClient = useQueryClient();

  const getCurrentUser = () => {
    const savedUser = safeGet("user");
    return savedUser ? JSON.parse(savedUser) : null;
  };
  const currentUser = getCurrentUser();
  const isIrrigationManager = currentUser?.role === "irrigation_manager";
  const isFieldTech = currentUser?.role === "field_tech";
  // Task #634 — super_admin can opt into seeing soft-deleted estimates.
  const isSuperAdmin = currentUser?.role === "super_admin";
  const [showDeleted, setShowDeleted] = useState(false);

  useEffect(() => {
    safeSet(VIEW_PREF_KEY, view);
  }, [view]);

  // ?create=true → open wizard
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("create") === "true") {
      setShowEstimateWizard(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // ?openEstimate=<id> → open detail modal
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("openEstimate");
    if (!v) return;
    const idNum = parseInt(v, 10);
    if (!Number.isFinite(idNum)) return;
    setSelectedEstimateId(idNum);
    setShowDetailModal(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("openEstimate");
    window.history.replaceState({}, "", url.toString());
  }, []);

  // Task #634 — when a super_admin toggles "Show deleted", swap the
  // request path so the soft-deleted rows come back. `queryKey.join("/")`
  // is what the default queryFn turns into a URL, so the key itself
  // must encode the query string.
  const estimatesPath =
    isSuperAdmin && showDeleted
      ? "/api/estimates?includeDeleted=1"
      : "/api/estimates";
  const { data: estimates = [], isLoading, isError } = useArrayQuery<Estimate>({
    queryKey: [estimatesPath],
  });

  const { data: customers = [] } = useArrayQuery<Customer>({
    queryKey: ["/api/customers"],
  });

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
      await queryClient.refetchQueries({ queryKey: ["/api/estimates"] });
    } finally {
      setRefreshing(false);
    }
  };

  const handleOpenEstimate = (id: number) => {
    setSelectedEstimateId(id);
    setShowDetailModal(true);
  };

  const handleEditEstimate = (id: number) => {
    setEditEstimateId(id);
    setShowEstimateWizard(true);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Slice 10c — Always-visible Board/List view toggle. */}
      <div className="flex justify-end items-center gap-3 mb-3">
        {isSuperAdmin && (
          <label
            className="flex items-center gap-2 text-sm text-gray-700 select-none"
            data-testid="show-deleted-toggle"
          >
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
              data-testid="show-deleted-checkbox"
            />
            Show deleted
          </label>
        )}
        <BoardListToggle value={view} onChange={setView} />
      </div>

      <Tabs defaultValue="estimates" className="space-y-6">
        <TabsList
          className={`grid w-full ${
            isIrrigationManager || isFieldTech ? "grid-cols-1" : "grid-cols-2"
          }`}
        >
          <TabsTrigger value="estimates">Estimates</TabsTrigger>
          {!isIrrigationManager && !isFieldTech && (
            <TabsTrigger value="quickbooks">QuickBooks</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="estimates">
          {view === "board" ? (
            <EstimateBoard
              estimates={estimates}
              isLoading={isLoading}
              isError={isError}
              refreshing={refreshing}
              onCardClick={handleOpenEstimate}
              onRefresh={handleRefresh}
              onNewEstimate={() => setShowEstimateWizard(true)}
            />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">Estimates</h1>
                  <p className="text-sm text-gray-600">Manage and track your irrigation estimates</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <EstimateBoardFilter
                    customers={customers}
                    selectedCustomerIds={filters.customerIds}
                    selectedStatuses={filters.statuses}
                    onChange={({ customerIds, statuses }) =>
                      setFilters({ customerIds, statuses })
                    }
                  />
                  <Button
                    onClick={handleRefresh}
                    disabled={refreshing}
                    variant="outline"
                    className="flex items-center gap-2"
                  >
                    <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
                    {refreshing ? "Checking…" : "Check Status"}
                  </Button>
                  <Button
                    onClick={() => setShowEstimateWizard(true)}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    New Estimate
                  </Button>
                </div>
              </div>
              {/* Task #1898 — isError was only wired into the board view, so
                  a failed fetch rendered the list's empty state instead. */}
              <EstimateList
                estimates={estimates ?? []}
                filters={filters}
                onOpen={handleOpenEstimate}
                onEdit={handleEditEstimate}
                isError={isError}
                onRetry={handleRefresh}
              />
            </div>
          )}
        </TabsContent>

        {!isIrrigationManager && !isFieldTech && (
          <TabsContent value="quickbooks">
            <QuickBooksIntegration />
          </TabsContent>
        )}
      </Tabs>

      <EstimateWizard
        open={showEstimateWizard}
        onOpenChange={(open) => {
          setShowEstimateWizard(open);
          if (!open) setEditEstimateId(null);
        }}
        estimateId={editEstimateId}
      />

      <EstimateDetailModal
        open={showDetailModal}
        onOpenChange={setShowDetailModal}
        estimateId={selectedEstimateId}
        onEdit={(estimateId) => {
          setEditEstimateId(estimateId);
          setShowDetailModal(false);
          setShowEstimateWizard(true);
        }}
      />
    </div>
  );
}
