import { safeGet } from "@/utils/safeStorage";
import { useState, useEffect, useRef } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/zod-resolver";
import { z } from "zod/v4";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarIcon, DollarSign, Percent, FileText, Tag, Plus, X, Building2, Bell } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { insertCustomerSchema } from "@workspace/db/schema";
import type { Customer, User } from "@workspace/db/schema";
import { composeStructuredAddress } from "@/lib/customer-address";

const moneyOrBlank = z
  .string()
  .regex(/^(\d+(\.\d{1,2})?)?$/u, "Must be a valid amount")
  .optional();

const customerFormSchema = insertCustomerSchema.extend({
  companyId: z.number().min(1, "Company ID is required"),
  irrigoName: z.string().optional(),
  totalControllers: z.coerce.number().min(1, "Must have at least 1 controller").max(26, "Maximum 26 controllers").default(1),
  contractType: z.enum(["standard", "premium", "commercial", "residential"]).default("standard"),
  laborRate: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid number").default("45.00"),
  emergencyLaborRate: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid number").default("125.00"),
  discountPercent: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid number").default("0.00"),
  paymentTerms: z.enum(["net_30", "net_15", "due_on_receipt"]).default("net_30"),
  contractStartDate: z.string().optional(),
  contractEndDate: z.string().optional(),
  notes: z.string().optional(),
  branches: z.array(z.string()).optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().optional(),
  // Task #687 — budget caps + alert routing. Caps are strings on the wire
  // (matches laborRate convention so the existing apiRequest path passes
  // them through unchanged); thresholds are integers; channels is a
  // plain object so it round-trips as JSON; recipient ids are numbers.
  monthlyBudgetCap: moneyOrBlank,
  annualBudgetCap: moneyOrBlank,
  // Spec: soft is a warning percent (1..99), hard is exceed percent
  // (2..200, must be strictly greater than soft when caps are set).
  budgetSoftThresholdPercent: z.coerce.number().int().min(1).max(99).default(75),
  budgetHardThresholdPercent: z.coerce.number().int().min(2).max(200).default(100),
  budgetAlertRecipientUserIds: z.array(z.number()).default([]),
  budgetAlertChannels: z
    .object({ inApp: z.boolean(), push: z.boolean(), email: z.boolean() })
    .default({ inApp: true, push: true, email: false }),
  budgetNotifyCustomerContact: z.boolean().default(false),
}).superRefine((data, ctx) => {
  // Only enforce soft < hard when at least one cap is actually set.
  // Otherwise the thresholds are inert and we don't want to block the form.
  const monthly = (data.monthlyBudgetCap ?? "").trim();
  const annual = (data.annualBudgetCap ?? "").trim();
  const capSet =
    (monthly !== "" && parseFloat(monthly) > 0) ||
    (annual !== "" && parseFloat(annual) > 0);
  if (capSet && data.budgetSoftThresholdPercent >= data.budgetHardThresholdPercent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Warning % must be lower than the exceeded %.",
      path: ["budgetSoftThresholdPercent"],
    });
  }
});

type CustomerFormData = z.infer<typeof customerFormSchema>;

function AddressPreview({ form }: { form: ReturnType<typeof useForm<CustomerFormData>> }) {
  const street = form.watch("street");
  const city = form.watch("city");
  const state = form.watch("state");
  const zip = form.watch("zip");
  const country = form.watch("country");
  const preview = composeStructuredAddress({ street, city, state, zip, country });
  return (
    <div className="rounded-md bg-white border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-600">
      <span className="font-semibold text-gray-700">Preview:</span>{" "}
      {preview ? <span data-testid="customer-address-preview">{preview}</span> : <span className="italic text-gray-400">Address parts will preview here.</span>}
    </div>
  );
}

const CONTRACT_TYPES = ["standard", "premium", "commercial", "residential"] as const;
type ContractType = typeof CONTRACT_TYPES[number];
function toContractType(value: string | null | undefined): ContractType {
  if (value && (CONTRACT_TYPES as readonly string[]).includes(value)) {
    return value as ContractType;
  }
  return "standard";
}

