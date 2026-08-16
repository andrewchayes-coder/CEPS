import { BrandLogo } from '@/components/brand-logo';
import React, { useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetSignaturePage, useSubmitSignature } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { FileSignature, CheckCircle2, ShieldCheck } from 'lucide-react';
import { Separator } from '@/components/ui/separator';

export default function SignaturePage() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const [typedName, setTypedName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [createAccount, setCreateAccount] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [accountRequested, setAccountRequested] = useState(false);
  const [accountCreated, setAccountCreated] = useState(false);
  
  const { data: pageData, isLoading, error } = useGetSignaturePage(token!, {
    query: {
      enabled: !!token,
      retry: false,
      queryKey: ['signaturePage', token]
    }
  });

  const submitSignature = useSubmitSignature();

  if (isLoading) return <div className="min-h-screen flex items-center justify-center">Loading document...</div>;

  if (error || !pageData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md text-center py-8">
          <CardHeader>
            <CardTitle className="text-destructive">Invalid Link</CardTitle>
            <CardDescription>This signature link has expired or is invalid.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (pageData.alreadySigned) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md text-center py-8 border-chart-5/20 bg-chart-5/5">
          <CardHeader>
            <div className="flex justify-center mb-4">
              <CheckCircle2 className="w-12 h-12 text-chart-5" />
            </div>
            <CardTitle>Already Signed</CardTitle>
            <CardDescription>This document has already been signed and submitted.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md text-center py-8 border-chart-5/20 bg-chart-5/5">
          <CardHeader>
            <div className="flex justify-center mb-4">
              <CheckCircle2 className="w-12 h-12 text-chart-5" />
            </div>
            <CardTitle>Authorization Signed</CardTitle>
            <CardDescription>
              Thank you, {typedName}. Your signature has been submitted successfully.
            </CardDescription>
          </CardHeader>
          {accountRequested && accountCreated && (
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your portal account has been created. You can now log in to track this
                client's services, invoices, and payments.
              </p>
              <Button className="w-full" onClick={() => setLocation('/login')}>
                Go to Login
              </Button>
            </CardContent>
          )}
          {accountRequested && !accountCreated && (
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                An account with this email already exists, so a new one was not
                created. Use <span className="font-medium">Forgot password</span> to
                sign in, or contact CEPS if you need help accessing your account.
              </p>
              <Button variant="outline" className="w-full" onClick={() => setLocation('/login')}>
                Go to Login
              </Button>
            </CardContent>
          )}
        </Card>
      </div>
    );
  }

  const handleSubmit = () => {
    if (!typedName.trim()) {
      toast({ variant: "destructive", title: "Name Required", description: "Please type your name to sign." });
      return;
    }
    if (!agreed) {
      toast({ variant: "destructive", title: "Agreement Required", description: "You must check the agreement box." });
      return;
    }
    if (createAccount) {
      if (password.length < 8) {
        toast({ variant: "destructive", title: "Password Too Short", description: "Password must be at least 8 characters." });
        return;
      }
      if (password !== confirmPassword) {
        toast({ variant: "destructive", title: "Passwords Don't Match", description: "Please re-enter your password." });
        return;
      }
    }

    submitSignature.mutate({
      token: token!,
      data: createAccount
        ? { typedName, agreed, createAccount: true, password }
        : { typedName, agreed },
    }, {
      onSuccess: (result) => {
        toast({
          title: "Successfully Signed",
          description: "Thank you. The authorization has been submitted.",
        });
        setAccountRequested(createAccount);
        setAccountCreated(!!result?.accountCreated);
        setSubmitted(true);
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Submission Failed",
          description: "An error occurred while saving your signature.",
        });
      }
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4 py-12">
      <Card className="w-full max-w-2xl border-t-4 border-t-primary shadow-lg">
        <CardHeader className="text-center pb-8 border-b">
          <div className="flex justify-center mb-4">
            <BrandLogo className="h-12" />
          </div>
          <CardTitle className="text-2xl">Service Authorization Agreement</CardTitle>
          <CardDescription className="text-base mt-2">
            Community Engaged Payee Support (CEPS)
          </CardDescription>
        </CardHeader>
        
        <CardContent className="pt-8 space-y-8">
          <div className="bg-secondary/50 rounded-lg p-6 space-y-4 text-sm">
            <h3 className="font-semibold text-base border-b pb-2">Service Details</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <p className="text-muted-foreground">Client Name</p>
                <p className="font-medium">{pageData.clientName}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Service Provider (Vendor)</p>
                <p className="font-medium">{pageData.vendorName || 'Not specified'}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-muted-foreground">Activity Description</p>
                <p className="font-medium">{pageData.activityDescription}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Anticipated Start</p>
                <p className="font-medium">{pageData.serviceStartDate || 'TBD'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Anticipated End</p>
                <p className="font-medium">{pageData.serviceEndDate || 'TBD'}</p>
              </div>
            </div>
          </div>

          <div className="prose prose-sm max-w-none text-muted-foreground">
            <p>
              By signing below, I authorize Community Engaged Payee Support (CEPS) to act as the Financial Management Service (FMS) provider for the services described above, funded through Alta California Regional Center.
            </p>
            <p>
              I understand that CEPS will process payments to the vendor upon receipt of valid invoices and corresponding authorization from the Regional Center. I agree to notify CEPS promptly of any changes to the service schedule, vendor information, or if services are terminated.
            </p>
          </div>

          <Separator />

          <div className="space-y-6 pt-4 bg-background">
            <div className="flex items-start space-x-3">
              <Checkbox 
                id="terms" 
                checked={agreed} 
                onCheckedChange={(c) => setAgreed(c === true)} 
                className="mt-1"
              />
              <div className="grid gap-1.5 leading-none">
                <label htmlFor="terms" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  I agree to the terms and authorize services
                </label>
                <p className="text-sm text-muted-foreground">
                  Checking this box constitutes a legally binding electronic signature.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <Label htmlFor="signature" className="text-base font-semibold">Digital Signature (Type Full Name)</Label>
              <Input 
                id="signature" 
                placeholder="e.g. Jane Doe" 
                className="max-w-md h-12 text-lg"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
              />
            </div>

            <Separator />

            <div className="space-y-4 rounded-lg border p-4 bg-secondary/30">
              <div className="flex items-start space-x-3">
                <Checkbox
                  id="create-account"
                  checked={createAccount}
                  onCheckedChange={(c) => setCreateAccount(c === true)}
                  className="mt-1"
                  data-testid="checkbox-create-account"
                />
                <div className="grid gap-1.5 leading-none">
                  <label htmlFor="create-account" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    Create your portal account (optional)
                  </label>
                  <p className="text-sm text-muted-foreground">
                    Set a password to log in and follow this client's services, invoices, and payments.
                  </p>
                </div>
              </div>

              {createAccount && (
                <div className="grid sm:grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2">
                    <Label htmlFor="account-name">Your Name</Label>
                    <Input
                      id="account-name"
                      value={typedName}
                      onChange={(e) => setTypedName(e.target.value)}
                      placeholder="Full name"
                      data-testid="input-account-name"
                    />
                  </div>
                  <div className="hidden sm:block" />
                  <div className="space-y-2">
                    <Label htmlFor="account-password">Password</Label>
                    <Input
                      id="account-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      data-testid="input-account-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="account-password-confirm">Confirm Password</Label>
                    <Input
                      id="account-password-confirm"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      data-testid="input-account-password-confirm"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>

        <CardFooter className="bg-muted/30 border-t p-6 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center text-sm text-muted-foreground">
            <ShieldCheck className="w-4 h-4 mr-2 text-primary" />
            Secure Encrypted Document
          </div>
          <Button 
            size="lg" 
            className="w-full sm:w-auto" 
            onClick={handleSubmit}
            disabled={!agreed || !typedName.trim() || submitSignature.isPending}
          >
            {submitSignature.isPending ? 'Submitting...' : 'Sign & Submit Authorization'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
