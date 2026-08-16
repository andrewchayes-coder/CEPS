import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useUpdateMe, useGetCurrentUser, getGetCurrentUserQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/auth/auth-provider';
import { VendorBusinessProfile } from '@/components/vendor-business-profile';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

const accountSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Enter a valid email address'),
});

type AccountFormValues = z.infer<typeof accountSchema>;

export default function AccountPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateMe = useUpdateMe();

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: user?.name ?? '',
      email: user?.email ?? '',
    },
  });

  const onSubmit = (values: AccountFormValues) => {
    const payload: { name?: string; email?: string } = {};
    if (values.name !== user?.name) payload.name = values.name;
    if (values.email !== user?.email) payload.email = values.email;

    if (Object.keys(payload).length === 0) {
      toast({ title: 'No changes to save' });
      return;
    }

    updateMe.mutate(
      { data: payload },
      {
        onSuccess: (updated) => {
          // Refresh the auth session cache so the shell shows the new name immediately
          queryClient.setQueryData(getGetCurrentUserQueryKey(), updated);
          form.reset({ name: updated.name, email: updated.email });
          toast({ title: 'Account updated' });
        },
        onError: (err: any) => {
          const msg =
            err?.response?.status === 409
              ? 'That email address is already in use by another account.'
              : err?.data?.error ?? err?.message ?? 'Could not save changes.';
          toast({ variant: 'destructive', title: 'Error', description: msg });
        },
      },
    );
  };

  // A vendor's account is their business record; surface the self-service
  // Business Profile & W-9 section here since there is no sidebar path to it.
  const isVendor = user?.role === 'vendor' && user?.linkedRecordType === 'vendor' && !!user?.linkedRecordId;

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-semibold mb-6">My Account</h1>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Update the name and email address used to sign in to this portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display name</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Your name" />
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
                    <FormLabel>Login email</FormLabel>
                    <FormControl>
                      <Input {...field} type="email" placeholder="you@example.com" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={updateMe.isPending}>
                {updateMe.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {isVendor && user?.linkedRecordId && (
        <div className="mt-6" data-testid="account-vendor-business-profile">
          <VendorBusinessProfile
            id={user.linkedRecordId}
            contactCardTitle="Business Profile & W-9"
          />
        </div>
      )}
    </div>
  );
}
