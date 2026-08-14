import React, { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useConsumeMagicLink } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

export default function MagicLinkConsumePage() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const consumeMutation = useConsumeMagicLink();

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const token = searchParams.get('token');

    if (!token) {
      toast({
        variant: 'destructive',
        title: 'Invalid Link',
        description: 'No token found in the URL.',
      });
      setLocation('/login');
      return;
    }

    consumeMutation.mutate({ data: { token } }, {
      onSuccess: () => {
        toast({
          title: 'Welcome Back',
          description: 'You have successfully signed in.',
        });
        setLocation('/');
      },
      onError: (err: any) => {
        toast({
          variant: 'destructive',
          title: 'Sign In Failed',
          description: err?.data?.message || 'This link may have expired or is invalid.',
        });
        setLocation('/login');
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md text-center py-8">
        <CardHeader>
          <CardTitle>Authenticating</CardTitle>
          <CardDescription>Verifying your secure link...</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    </div>
  );
}