const PAYMENT_TERMS = ["net_30", "net_15", "due_on_receipt"] as const;
type PaymentTerms = typeof PAYMENT_TERMS[number];
function toPaymentTerms(value: string | null | undefined): PaymentTerms {
  if (value && (PAYMENT_TERMS as readonly string[]).includes(value)) {
    return value as PaymentTerms;
  }
  return "net_30";
}

function customerToFormValues(customer: Customer): CustomerFormData {
  return {
    name: customer.name,
    irrigoName: customer.irrigoName || customer.name,
    email: customer.email,
    phone: customer.phone || "",
    address: customer.address || "",
    street: customer.street || "",
    city: customer.city || "",
    state: customer.state || "",
    zip: customer.zip || "",
    country: customer.country || "",
    companyId: customer.companyId,
    totalControllers: customer.totalControllers || 1,
    contractType: toContractType(customer.contractType),
    laborRate: customer.laborRate || "45.00",
    emergencyLaborRate: customer.emergencyLaborRate || "125.00",
    discountPercent: customer.discountPercent || "0.00",
    paymentTerms: toPaymentTerms(customer.paymentTerms),
    contractStartDate: customer.contractStartDate ? new Date(customer.contractStartDate).toISOString().split('T')[0] : "",
    contractEndDate: customer.contractEndDate ? new Date(customer.contractEndDate).toISOString().split('T')[0] : "",
    notes: customer.notes || "",
    branches: (customer as any).branches || [],
    monthlyBudgetCap: customer.monthlyBudgetCap ?? "",
    annualBudgetCap: customer.annualBudgetCap ?? "",
    budgetSoftThresholdPercent: customer.budgetSoftThresholdPercent ?? 75,
    budgetHardThresholdPercent: customer.budgetHardThresholdPercent ?? 100,
    budgetAlertRecipientUserIds: (customer.budgetAlertRecipientUserIds as number[] | null) ?? [],
    budgetAlertChannels: (customer.budgetAlertChannels as { inApp: boolean; push: boolean; email: boolean } | null) ?? {
      inApp: true,
      push: true,
      email: false,
    },
    budgetNotifyCustomerContact: customer.budgetNotifyCustomerContact ?? false,
  };
}

