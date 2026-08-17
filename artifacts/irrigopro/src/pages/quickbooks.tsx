import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QuickBooksIntegration } from "@/components/quickbooks/quickbooks-integration";
import { Settings, DollarSign, Users } from "lucide-react";

export default function QuickBooksPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-full px-4 lg:px-6 py-4 lg:py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">QuickBooks Integration</h1>
          <p className="text-gray-600">
            Connect and manage your QuickBooks integration for automated invoicing and customer synchronization.
          </p>
        </div>

        <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {/* QuickBooks Connection Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-blue-600" />
                Connection Settings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <QuickBooksIntegration />
            </CardContent>
          </Card>

          {/* Features Overview Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-green-600" />
                Integration Features
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-blue-600 mt-2 flex-shrink-0"></div>
                <div>
                  <div className="font-medium text-sm">Customer Synchronization</div>
                  <div className="text-xs text-gray-600">
                    Automatically sync customers between IrrigoPro and QuickBooks
                  </div>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-green-600 mt-2 flex-shrink-0"></div>
                <div>
                  <div className="font-medium text-sm">Invoice Creation</div>
                  <div className="text-xs text-gray-600">
                    Create QuickBooks invoices directly from customer billing data
                  </div>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-purple-600 mt-2 flex-shrink-0"></div>
                <div>
                  <div className="font-medium text-sm">Monthly Consolidation</div>
                  <div className="text-xs text-gray-600">
                    Consolidate all customer work into single monthly invoices
                  </div>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-orange-600 mt-2 flex-shrink-0"></div>
                <div>
                  <div className="font-medium text-sm">Tax-Free Billing</div>
                  <div className="text-xs text-gray-600">
                    No markup on parts (bill at cost) with no tax calculations
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Usage Instructions Card */}
          <Card className="sm:col-span-2 lg:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-600" />
                How to Use QuickBooks Integration
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-3 lg:grid-cols-1">
                <div className="text-center">
                  <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 font-bold flex items-center justify-center mx-auto mb-2 text-sm">
                    1
                  </div>
                  <div className="font-medium text-sm mb-1">Connect</div>
                  <div className="text-xs text-gray-600">
                    Click "Connect to QuickBooks" and authorize the integration with your QuickBooks account
                  </div>
                </div>
                
                <div className="text-center">
                  <div className="w-8 h-8 rounded-full bg-green-100 text-green-600 font-bold flex items-center justify-center mx-auto mb-2 text-sm">
                    2
                  </div>
                  <div className="font-medium text-sm mb-1">Sync</div>
                  <div className="text-xs text-gray-600">
                    Go to Customer Billing page and use "Create Invoice" to sync customer data and generate invoices
                  </div>
                </div>
                
                <div className="text-center">
                  <div className="w-8 h-8 rounded-full bg-purple-100 text-purple-600 font-bold flex items-center justify-center mx-auto mb-2 text-sm">
                    3
                  </div>
                  <div className="font-medium text-sm mb-1">Manage</div>
                  <div className="text-xs text-gray-600">
                    Review and manage invoices directly in your QuickBooks dashboard
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
