import { safeGet } from "@/utils/safeStorage";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, User, Edit, UserX, Mail, Shield, Wrench, Crown, Trash2, AlertTriangle, Archive, Database, Key, MailCheck, CheckCircle, MoreVertical, Calculator } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/zod-resolver";
import { z } from "zod/v4";
import { apiRequest, queryClient, useArrayQuery } from "../lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const userFormSchema = z.object({
  phone: z.string().min(10, "Phone number is required (minimum 10 digits)"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Must be a valid email").optional().or(z.literal("")),
  role: z.enum(["irrigation_manager", "field_tech", "billing_manager", "bookkeeper"]),
});

const editUserFormSchema = z.object({
  phone: z.string().optional().or(z.literal("")),
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Must be a valid email").optional().or(z.literal("")),
  role: z.enum(["irrigation_manager", "field_tech", "billing_manager", "bookkeeper"]),
});

const changePasswordSchema = z.object({
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(6, "Password must be at least 6 characters"),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type UserFormData = z.infer<typeof userFormSchema>;
type EditUserFormData = z.infer<typeof editUserFormSchema>;
type ChangePasswordData = z.infer<typeof changePasswordSchema>;

interface User {
  id: number;
  username: string;
  name: string;
  email: string;
  phone?: string;
  role: string;
  companyId: number;
  isActive: boolean;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpires?: string;
  createdAt: string;
  updatedAt: string;
}

export default function CompanyUserManagement() {
  const { toast } = useToast();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [changingPasswordUser, setChangingPasswordUser] = useState<User | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [userDependencies, setUserDependencies] = useState<any>(null);
  const [isLoadingDependencies, setIsLoadingDependencies] = useState(false);
  const [sendingVerification, setSendingVerification] = useState<number | null>(null);

  // Get current user from localStorage
  useEffect(() => {
    const user = safeGet("user");
    if (user) {
      setCurrentUser(JSON.parse(user));
    }
  }, []);

  // Fetch company users
  const { data: users = [], isLoading, error, refetch } = useArrayQuery<User>({
    queryKey: [`/api/company/${currentUser?.companyId}/users`],
    enabled: !!currentUser?.companyId,
    retry: false,
  });

  // Check if company setup is required
  const requiresSetup = error && (error as any).message?.includes('423');

  // Hooks must stay above the `if (requiresSetup)` early return below
  // (Rules of Hooks).
  const createForm = useForm<UserFormData>({
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      phone: "",
      password: "",
      name: "",
      email: "",
      role: "field_tech",
    },
  });

  const editForm = useForm<EditUserFormData>({
    resolver: zodResolver(editUserFormSchema),
    defaultValues: {
      phone: "",
      name: "",
      email: "",
      role: "field_tech",
    },
  });

  const passwordForm = useForm<ChangePasswordData>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      newPassword: "",
      confirmPassword: "",
    },
  });

  // If setup is required, show message to complete setup first
  if (requiresSetup) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              User Management
            </CardTitle>
            <CardDescription>
              Company profile setup required before managing users
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <div className="mb-4">
                <User className="h-12 w-12 text-gray-400 mx-auto" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Complete Company Setup First</h3>
              <p className="text-gray-600 mb-4">
                You need to set up your company profile before you can manage users.
              </p>
              <Button 
                onClick={() => window.location.href = '/company-profile'}
                className="min-w-[140px]"
              >
                Go to Company Setup
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const onCreateSubmit = async (data: UserFormData) => {
    try {
      await apiRequest(`/api/company/${currentUser?.companyId}/users`, "POST", data);

      queryClient.invalidateQueries({ queryKey: [`/api/company/${currentUser?.companyId}/users`] });
      setIsCreateDialogOpen(false);
      createForm.reset();
      toast({
        title: "Success",
        description: "User created successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to create user",
        variant: "destructive",
      });
    }
  };

  const onEditSubmit = async (data: EditUserFormData) => {
    if (!editingUser) return;
    
    try {
      await apiRequest(`/api/company/${currentUser?.companyId}/users/${editingUser.id}`, "PUT", data);

      queryClient.invalidateQueries({ queryKey: [`/api/company/${currentUser?.companyId}/users`] });
      setEditingUser(null);
      editForm.reset();
      toast({
        title: "Success",
        description: "User updated successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update user",
        variant: "destructive",
      });
    }
  };

  const handleDeactivateUser = async (user: User) => {
    try {
      await apiRequest(`/api/company/${currentUser?.companyId}/users/${user.id}/deactivate`, "POST");

      queryClient.invalidateQueries({ queryKey: [`/api/company/${currentUser?.companyId}/users`] });
      toast({
        title: "Success",
        description: "User deactivated successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to deactivate user",
        variant: "destructive",
      });
    }
  };

  const checkUserDependencies = async (user: User) => {
    setDeletingUser(user);
    setIsLoadingDependencies(true);
    try {
      const response = await apiRequest(`/api/users/${user.id}/dependencies`, "GET");
      setUserDependencies(response);
    } catch (error) {
      console.error('Failed to check user dependencies:', error);
      setUserDependencies(null);
      toast({
        title: "Error",
        description: "Failed to analyze user data",
        variant: "destructive",
      });
    } finally {
      setIsLoadingDependencies(false);
    }
  };

  const handleSmartDelete = async () => {
    if (!deletingUser) return;
    try {
      const response = await apiRequest(`/api/users/${deletingUser.id}`, "DELETE");
      
      queryClient.invalidateQueries({ queryKey: [`/api/company/${currentUser?.companyId}/users`] });
      setDeletingUser(null);
      setUserDependencies(null);
      
      toast({
        title: "Success",
        description: response.message || "User deleted successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete user",
        variant: "destructive",
      });
    }
  };

  const handleSoftDelete = async () => {
    if (!deletingUser) return;
    try {
      const response = await apiRequest(`/api/users/${deletingUser.id}/soft-delete`, "POST");
      
      queryClient.invalidateQueries({ queryKey: [`/api/company/${currentUser?.companyId}/users`] });
      setDeletingUser(null);
      setUserDependencies(null);
      
      toast({
        title: "Success",
        description: "User deleted (data preserved for business records)",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete user",
        variant: "destructive",
      });
    }
  };

  const onPasswordChangeSubmit = async (data: ChangePasswordData) => {
    if (!changingPasswordUser) return;
    
    try {
      await apiRequest(`/api/company/${currentUser?.companyId}/users/${changingPasswordUser.id}/change-password`, "POST", {
        newPassword: data.newPassword
      });

      setChangingPasswordUser(null);
      passwordForm.reset();
      toast({
        title: "Success",
        description: "Password changed successfully",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to change password",
        variant: "destructive",
      });
    }
  };

  const handleHardDelete = async () => {
    if (!deletingUser) return;
    try {
      const response = await apiRequest(`/api/users/${deletingUser.id}/hard-delete`, "DELETE");
      
      queryClient.invalidateQueries({ queryKey: [`/api/company/${currentUser?.companyId}/users`] });
      setDeletingUser(null);
      setUserDependencies(null);
      
      toast({
        title: "Success",
        description: "User permanently deleted with data cleanup",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to delete user",
        variant: "destructive",
      });
    }
  };

  const handleEditUser = (user: User) => {
    setEditingUser(user);
    editForm.setValue("phone", user.phone || "");
    editForm.setValue("name", user.name);
    editForm.setValue("email", user.email || "");
    editForm.setValue("role", user.role as EditUserFormData["role"]);
  };

  const handleResendVerification = async (user: User) => {
    if (!user.email || user.emailVerified) {
      return;
    }
    
    setSendingVerification(user.id);
    try {
      await apiRequest("/api/auth/resend-verification", "POST", {
        email: user.email
      });
      
      toast({
        title: "Success",
        description: `Verification email sent to ${user.email}`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to send verification email",
        variant: "destructive",
      });
    } finally {
      setSendingVerification(null);
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case "company_admin":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
      case "irrigation_manager":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "field_tech":
        return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200";
      case "billing_manager":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      case "bookkeeper":
        return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "company_admin":
        return <Crown className="w-4 h-4" />;
      case "irrigation_manager":
        return <Shield className="w-4 h-4" />;
      case "field_tech":
        return <Wrench className="w-4 h-4" />;
      case "billing_manager":
        return <Mail className="w-4 h-4" />;
      case "bookkeeper":
        return <Calculator className="w-4 h-4" />;
      default:
        return <User className="w-4 h-4" />;
    }
  };

  const getRoleDisplayName = (role: string) => {
    switch (role) {
      case "company_admin":
        return "Company Admin";
      case "irrigation_manager":
        return "Irrigation Manager";
      case "field_tech":
        return "Field Tech";
      case "billing_manager":
        return "Billing Manager";
      case "bookkeeper":
        return "Bookkeeper";
      default:
        return role;
    }
  };

  // Access control check - moved after all hooks
  if (!currentUser || currentUser.role !== "company_admin") {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-red-600">Access Denied</h2>
              <p className="text-gray-600 mt-2">You must be a company admin to access user management.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading check - moved after all hooks  
  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-lg">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground">
            Manage users in your company
          </p>
        </div>
        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Add User
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New User</DialogTitle>
              <DialogDescription>
                Add a new user to your company
              </DialogDescription>
            </DialogHeader>
            <Form {...createForm}>
              <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4">
                <FormField
                  control={createForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full Name</FormLabel>
                      <FormControl>
                        <Input placeholder="John Doe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone Number</FormLabel>
                      <FormControl>
                        <Input type="tel" placeholder="5551234567" {...field} />
                      </FormControl>
                      <p className="text-xs text-gray-500">Used as their login username</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a role" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="irrigation_manager">Manager</SelectItem>
                          <SelectItem value="field_tech">Field Tech</SelectItem>
                          <SelectItem value="billing_manager">Billing Manager</SelectItem>
                          <SelectItem value="bookkeeper">Bookkeeper</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email <span className="text-gray-400 font-normal">(optional)</span></FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="john@example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end space-x-2 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsCreateDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit">Create User</Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <User className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.filter((u: User) => u.isActive).length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Field Techs</CardTitle>
            <Wrench className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.filter((u: User) => u.role === 'field_tech').length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Managers</CardTitle>
            <Shield className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.filter((u: User) => u.role === 'irrigation_manager').length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Mobile Card View */}
      <div className="lg:hidden space-y-3">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-center space-x-3">
                <div className="h-10 w-10 bg-gray-200 rounded-lg animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
                  <div className="h-3 w-24 bg-gray-200 rounded animate-pulse" />
                </div>
              </div>
            </Card>
          ))
        ) : (
          users.map((user: User) => (
            <Card key={user.id} className="p-4 hover:shadow-md transition-shadow">
              {/* Header Section - User Info and Role Badge */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center space-x-3 flex-1 min-w-0">
                  <div className="flex-shrink-0">
                    {getRoleIcon(user.role)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{user.name}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {user.phone ? user.phone : `@${user.username}`}
                    </div>
                    {user.email && (
                      <div className="text-xs text-gray-400 truncate flex items-center gap-1">
                        {user.email}
                        <span className="flex items-center">
                          {user.emailVerified ? (
                            <CheckCircle className="w-3 h-3 text-green-600" aria-label="Email verified" />
                          ) : (
                            <Mail className="w-3 h-3 text-orange-500" aria-label="Email not verified" />
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0">
                  <Badge className={getRoleBadgeColor(user.role)} variant="outline">
                    {getRoleDisplayName(user.role)}
                  </Badge>
                </div>
              </div>
              
              {/* Footer Section - Status and Actions */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Badge variant={user.isActive ? "default" : "secondary"}>
                    {user.isActive ? "Active" : "Inactive"}
                  </Badge>
                  <div className="text-xs text-gray-500">
                    Joined {new Date(user.createdAt).toLocaleDateString()}
                  </div>
                </div>
                
                {/* Action Buttons */}
                {user.id !== currentUser?.id && (
                  <div className="flex space-x-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="text-blue-600 hover:text-blue-900 p-1"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEditUser(user)}>
                          <Edit className="w-4 h-4 mr-2" />
                          Edit User
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => checkUserDependencies(user)}>
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete User
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="text-green-600 hover:text-green-900 p-1"
                      onClick={() => setChangingPasswordUser(user)}
                    >
                      <Key className="w-4 h-4" />
                    </Button>
                    {user.email && !user.emailVerified && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="text-orange-600 hover:text-orange-900 p-1"
                        onClick={() => handleResendVerification(user)}
                        disabled={sendingVerification === user.id}
                        title="Resend verification email"
                      >
                        <MailCheck className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Desktop Table View */}
      <div className="hidden lg:block">
        <Card>
          <CardHeader>
            <CardTitle>Company Users</CardTitle>
            <CardDescription>
              All users in your company with their roles and status
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user: User) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex items-center space-x-3">
                          <div className="flex-shrink-0">
                            {getRoleIcon(user.role)}
                          </div>
                          <div>
                            <div className="font-medium">{user.name}</div>
                            <div className="text-sm text-muted-foreground">
                              {user.phone ? user.phone : `@${user.username}`}
                            </div>
                            {user.email && (
                              <div className="text-xs text-muted-foreground flex items-center gap-1">
                                {user.email}
                                <span className="flex items-center">
                                  {user.emailVerified ? (
                                    <CheckCircle className="w-3 h-3 text-green-600" aria-label="Email verified" />
                                  ) : (
                                    <Mail className="w-3 h-3 text-orange-500" aria-label="Email not verified" />
                                  )}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={getRoleBadgeColor(user.role)}>
                          {getRoleDisplayName(user.role)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={user.isActive ? "default" : "secondary"}>
                          {user.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {new Date(user.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end space-x-2">
                          {user.id !== currentUser?.id && (
                            <TooltipProvider>
                              <>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => handleEditUser(user)}
                                    >
                                      <Edit className="w-4 h-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Edit user details</p>
                                  </TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setChangingPasswordUser(user)}
                                      className="text-blue-600 hover:text-blue-900"
                                    >
                                      <Key className="w-4 h-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Change password</p>
                                  </TooltipContent>
                                </Tooltip>
                                {user.email && !user.emailVerified && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => handleResendVerification(user)}
                                        disabled={sendingVerification === user.id}
                                        className="text-orange-600 hover:text-orange-900"
                                      >
                                        <MailCheck className="w-4 h-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>Resend verification email</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                {user.isActive && (
                                  <AlertDialog>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <AlertDialogTrigger asChild>
                                          <Button variant="outline" size="sm">
                                            <UserX className="w-4 h-4" />
                                          </Button>
                                        </AlertDialogTrigger>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>Deactivate user account</p>
                                      </TooltipContent>
                                    </Tooltip>
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>Deactivate User</AlertDialogTitle>
                                        <AlertDialogDescription>
                                          Are you sure you want to deactivate {user.name}? They will no longer be able to log in to the system.
                                        </AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction
                                          onClick={() => handleDeactivateUser(user)}
                                          className="bg-red-600 hover:bg-red-700"
                                        >
                                          Deactivate
                                        </AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                )}
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => checkUserDependencies(user)}
                                      className="text-red-600 hover:text-red-700 border-red-200 hover:border-red-300"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Delete user permanently</p>
                                  </TooltipContent>
                                </Tooltip>
                              </>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update user information
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full Name</FormLabel>
                    <FormControl>
                      <Input placeholder="John Doe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone Number <span className="text-gray-400 font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input type="tel" placeholder="5551234567" {...field} />
                    </FormControl>
                    <p className="text-xs text-gray-500">Updating phone also updates their login username</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a role" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="irrigation_manager">Manager</SelectItem>
                        <SelectItem value="field_tech">Field Tech</SelectItem>
                        <SelectItem value="billing_manager">Billing Manager</SelectItem>
                        <SelectItem value="bookkeeper">Bookkeeper</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email <span className="text-gray-400 font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="john@example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end space-x-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingUser(null)}
                >
                  Cancel
                </Button>
                <Button type="submit">Update User</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Password Change Dialog */}
      <Dialog open={!!changingPasswordUser} onOpenChange={(open) => !open && setChangingPasswordUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
            <DialogDescription>
              Change password for {changingPasswordUser?.name}
            </DialogDescription>
          </DialogHeader>
          <Form {...passwordForm}>
            <form onSubmit={passwordForm.handleSubmit(onPasswordChangeSubmit)} className="space-y-4">
              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Enter new password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Confirm new password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end space-x-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setChangingPasswordUser(null);
                    passwordForm.reset();
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit">Change Password</Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* User Deletion Dialog with Data Impact Analysis */}
      <Dialog open={!!deletingUser} onOpenChange={(open) => {
        if (!open) {
          setDeletingUser(null);
          setUserDependencies(null);
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
              Delete User: {deletingUser?.name}
            </DialogTitle>
            <DialogDescription>
              Choose how to handle this user's deletion based on their work history
            </DialogDescription>
          </DialogHeader>

          {isLoadingDependencies ? (
            <div className="py-8 text-center">
              <Database className="h-8 w-8 text-gray-400 mx-auto animate-pulse" />
              <p className="mt-2 text-gray-600">Analyzing user data dependencies...</p>
            </div>
          ) : userDependencies ? (
            <div className="space-y-6">
              {/* Data Impact Summary */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                <h4 className="font-semibold mb-3 flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  Data Impact Analysis
                </h4>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-600">{userDependencies.workOrderCount}</div>
                    <div className="text-gray-600">Work Orders</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-600">{userDependencies.billingSheetCount}</div>
                    <div className="text-gray-600">Billing Sheets</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-purple-600">{userDependencies.notificationCount}</div>
                    <div className="text-gray-600">Notifications</div>
                  </div>
                </div>
              </div>

              {/* Deletion Options */}
              <div className="space-y-4">
                <h4 className="font-semibold">Choose Deletion Method:</h4>
                
                {/* Smart Delete - Recommended */}
                <div className="border rounded-lg p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-blue-100 dark:bg-blue-800 rounded-lg">
                      <Database className="h-4 w-4 text-blue-600" />
                    </div>
                    <div className="flex-1">
                      <h5 className="font-medium text-blue-900 dark:text-blue-100">
                        Smart Delete (Recommended)
                      </h5>
                      <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                        {userDependencies.hasWorkOrders || userDependencies.hasBillingSheets 
                          ? "Uses soft delete to preserve business records for billing/payroll integrity"
                          : "Uses permanent deletion since no work history exists"
                        }
                      </p>
                      <Button 
                        onClick={handleSmartDelete}
                        className="mt-3 bg-blue-600 hover:bg-blue-700"
                        size="sm"
                      >
                        Use Smart Delete
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Soft Delete */}
                <div className="border rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-yellow-100 dark:bg-yellow-800 rounded-lg">
                      <Archive className="h-4 w-4 text-yellow-600" />
                    </div>
                    <div className="flex-1">
                      <h5 className="font-medium">Soft Delete (Preserve Data)</h5>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                        Marks user as deleted but keeps all work history intact for business records
                      </p>
                      <Button 
                        onClick={handleSoftDelete}
                        variant="outline"
                        className="mt-3 border-yellow-200 hover:bg-yellow-50"
                        size="sm"
                      >
                        Soft Delete
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Hard Delete - Warning */}
                <div className="border rounded-lg p-4 bg-red-50 dark:bg-red-900/20 border-red-200">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-red-100 dark:bg-red-800 rounded-lg">
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </div>
                    <div className="flex-1">
                      <h5 className="font-medium text-red-900 dark:text-red-100">
                        Hard Delete (Permanent)
                      </h5>
                      <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                        ⚠️ Permanently removes user and cleans up data. Historical work records will show "[Deleted User]"
                      </p>
                      <Button 
                        onClick={handleHardDelete}
                        variant="outline"
                        className="mt-3 border-red-200 hover:bg-red-50 text-red-600 hover:text-red-700"
                        size="sm"
                      >
                        Permanent Delete
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end pt-4">
                <Button
                  variant="outline"
                  onClick={() => {
                    setDeletingUser(null);
                    setUserDependencies(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="py-8 text-center">
              <AlertTriangle className="h-8 w-8 text-red-400 mx-auto" />
              <p className="mt-2 text-gray-600">Failed to analyze user data. Please try again.</p>
              <Button 
                variant="outline" 
                className="mt-4"
                onClick={() => {
                  setDeletingUser(null);
                  setUserDependencies(null);
                }}
              >
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}