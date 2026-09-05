import { BrandLogo } from '@/components/brand-logo';
import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetSignaturePage, useSubmitSignature } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, ShieldCheck, User } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { trackAnalyticsEvent } from '@/lib/analytics';

type SignerRelationship = 'self' | 'parent' | 'guardian' | 'conservator';

export default function SignaturePage() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [typedName, setTypedName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [createAccount, setCreateAccount] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signerRelationship, setSignerRelationship] = useState<SignerRelationship | ''>('');

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

  useEffect(() => {
    if (pageData?.intakeSentTo === 'participant') {
      setSignerRelationship('self');
    }
  }, [pageData]);

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
            <CardTitle>Agreement Signed</CardTitle>
            <CardDescription>
              Thank you, {typedName}. Your signature has been submitted successfully.
            </CardDescription>
          </CardHeader>
          {accountRequested && accountCreated && (
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your portal account has been created. You can now log in to track this
                participant's services, invoices, and payments.
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
    if (!signerRelationship) {
      toast({ variant: "destructive", title: "Relationship Required", description: "Please select your relationship to the participant." });
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
      data: {
        typedName,
        agreed,
        signerRelationship,
        ...(createAccount ? { createAccount: true, password } : {})
      }
    }, {
      onSuccess: (result) => {
        trackAnalyticsEvent('signature_completed', {
          account_creation_requested: createAccount,
          account_outcome: createAccount
            ? (result?.accountCreated ? 'created' : 'already_exists')
            : 'not_requested',
        });
        toast({
          title: "Successfully Signed",
          description: "Thank you. The agreement has been submitted.",
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
      <Card className="w-full max-w-4xl border-t-4 border-t-primary shadow-lg">
        <CardHeader className="text-center pb-6 border-b">
          <div className="flex justify-center mb-4">
            <BrandLogo className="h-12" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">Participant Agreement</CardTitle>
          <CardDescription className="text-base mt-2">
            Community Engaged Payee Support (CEPS) Intake Packet
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-8 space-y-8">
          {pageData.clientIsMinor && (
            <div className="bg-muted text-muted-foreground p-3 rounded-md text-sm mb-4 border flex items-center gap-2">
              <User className="w-4 h-4 shrink-0" />
              <strong>Note:</strong> You are reviewing and signing this agreement on behalf of a minor.
            </div>
          )}

          <div className="bg-secondary/30 rounded-lg border p-6 space-y-6 text-sm">
            <div>
              <h3 className="font-semibold text-base border-b pb-2 mb-3">Participant Information</h3>
              <div className="grid sm:grid-cols-3 gap-4">
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Name</p><p className="font-medium">{pageData.clientName}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">DOB</p><p className="font-medium">{pageData.participantDob || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">UCI Number</p><p className="font-medium">{pageData.participantUci || 'Not specified'}</p></div>
              </div>
            </div>

            <div>
              <h3 className="font-semibold text-base border-b pb-2 mb-3">Regional Center / Service Coordinator</h3>
              <div className="grid sm:grid-cols-3 gap-4">
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Regional Center</p><p className="font-medium">{pageData.regionalCenter || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Coordinator Name</p><p className="font-medium">{pageData.serviceCoordinatorName || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Coordinator Phone</p><p className="font-medium">{pageData.serviceCoordinatorPhone || 'Not specified'}</p></div>
              </div>
            </div>

            <div>
              <h3 className="font-semibold text-base border-b pb-2 mb-3">Family / Representative Contact</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Name</p><p className="font-medium">{pageData.representativeName || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Phone</p><p className="font-medium">{pageData.contactPhone || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Email</p><p className="font-medium">{pageData.contactEmail || 'Not specified'}</p></div>
                <div className="sm:col-span-2 lg:col-span-1"><p className="text-muted-foreground text-xs uppercase tracking-wider">Mailing Address</p><p className="font-medium">{pageData.mailingAddress || 'Not specified'}</p></div>
              </div>
            </div>

            <div>
              <h3 className="font-semibold text-base border-b pb-2 mb-3">Vendor & Activity Information</h3>
              <div className="grid sm:grid-cols-3 gap-4">
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Vendor/Program Name</p><p className="font-medium">{pageData.vendorName || 'Not specified'}</p></div>
                <div className="sm:col-span-2"><p className="text-muted-foreground text-xs uppercase tracking-wider">Activity Description</p><p className="font-medium">{pageData.activityDescription || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Contact Name</p><p className="font-medium">{pageData.activityContactName || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Contact Phone</p><p className="font-medium">{pageData.activityContactPhone || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Mailing Address</p><p className="font-medium">{pageData.activityMailingAddress || 'Not specified'}</p></div>
              </div>
            </div>

            <div>
              <h3 className="font-semibold text-base border-b pb-2 mb-3">Service & Payment Details</h3>
              <div className="grid sm:grid-cols-3 lg:grid-cols-4 gap-4">
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Service Type</p><p className="font-medium capitalize">{pageData.serviceType?.replace(/_/g, ' ') || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Start Date</p><p className="font-medium">{pageData.serviceStartDate || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">End Date</p><p className="font-medium">{pageData.serviceEndDate || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Frequency</p><p className="font-medium capitalize">{pageData.serviceFrequency?.replace(/_/g, ' ') || 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Cost</p><p className="font-medium">{pageData.cost ? `$${pageData.cost}` : 'Not specified'}</p></div>
                <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Payment Schedule</p><p className="font-medium">{pageData.paymentSchedule || 'Not specified'}</p></div>
                <div className="sm:col-span-2"><p className="text-muted-foreground text-xs uppercase tracking-wider">Payment Type Requested</p><p className="font-medium capitalize">{pageData.paymentTypeRequested?.replace(/_/g, ' ') || 'Not specified'}</p></div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold tracking-tight">Agreement Terms</h3>
            <div className="prose prose-sm max-w-none text-muted-foreground bg-white dark:bg-black rounded-lg border p-6 h-64 overflow-y-auto">
              <p className="font-bold text-foreground">1. Purpose of RC Funds</p>
              <p>The recipient of RC Funds, herein referred to as the "Participant," acknowledges that the primary purpose of these funds is to empower individuals with developmental disabilities to exercise greater control over their service delivery and to achieve personal outcomes based on their individual needs, preferences, and goals.</p>

              <p className="font-bold text-foreground mt-4">2. Eligible Expenditures</p>
              <p>The Participant understands that RC Funds can be used for a range of services, supports, and goods that promote community inclusion, enhance quality of life, and facilitate the attainment of personal objectives. These include but are not limited to, services related to education, and social and recreational activities.</p>

              <p className="font-bold text-foreground mt-4">3. Budget Development and Approval</p>
              <p>The Participant agrees to collaborate with their Service Coordinator to obtain the proper authorization and provide the supporting documentation to obtain the authorization. This includes program invoices or contracts, with the business and/or program name, the contact information for the business/program, and the service that is provided: (Example: Joe's Karate Club, summer program 2 x per week from 7/1-8/31; cost $420.00). The Participant understands that purchases cannot be granted unless CEPS obtains authorization for the item, and CEPS cannot pay outside the authorized amount. The Participant acknowledges the responsibility to utilize RC Funds in accordance with the guidelines and regulations. Any proposed expenditures must be consistent with the Participant's Individual Program Plan (IPP) and must not contravene state and federal laws, regulations, or policies. CEPS does not receive the IPP, but will assume if the Participant receives authorization from the RC, that the services are in line with the IPP as the RC provides the authorization to CEPS.</p>

              <p className="font-bold text-foreground mt-4">4. Record Keeping and Documentation</p>
              <p>The Participant agrees to provide CEPS with unpaid invoices, bills, or payment requests. The Participant agrees to maintain accurate and detailed records of all expenditures made using RC Funds. This documentation shall include receipts, invoices, and other pertinent information and be made available for inspection upon request.</p>

              <p className="font-bold text-foreground mt-4">5. Service Payment and/or Reimbursement Process</p>
              <p><strong>Service Payment:</strong> The Participant will provide CEPS with the Recreational Activity Service/Program contact information and an invoice, bill or payment request from the vendor a minimum of two weeks prior to the payment due date. The Participant will provide CEPS with the requested payment schedule: (Example: $420.00 to be paid in two payments of $210.00 on the first of each month). CEPS will submit payment to the vendor by check and provide payment confirmation to the Participant.</p>
              <p><strong>Reimbursement:</strong> Upon the completion of approved expenditures, the Participant will obtain authorization from the RC. The RC will provide CEPS with a copy of the authorization and any supporting documentation. The participant must complete a CEPS invoice and provide supporting documentation such as receipts or invoices for services. CEPS will initiate the reimbursement process for the Participant subsequent to the RC's fulfillment of the expenditure. The disbursement of payment may require a span of 30-45 days from the date of CEPS's formal submission to the RC.</p>

              <p className="mt-4">By signing this contract, the Participant affirms their commitment to utilizing RC Funds responsibly and in accordance with the principles and guidelines set forth by the California Department of Developmental Disabilities.</p>
              <p>The Parent/Guardian/Conservator is providing an attestation that confirms the participant's receipt of services and their payment for said services. This attestation is corroborated by their submission of the relevant receipt/invoice. Signatures indicate agreement and understanding of the terms outlined in this contract statement.</p>
            </div>
          </div>

          <Separator />

          <div className="space-y-6 pt-4 bg-background">
            <div className="flex items-start space-x-3">
              <Checkbox 
                id="terms" 
                checked={agreed} 
                onCheckedChange={(c) => setAgreed(c === true)} 
                className="mt-1"
                data-testid="checkbox-agreement"
              />
              <div className="grid gap-1.5 leading-none">
                <label htmlFor="terms" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  I agree to the terms and authorize services
                </label>
                <p className="text-sm text-muted-foreground mt-1">
                  Checking this box constitutes a legally binding electronic signature.
                </p>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-6">
              <div className="space-y-3">
                <Label htmlFor="signature" className="text-base font-semibold">Digital Signature (Type Full Name)</Label>
                <Input
                  id="signature"
                  placeholder="e.g. Jane Doe"
                  className="max-w-md h-12 text-lg"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  data-testid="input-signature-name"
                />
              </div>

              <div className="space-y-3">
                <Label className="text-base font-semibold">Signer Relationship</Label>
                {pageData.intakeSentTo === 'participant' ? (
                  <div className="flex items-center h-12">
                    <Badge variant="secondary" className="px-3 py-1.5 text-sm" data-testid="badge-relationship-self">Participant (Self)</Badge>
                  </div>
                ) : (
                  <RadioGroup
                    value={signerRelationship}
                    onValueChange={(value) => {
                      if (value === 'parent' || value === 'guardian' || value === 'conservator') {
                        setSignerRelationship(value);
                      }
                    }}
                    className="flex flex-col space-y-2 pt-2"
                    data-testid="radio-group-relationship"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="parent" id="rel-parent" data-testid="radio-rel-parent" />
                      <Label htmlFor="rel-parent" className="font-normal">Parent</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="guardian" id="rel-guardian" data-testid="radio-rel-guardian" />
                      <Label htmlFor="rel-guardian" className="font-normal">Guardian</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="conservator" id="rel-conservator" data-testid="radio-rel-conservator" />
                      <Label htmlFor="rel-conservator" className="font-normal">Conservator</Label>
                    </div>
                  </RadioGroup>
                )}
              </div>
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
                  <p className="text-sm text-muted-foreground mt-1">
                    Set a password to log in and follow this participant's services, invoices, and payments.
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
            <ShieldCheck className="w-5 h-5 mr-2 text-primary" />
            Secure Encrypted Document
          </div>
          <Button 
            size="lg" 
            className="w-full sm:w-auto" 
            onClick={handleSubmit}
            disabled={!agreed || !typedName.trim() || !signerRelationship || submitSignature.isPending}
            data-testid="button-submit-signature"
          >
            {submitSignature.isPending ? 'Submitting...' : 'Sign & Submit Agreement'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
