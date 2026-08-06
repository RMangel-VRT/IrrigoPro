import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Package, ClipboardList, Plus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { apiRequest, useArrayQuery } from "@/lib/queryClient";
import type { WorkOrder } from "@workspace/db/schema";
import { Link } from "wouter";
import { BilledBadge } from "@/components/ui/billed-indicator";
import { BillingSheetWizard } from "@/components/billing/billing-sheet-wizard";

export default function FieldTechDashboard() {
  const [showBillingModal, setShowBillingModal] = useState(false);
  const { user: currentUser } = useAuth();

  // Get assigned work orders for this technician
  const { data: workOrders = [] } = useArrayQuery<WorkOrder>({
    queryKey: ["/api/work-orders", "technician", currentUser?.id],
    queryFn: () => apiRequest(`/api/work-orders?technician=${currentUser?.id}`, "GET"),
    enabled: !!currentUser?.id,
  });

  // Get billing sheets for this technician
  const { data: billingSheets } = useQuery({
    queryKey: ["/api/billing-sheets", "technician", currentUser?.id],
    queryFn: () => apiRequest(`/api/billing-sheets?technician=${currentUser?.id}`, "GET"),
    enabled: !!currentUser?.id,
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Field Tech Dashboard</h1>
          <p className="text-gray-600 mt-2 text-sm sm:text-base">Manage your work orders and billing sheets</p>
        </div>

        {/* Dashboard Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* Work Orders Card */}
          <Card className="hover:shadow-lg transition-all duration-200 border-2 hover:border-blue-200">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-blue-100 p-2 sm:p-3 rounded-full flex-shrink-0">
                    <Package className="w-6 h-6 sm:w-8 sm:h-8 text-blue-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-lg sm:text-xl text-gray-900">Work Orders</CardTitle>
                    <p className="text-gray-600 text-xs sm:text-sm">View assigned work</p>
                  </div>
                </div>
                <Badge variant="secondary" className="text-sm sm:text-lg px-2 sm:px-3 py-1 flex-shrink-0">
                  {workOrders?.length || 0}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-xs sm:text-sm">
                  <span className="text-gray-600">Assigned:</span>
                  <span className="font-medium">{workOrders?.filter(wo => wo.status === 'assigned').length || 0}</span>
                </div>
                <div className="flex justify-between text-xs sm:text-sm">
                  <span className="text-gray-600">In progress:</span>
                  <span className="font-medium">{workOrders?.filter(wo => wo.status === 'in_progress').length || 0}</span>
                </div>
                <div className="flex justify-between text-xs sm:text-sm">
                  <span className="text-gray-600">Completed / In Review:</span>
                  <span className="font-medium">{workOrders?.filter(wo => ['work_completed', 'pending_manager_review', 'approved_passed_to_billing'].includes(wo.status) && !wo.invoiceId).length || 0}</span>
                </div>
                {(workOrders?.filter(wo => wo.status === 'billed' || wo.invoiceId).length || 0) > 0 && (
                  <div className="flex justify-between text-xs sm:text-sm">
                    <span className="text-purple-600 flex items-center gap-1">
                      <BilledBadge />
                    </span>
                    <span className="font-medium text-purple-700">{workOrders?.filter(wo => wo.status === 'billed' || wo.invoiceId).length || 0}</span>
                  </div>
                )}
              </div>
              <Link href="/work-orders" className="block">
                <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white">
                  View Work Orders
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Onsite Billing Card */}
          <Card className="hover:shadow-lg transition-all duration-200 border-2 hover:border-orange-200">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="bg-orange-100 p-2 sm:p-3 rounded-full flex-shrink-0">
                  <ClipboardList className="w-6 h-6 sm:w-8 sm:h-8 text-orange-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-lg sm:text-xl text-gray-900">
                    Onsite Billing
                    <span className="text-sm font-normal text-gray-500 ml-2">(Billing Sheets)</span>
                  </CardTitle>
                  <p className="text-gray-600 text-xs sm:text-sm">Create billing for field work</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-xs sm:text-sm">
                  <span className="text-gray-600">My sheets:</span>
                  <span className="font-medium">{billingSheets?.length || 0}</span>
                </div>
                <div className="flex justify-between text-xs sm:text-sm">
                  <span className="text-gray-600">Drafts:</span>
                  <span className="font-medium">{billingSheets?.filter((bs: any) => bs.status === 'draft').length || 0}</span>
                </div>
                <div className="flex justify-between text-xs sm:text-sm">
                  <span className="text-gray-600">Approved:</span>
                  <span className="font-medium">{billingSheets?.filter((bs: any) => bs.status === 'billed').length || 0}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Link href="/billing-sheets" className="flex-1">
                  <Button className="w-full bg-orange-600 hover:bg-orange-700 text-white">
                    View Onsite Billing
                  </Button>
                </Link>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button 
                        className="bg-green-600 hover:bg-green-700 text-white px-3 min-w-[40px] shadow-md hover:shadow-lg transition-all h-10 border-4 border-orange-600 hover:border-orange-700 border-pulse"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setShowBillingModal(true);
                        }}
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Create New Onsite Billing</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Standalone Billing Sheet Modal */}
        <BillingSheetWizard
          open={showBillingModal}
          onClose={() => setShowBillingModal(false)}
        />
      </div>
    </div>
  );
}