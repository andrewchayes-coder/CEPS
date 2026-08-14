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

  const handleSubmit = () => {
    if (!typedName.trim()) {
      toast({ variant: "destructive", title: "Name Required", description: "Please type your name to sign." });
      return;
    }
    if (!agreed) {
      toast({ variant: "destructive", title: "Agreement Required", description: "You must check the agreement box." });
      return;
    }

    submitSignature.mutate({ 
      token: token!,
      data: { typedName, agreed }
    }, {
      onSuccess: () => {
        toast({
          title: "Successfully Signed",
          description: "Thank you. The authorization has been submitted.",
        });
        // Could reload to show the "already signed" state, or redirect
        window.location.reload();
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
            <FileSignature className="w-12 h-12 text-primary" />
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
