import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Droplets, ExternalLink } from "lucide-react";
import { apiRequest, useArrayQuery } from "@/lib/queryClient";
import { useLocation } from "wouter";
import type { Customer, IrrigationController } from "@workspace/db/schema";
import { IrrigationControllerGrid } from "./irrigation-controller-grid";

// Task #1857: customers.totalControllers is no longer written or read here.
// Controller count is derived from COUNT(*) on irrigation_controllers via the
// /api/customers/:id/controllers-profile endpoint, which this card already uses.

interface IrrigationSystemCardProps {
  customer: Customer;
  canManageControllers: boolean;
}

export function IrrigationSystemCard({ customer, canManageControllers }: IrrigationSystemCardProps) {
  const [, setLocation] = useLocation();
  const customerId = customer.id;

  const { data: controllers = [], isLoading, refetch } = useArrayQuery<IrrigationController>({
    queryKey: [`/api/customers/${customerId}/controllers-profile`],
    queryFn: () => apiRequest(`/api/customers/${customerId}/controllers-profile`),
  });

  // Zone total: sum totalZones directly from each controller row.
  // No letter derivation — letters are stored on irrigation_controllers.letter.
  const totalZones = controllers.reduce((sum, ctrl) => {
    return ctrl.totalZones != null ? sum + ctrl.totalZones : sum;
  }, 0);

  // Controller count comes from the loaded profile; fall back to 1 while loading.
  const controllerCount = controllers.length || 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Droplets className="w-5 h-5 text-blue-600" />
            Irrigation System
          </CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm text-gray-600">
              <span className="font-semibold text-gray-900">{controllerCount}</span>{" "}
              {controllerCount === 1 ? "controller" : "controllers"}
              <span className="mx-2 text-gray-300">•</span>
              <span className="font-semibold text-gray-900">{totalZones}</span>{" "}
              {totalZones === 1 ? "zone" : "zones"}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-blue-600 hover:text-blue-700 gap-1 h-8 px-2"
              onClick={() => setLocation(`/customers/${customerId}/irrigation-profile`)}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open Full Profile
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <div className="h-24 bg-gray-100 rounded-lg animate-pulse" />
            <div className="h-24 bg-gray-100 rounded-lg animate-pulse" />
          </div>
        ) : controllers.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <Droplets className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No controllers configured yet.</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setLocation(`/customers/${customerId}/irrigation-profile`)}
            >
              Open Full Profile to add controllers
            </Button>
          </div>
        ) : (
          <IrrigationControllerGrid
            controllers={controllers}
            customerId={customerId}
            canManageControllers={canManageControllers}
            canEditZones={canManageControllers}
            onRefreshList={() => refetch()}
          />
        )}
      </CardContent>
    </Card>
  );
}