interface CustomerFormProps {
  customer?: Customer;
  trigger: React.ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CustomerForm({ customer, trigger, defaultOpen = false, onOpenChange }: CustomerFormProps) {
  const [open, setOpenState] = useState(defaultOpen);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Tracks form values saved in the most recent successful mutation so the
  // open-trigger reset does not overwrite them before the query refetches.
  const justSavedValues = useRef<CustomerFormData | null>(null);

  // Get user from localStorage (production-compatible)
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  
  useEffect(() => {
    const savedUser = safeGet("user");
    if (savedUser) {
      try {
        setCurrentUser(JSON.parse(savedUser));
      } catch (error) {
        console.error("Error parsing user data:", error);
      }
    }
    setIsLoadingUser(false);
  }, []);

  const companyId = currentUser?.companyId;

  const [newBranchInput, setNewBranchInput] = useState("");

  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: customer ? customerToFormValues(customer) : {
      name: "",
      irrigoName: "",
      email: "",
      phone: "",
      address: "",
      street: "",
      city: "",
      state: "",
      zip: "",
      country: "",
      companyId: companyId || currentUser?.companyId || 3,
      totalControllers: 1,
      contractType: "standard",
      laborRate: "45.00",
      emergencyLaborRate: "125.00",
      discountPercent: "0.00",
      paymentTerms: "net_30",
      contractStartDate: "",
      contractEndDate: "",
      notes: "",
      branches: [],
      monthlyBudgetCap: "",
      annualBudgetCap: "",
      budgetSoftThresholdPercent: 75,
      budgetHardThresholdPercent: 100,
      budgetAlertRecipientUserIds: [],
      budgetAlertChannels: { inApp: true, push: true, email: false },
      budgetNotifyCustomerContact: false,
    },
  });

  // Re-initialize form with latest customer data whenever the dialog opens.
  // If we just saved, use the saved values (the query refetch may not have
  // completed yet), then clear the ref so subsequent opens use fresh server data.
  useEffect(() => {
    if (open && customer) {
      if (justSavedValues.current) {
        form.reset(justSavedValues.current);
        justSavedValues.current = null;
      } else {
        form.reset(customerToFormValues(customer));
      }
    }
  }, [open, customer, form]);

  // Update companyId when user data loads
  useEffect(() => {
    if (companyId && !customer) {
      form.setValue('companyId', companyId);
    }
  }, [companyId, customer, form]);

  // For new customers: auto-fill irrigoName from name as the user types (only while irrigoName is still blank)
  const watchedName = form.watch("name");
  const watchedIrrigoName = form.watch("irrigoName");
  useEffect(() => {
    if (!customer && (!watchedIrrigoName || watchedIrrigoName === "")) {
      form.setValue("irrigoName", watchedName);
    }
  }, [watchedName, customer, form]);

  const mutation = useMutation({
    mutationFn: async (data: CustomerFormData) => {
      const endpoint = customer ? `/api/customers/${customer.id}` : "/api/customers";
      const method = customer ? "PUT" : "POST";

      // Task #347 — when the user has filled in any structured address part,
      // also keep the legacy single-line `address` in sync so older code
      // paths (PDFs, QuickBooks sync, list rows) keep working.
      const structured = composeStructuredAddress(data);
      const addressForServer = structured || (data.address || "");

      return apiRequest(endpoint, method, {
        ...data,
        address: addressForServer,
        contractStartDate: data.contractStartDate ? new Date(data.contractStartDate).toISOString() : null,
        contractEndDate: data.contractEndDate ? new Date(data.contractEndDate).toISOString() : null,
      });
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      // Task #687: the budget-usage snapshot depends on cap/threshold
      // values we just persisted — bust the per-customer cache so the
      // LiveBudgetPreview and the customer-profile Budget card pick up
      // the new server-side classification on the next render.
      if (customer) {
        queryClient.invalidateQueries({
          queryKey: [`/api/customers/${customer.id}/budget-usage`],
        });
      }
      justSavedValues.current = variables;
      form.reset(variables);
      setOpen(false);
      toast({
        title: customer ? "Customer Updated" : "Customer Created",
        description: customer ? "Customer information has been updated successfully." : "New customer has been added to your database.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save customer",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: CustomerFormData) => {
    // Ensure companyId is set for new customers
    const submissionData = {
      ...data,
      companyId: companyId || currentUser?.companyId
    };
    
    if (!submissionData.companyId || submissionData.companyId < 1) {
      toast({
        title: "Error",
        description: "Unable to determine company. Please refresh and try again.",
        variant: "destructive",
      });
      return;
    }
    
    mutation.mutate({
      ...submissionData,
      companyId: submissionData.companyId as number
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger}
      </DialogTrigger>
      <DialogContent className="w-[95vw] max-w-4xl h-[95vh] max-h-[95vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>
            {customer ? "Edit Customer" : "Add New Customer"}
          </DialogTitle>
        </DialogHeader>

        {isLoadingUser ? (
          <div className="flex items-center justify-center p-8">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-2 text-sm text-gray-600">Loading user data...</p>
            </div>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Basic Information */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* IrrigoPro Display Name — prominently styled */}
                <div className="rounded-xl border-2 border-emerald-400 bg-emerald-50 p-4 shadow-sm">
                  <FormField
                    control={form.control}
                    name="irrigoName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-2 text-emerald-800 font-semibold text-base">
                          <Tag className="w-4 h-4 text-emerald-600" />
                          IrrigoPro Display Name
                          <Badge className="bg-emerald-600 text-white text-xs px-2 py-0.5 ml-1">Irrigo Facing</Badge>
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Enter the name your team will see (e.g. property name)"
                            className="border-emerald-300 focus:border-emerald-500 focus:ring-emerald-500 bg-white text-base font-medium"
                            {...field}
                            value={field.value || ""}
                          />
                        </FormControl>
                        <p className="text-xs text-emerald-700 mt-1">
                          This is what all IrrigoPro users see — use the property name or nickname your team knows this customer by.
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Official Customer Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Enter official/QuickBooks customer name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email Address</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="Enter email address" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone Number</FormLabel>
                        <FormControl>
                          <Input placeholder="Enter phone number" {...field} value={field.value || ""} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Structured address (Task #347) — better geocoding + search.
                    The legacy single-line `address` is hidden but still
                    populated from these parts on submit for back-compat. */}
                <div className="rounded-lg border bg-gray-50 p-4 space-y-4">
                  <div className="text-sm font-medium text-gray-700">Address</div>
                  <FormField
                    control={form.control}
                    name="street"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Street</FormLabel>
                        <FormControl>
                          <Input placeholder="123 Main St" {...field} value={field.value || ""} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="city"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">City</FormLabel>
                          <FormControl>
                            <Input placeholder="Springfield" {...field} value={field.value || ""} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="state"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">State</FormLabel>
                            <FormControl>
                              <Input placeholder="IL" maxLength={32} {...field} value={field.value || ""} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="zip"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">ZIP / Postal</FormLabel>
                            <FormControl>
                              <Input placeholder="62704" {...field} value={field.value || ""} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>
                  <FormField
                    control={form.control}
                    name="country"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Country</FormLabel>
                        <FormControl>
                          <Input placeholder="USA" {...field} value={field.value || ""} />
                        </FormControl>
                        <FormDescription className="text-xs">
                          Optional — defaults to USA when geocoding the address.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <AddressPreview form={form} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="totalControllers"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Number of Controllers</FormLabel>
                        <FormControl>
                          <Select onValueChange={(value) => field.onChange(parseInt(value))} value={field.value?.toString()}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select number of controllers" />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 26 }, (_, i) => (
                                <SelectItem key={i + 1} value={(i + 1).toString()}>
                                  {i + 1} Controller{i + 1 > 1 ? 's' : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Contract Information */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center">
                  <FileText className="w-5 h-5 mr-2" />
                  Contract Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="contractType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contract Type</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select contract type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="standard">Standard</SelectItem>
                            <SelectItem value="premium">Premium</SelectItem>
                            <SelectItem value="commercial">Commercial</SelectItem>
                            <SelectItem value="residential">Residential</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="contractStartDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contract Start Date</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="contractEndDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Contract End Date</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="paymentTerms"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Payment Terms</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select payment terms" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="net_30">Net 30 Days</SelectItem>
                          <SelectItem value="net_15">Net 15 Days</SelectItem>
                          <SelectItem value="due_on_receipt">Due on Receipt</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Billing Rates */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center">
                  <DollarSign className="w-5 h-5 mr-2" />
                  Billing Rates
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="laborRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Labor Rate (per hour)</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                            <Input placeholder="45.00" {...field} className="pl-10" />
                          </div>
                        </FormControl>
                        <FormDescription>
                          Hourly rate for labor charges
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="emergencyLaborRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Emergency Labor Rate (per hour)</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                            <Input placeholder="125.00" {...field} className="pl-10" />
                          </div>
                        </FormControl>
                        <FormDescription>
                          Hourly rate for emergency labor calls
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="discountPercent"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Discount Percentage</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Percent className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                            <Input placeholder="0.00" {...field} className="pl-10" />
                          </div>
                        </FormControl>
                        <FormDescription>
                          Default discount for this customer
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Budget & Alerts — Task #687 (Financial Pulse Slice 1).
                Only company_admin / billing_manager / super_admin can edit
                budget configuration; everyone else sees a read-only stub
                on the customer profile. */}
            {(currentUser?.role === "company_admin" ||
              currentUser?.role === "billing_manager" ||
              currentUser?.role === "super_admin") && (
              <BudgetAndAlertsCard form={form} customer={customer} />
            )}

            {/* Branch Management */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center">
                  <Building2 className="w-5 h-5 mr-2" />
                  Branch Locations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="branches"
                  render={({ field }) => {
                    const branches = field.value || [];
                    const addBranch = () => {
                      const trimmed = newBranchInput.trim();
                      if (!trimmed || branches.includes(trimmed)) return;
                      field.onChange([...branches, trimmed]);
                      setNewBranchInput("");
                    };
                    const removeBranch = (index: number) => {
                      field.onChange(branches.filter((_, i) => i !== index));
                    };
                    return (
                      <FormItem>
                        <p className="text-sm text-gray-500 mb-3">
                          Add branch names for customers with multiple locations (e.g. a bank with multiple branches). When branches are defined, a required "Branch" dropdown will appear on billing sheets and work orders for this customer.
                        </p>
                        <div className="space-y-2">
                          {branches.map((branch, index) => (
                            <div key={index} className="flex items-center gap-2">
                              <span className="flex-1 text-sm bg-blue-50 border border-blue-200 rounded-md px-3 py-1.5 text-blue-900">
                                {branch}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeBranch(index)}
                                className="text-red-500 hover:text-red-700 h-8 w-8 p-0"
                              >
                                <X className="w-4 h-4" />
                              </Button>
                            </div>
                          ))}
                          <div className="flex gap-2 mt-2">
                            <Input
                              placeholder="Enter branch name..."
                              value={newBranchInput}
                              onChange={(e) => setNewBranchInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addBranch();
                                }
                              }}
                              className="flex-1"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              onClick={addBranch}
                              disabled={!newBranchInput.trim()}
                              className="gap-1"
                            >
                              <Plus className="w-4 h-4" />
                              Add
                            </Button>
                          </div>
                        </div>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
              </CardContent>
            </Card>

            {/* Notes */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Additional Notes</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Enter any additional notes about this customer..."
                          className="min-h-[100px]"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <div className="flex justify-end space-x-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Saving..." : customer ? "Update Customer" : "Create Customer"}
              </Button>
            </div>
          </form>
        </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Task #687 — Budget & Alerts section ─────────────────────────────────────
// Lives in the same file as the form so it can share the typed form
// instance. Renders the cap inputs, the soft/hard thresholds, the alert
// channel toggles, the recipients picker, and a live usage preview that
// re-queries when caps or thresholds change. The preview is only shown
// when editing an existing customer (we need an id to ask the server).

interface BudgetSectionProps {
  form: ReturnType<typeof useForm<CustomerFormData>>;
  customer?: Customer;
}

type BudgetStatus = "unset" | "healthy" | "approaching" | "over";

interface BudgetUsageResponse {
  customerId: number;
  softThresholdPercent: number;
  hardThresholdPercent: number;
  currentMonthKey: string;
  currentYearKey: string;
  monthlyCap: number | null;
  monthlySpend: number;
  monthlyPercent: number | null;
  monthlyStatus: BudgetStatus;
  annualCap: number | null;
  annualSpend: number;
  annualPercent: number | null;
  annualStatus: BudgetStatus;
}

function statusTone(status: BudgetStatus): string {
  switch (status) {
    case "over":
      return "bg-red-50 text-red-800 border-red-200";
    case "approaching":
      return "bg-amber-50 text-amber-800 border-amber-200";
    case "healthy":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    default:
      return "bg-gray-50 text-gray-600 border-gray-200";
  }
}

function statusLabel(status: BudgetStatus): string {
  if (status === "over") return "Over cap";
  if (status === "approaching") return "Approaching cap";
  if (status === "healthy") return "On track";
  return "No cap set";
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function BudgetAndAlertsCard({ form, customer }: BudgetSectionProps) {
  const companyId = form.watch("companyId");
  // Pool of users that can be added as alert recipients. Filter to
  // non-field_tech users in the same company.
  const { data: users } = useQuery<User[]>({
    queryKey: ["/api/users"],
  });
  const recipientOptions = (users || []).filter(
    (u) => u.companyId === companyId && u.role !== "field_tech" && u.isActive,
  );

  // Default recipients on NEW customers (no `customer` prop) to every
  // billing_manager in the company — they're the typical owner of cap
  // alerts and admins can still deselect them.
  const currentRecipients = form.watch("budgetAlertRecipientUserIds") || [];
  useEffect(() => {
    if (customer) return;
    if (currentRecipients.length > 0) return;
    if (!recipientOptions.length) return;
    const bms = recipientOptions
      .filter((u) => u.role === "billing_manager")
      .map((u) => u.id);
    if (bms.length > 0) form.setValue("budgetAlertRecipientUserIds", bms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, recipientOptions.length]);

  return (
    <Card id="budget-and-alerts">
      <CardHeader>
        <CardTitle className="text-lg flex items-center">
          <Bell className="w-5 h-5 mr-2" />
          Budget &amp; Alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="monthlyBudgetCap"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Monthly Budget Cap</FormLabel>
                <FormControl>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder="No cap"
                      {...field}
                      value={field.value ?? ""}
                      className="pl-10"
                      data-testid="monthly-budget-cap-input"
                    />
                  </div>
                </FormControl>
                <FormDescription>Leave blank for no monthly cap.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="annualBudgetCap"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Annual Budget Cap</FormLabel>
                <FormControl>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder="No cap"
                      {...field}
                      value={field.value ?? ""}
                      className="pl-10"
                      data-testid="annual-budget-cap-input"
                    />
                  </div>
                </FormControl>
                <FormDescription>Leave blank for no annual cap.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="budgetSoftThresholdPercent"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Warning Threshold (%)</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Percent className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      {...field}
                      value={field.value ?? 75}
                      onChange={(e) => field.onChange(parseInt(e.target.value || "0", 10))}
                      className="pl-10"
                    />
                  </div>
                </FormControl>
                <FormDescription>Fire a warning at this % of the cap.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="budgetHardThresholdPercent"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Exceeded Threshold (%)</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Percent className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      {...field}
                      value={field.value ?? 100}
                      onChange={(e) => field.onChange(parseInt(e.target.value || "0", 10))}
                      className="pl-10"
                    />
                  </div>
                </FormControl>
                <FormDescription>Fire an exceeded alert at this % of the cap.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="budgetAlertChannels"
          render={({ field }) => {
            const value = field.value || { inApp: true, push: true, email: false };
            const toggle = (key: "inApp" | "push" | "email") => (next: boolean) =>
              field.onChange({ ...value, [key]: next });
            return (
              <FormItem>
                <FormLabel>Alert Channels</FormLabel>
                <div className="flex flex-wrap gap-4 mt-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={value.inApp} onCheckedChange={(v) => toggle("inApp")(!!v)} />
                    In-app
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={value.push} onCheckedChange={(v) => toggle("push")(!!v)} />
                    Push
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={value.email} onCheckedChange={(v) => toggle("email")(!!v)} />
                    Email
                  </label>
                </div>
                <FormDescription>
                  Channels used to deliver budget warning and exceeded alerts.
                </FormDescription>
              </FormItem>
            );
          }}
        />

        <FormField
          control={form.control}
          name="budgetAlertRecipientUserIds"
          render={({ field }) => {
            const selected = new Set<number>((field.value || []) as number[]);
            const toggle = (id: number) => {
              const next = new Set(selected);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              field.onChange(Array.from(next));
            };
            return (
              <FormItem>
                <FormLabel>Alert Recipients</FormLabel>
                <div className="rounded-md border bg-white p-3 max-h-40 overflow-y-auto space-y-1">
                  {recipientOptions.length === 0 && (
                    <p className="text-xs text-gray-500 italic">
                      No eligible users in this company yet.
                    </p>
                  )}
                  {recipientOptions.map((u) => (
                    <label key={u.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected.has(u.id)}
                        onCheckedChange={() => toggle(u.id)}
                      />
                      <span>
                        {u.name}{" "}
                        <span className="text-gray-500 text-xs">({u.role})</span>
                      </span>
                    </label>
                  ))}
                </div>
                <FormDescription>
                  Only company admins, billing managers, and irrigation managers are eligible.
                </FormDescription>
              </FormItem>
            );
          }}
        />

        <FormField
          control={form.control}
          name="budgetNotifyCustomerContact"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <FormLabel className="text-sm">Also notify customer contact</FormLabel>
                <FormDescription className="text-xs">
                  When enabled, the customer's email on file is also notified when this customer's
                  budget is approaching or exceeds the cap.
                </FormDescription>
              </div>
              <FormControl>
                <Switch checked={!!field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />

        {customer && <LiveBudgetPreview customer={customer} form={form} />}
      </CardContent>
    </Card>
  );
}

function LiveBudgetPreview({ customer, form }: { customer: Customer; form: BudgetSectionProps["form"] }) {
  // Watch cap/threshold values so the preview re-classifies as the user
  // types. The server endpoint is the source of truth for the spend
  // numbers; on every cap/threshold change we also re-fetch /budget-usage
  // so a freshly invalidated snapshot (e.g. after save) reflects the new
  // server-side calculation.
  const monthlyCap = form.watch("monthlyBudgetCap");
  const annualCap = form.watch("annualBudgetCap");
  const softPct = form.watch("budgetSoftThresholdPercent");
  const hardPct = form.watch("budgetHardThresholdPercent");

  const { data, isLoading, refetch } = useQuery<BudgetUsageResponse>({
    queryKey: [`/api/customers/${customer.id}/budget-usage`],
  });

  // Re-fetch the live spend whenever caps/thresholds change so the
  // preview never shows stale data after an in-form edit or a save.
  useEffect(() => {
    refetch();
  }, [monthlyCap, annualCap, softPct, hardPct, refetch]);

  if (isLoading || !data) {
    return (
      <div
        className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-xs text-gray-500"
        data-testid="budget-preview-loading"
      >
        Loading current spend…
      </div>
    );
  }

  // Re-classify locally using the in-progress form values so the user
  // sees the impact of edits before saving. The spend totals come from
  // the server (we don't try to recompute those client-side).
  const previewStatus = (cap: string | undefined, spend: number) => {
    const capNum = cap && cap !== "" ? parseFloat(cap) : NaN;
    if (!Number.isFinite(capNum) || capNum <= 0) return { status: "unset" as const, percent: null };
    const pct = spend / capNum;
    const soft = Number(softPct) || 75;
    const hard = Number(hardPct) || 100;
    if (pct * 100 >= hard) return { status: "over" as const, percent: pct };
    if (pct * 100 >= soft) return { status: "approaching" as const, percent: pct };
    return { status: "healthy" as const, percent: pct };
  };

  const monthly = previewStatus(monthlyCap, data.monthlySpend);
  const annual = previewStatus(annualCap, data.annualSpend);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="budget-preview">
      <PreviewRow
        label={`This month (${data.currentMonthKey})`}
        spend={data.monthlySpend}
        cap={monthlyCap && monthlyCap !== "" ? parseFloat(monthlyCap) : null}
        status={monthly.status}
        percent={monthly.percent}
      />
      <PreviewRow
        label={`This year (${data.currentYearKey})`}
        spend={data.annualSpend}
        cap={annualCap && annualCap !== "" ? parseFloat(annualCap) : null}
        status={annual.status}
        percent={annual.percent}
      />
    </div>
  );
}

function PreviewRow({
  label,
  spend,
  cap,
  status,
  percent,
}: {
  label: string;
  spend: number;
  cap: number | null;
  status: "unset" | "healthy" | "approaching" | "over";
  percent: number | null;
}) {
  return (
    <div className={`rounded-md border p-3 text-sm ${statusTone(status)}`}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <Badge variant="outline" className="bg-white">{statusLabel(status)}</Badge>
      </div>
      <div className="mt-1 text-xs">
        {cap == null ? (
          <span>Spent {formatCurrency(spend)} — no cap set</span>
        ) : (
          <>
            <Progress
              value={percent != null ? Math.min(100, Math.round(percent * 100)) : 0}
              className="mt-1"
            />
            <span className="block mt-1">
              {formatCurrency(spend)} of {formatCurrency(cap)}
              {percent != null && ` (${Math.round(percent * 100)}%)`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}