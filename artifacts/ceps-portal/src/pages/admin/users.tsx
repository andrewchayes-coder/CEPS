import React, { useState } from 'react';
import { useListUsers, useCreateUser, useDeleteUser, useUpdateUser, UserInputRole } from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';
import { EditUserDialog } from '@/components/edit-user-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Power } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';

const userSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().optional(),
  role: z.enum(['staff', 'service_coordinator']),
  password: z.string().min(8, 'Password must be at least 8 characters').optional().or(z.literal('')),
});

export default function UsersPage() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const isStaff = currentUser?.role === 'staff';
  const { data: users, isLoading, refetch } = useListUsers(undefined, { query: { enabled: isStaff } } as any);
  const createUser = useCreateUser();
  const deleteUser = useDeleteUser();
  const updateUser = useUpdateUser();

  if (!isStaff) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-users-forbidden">
            You don't have access to user administration.
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleDeactivate = (id: string) => {
    deleteUser.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: 'User deactivated' });
          refetch();
        },
        onError: (err: any) => {
          toast({
            variant: 'destructive',
            title: 'Error',
            description: err?.data?.message || 'Could not deactivate this user.',
          });
        },
      },
    );
  };

  const handleReactivate = (id: string) => {
    updateUser.mutate(
      { id, data: { active: true } as any },
      {
        onSuccess: () => {
          toast({ title: 'User reactivated' });
          refetch();
        },
        onError: (err: any) => {
          toast({
            variant: 'destructive',
            title: 'Error',
            description: err?.data?.message || 'Could not reactivate this user.',
          });
        },
      },
    );
  };

  const form = useForm<z.infer<typeof userSchema>>({
    resolver: zodResolver(userSchema),
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      role: 'staff',
      password: '',
    }
  });

  const onSubmit = (data: z.infer<typeof userSchema>) => {
    createUser.mutate({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone || undefined,
        role: data.role as UserInputRole,
        password: data.password || undefined
      }
    }, {
      onSuccess: () => {
        toast({ title: 'User created successfully' });
        setOpen(false);
        form.reset();
        refetch();
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Error",
          description: err?.data?.message || "Failed to create user.",
        });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground mt-1">Manage admin and coordinator access.</p>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" /> Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New User</DialogTitle>
              <DialogDescription>Create a new admin or coordinator account.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone <span className="text-muted-foreground font-normal">(optional)</span></FormLabel><FormControl><Input type="tel" placeholder="(555) 555-5555" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="role" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="staff">Admin (Full Access)</SelectItem>
                        <SelectItem value="service_coordinator">Service Coordinator</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="password" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Initial Password</FormLabel>
                    <FormControl><Input type="password" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <DialogFooter className="pt-4">
                  <Button type="submit" disabled={createUser.isPending}>
                    {createUser.isPending ? 'Creating...' : 'Create User'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="h-24 text-center"><Skeleton className="h-4 w-full" /></TableCell></TableRow>
              ) : (
                users?.map((u) => {
                  const isSelf = currentUser?.id === u.id;
                  return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell className="capitalize">{u.role === 'staff' ? 'admin' : u.role.replace('_', ' ')}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={u.active ? "text-chart-5 border-chart-5/20" : "text-muted-foreground"}>
                        {u.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.lastLogin ? format(new Date(u.lastLogin), 'MMM d, yyyy') : 'Never'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <EditUserDialog id={u.id} user={{ name: u.name, email: u.email, role: u.role, phone: u.phone }} onSaved={refetch} />
                        {u.active && !isSelf && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" data-testid={`button-deactivate-user-${u.id}`}>
                                <Power className="w-4 h-4 mr-2" /> Deactivate
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Deactivate User?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will mark {u.name} as inactive and revoke their access. Continue?
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel disabled={deleteUser.isPending}>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={(e) => {
                                    e.preventDefault();
                                    handleDeactivate(u.id);
                                  }}
                                  disabled={deleteUser.isPending}
                                  data-testid={`button-confirm-deactivate-user-${u.id}`}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  {deleteUser.isPending ? 'Deactivating…' : 'Deactivate'}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                        {!u.active && !isSelf && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReactivate(u.id)}
                            disabled={updateUser.isPending}
                            data-testid={`button-reactivate-user-${u.id}`}
                          >
                            <Power className="w-4 h-4 mr-2" /> {updateUser.isPending ? 'Reactivating…' : 'Reactivate'}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
