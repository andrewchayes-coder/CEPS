import React, { useState } from 'react';
import { useParams } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useGetInvite, useAcceptInvite } from '@workspace/api-client-react';
import { BrandLogo } from '@/components/brand-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';

const acceptSchema = z.object({
  name: z.string().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const roleLabel: Record<string, string> = {
  vendor: 'Vendor',
  parent_guardian: 'Parent / Guardian',
  self: 'Self',
};

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const { data: invite, isLoading, error } = useGetInvite(token, {
    query: { retry: false, queryKey: ['invite', token] },
  });
  const acceptMutation = useAcceptInvite();

  const form = useForm<z.infer<typeof acceptSchema>>({
    resolver: zodResolver(acceptSchema),
    defaultValues: { name: '', password: '' },
  });

  const onSubmit = (values: z.infer<typeof acceptSchema>) => {
    acceptMutation.mutate(
      { token, data: { name: values.name || undefined, password: values.password } },
      {
        onSuccess: () => {
          // IMPORTANT: full page load (not SPA navigation) so the freshly-set
          // session cookie is sent on the first authenticated request.
          window.location.assign(import.meta.env.BASE_URL);
        },
        onError: (err: any) => {
          toast({
            variant: 'destructive',
            title: 'Could not accept invite',
            description: err?.data?.message || 'This invite may be invalid or expired.',
          });
        },
      },
    );
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <BrandLogo className="h-auto w-full" />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Accept your invitation</CardTitle>
            <CardDescription>
              {isLoading && 'Loading invite...'}
              {!isLoading && (error || !invite) && 'This invite is invalid or has expired.'}
              {!isLoading && invite && (
                <>
                  You've been invited to the CEPS portal as{' '}
                  <span className="font-medium text-foreground">{roleLabel[invite.role] || invite.role}</span>
                  {invite.recordName ? (
                    <>
                      {' '}for <span className="font-medium text-foreground">{invite.recordName}</span>
                    </>
                  ) : null}
                  . Set a password to activate <span className="font-medium text-foreground">{invite.email}</span>.
                </>
              )}
            </CardDescription>
          </CardHeader>
          {!isLoading && invite && (
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Your Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Full name" data-testid="input-invite-name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="••••••••"
                            data-testid="input-invite-password"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={acceptMutation.isPending}
                    data-testid="button-accept-invite"
                  >
                    {acceptMutation.isPending ? 'Activating...' : 'Activate Account'}
                  </Button>
                </form>
              </Form>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}
