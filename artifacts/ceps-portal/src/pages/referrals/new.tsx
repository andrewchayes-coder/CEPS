import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useCreateReferral } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { ChevronDown, ChevronLeft, ChevronRight, AlertTriangle, CheckCircle2, Users, FileText } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { FileUpload } from '@/components/file-upload';
import { trackAnalyticsEvent } from '@/lib/analytics';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// -----------------------------------------------------------------------------
// Validation Schemas (Step by Step to manage complex conditional logic)
// -----------------------------------------------------------------------------

const coordinatorSchema = z.object({
  regionalCenterName: z.string().min(1, 'Regional Center Name is required'),
  coordinatorName: z.string().min(1, 'Coordinator Name is required'),
  coordinatorEmail: z.string().email('Valid email is required'),
  coordinatorPhone: z.string().min(10, 'Valid phone number is required'),
});

const vendorSchemaBase = {
  vendorAcceptsChecks: z.boolean({ required_error: 'Must confirm if vendor accepts checks' }),
  vendorName: z.string().min(1, 'Vendor name is required'),
  vendorEmail: z.string().email('Valid email is required'),
  vendorPhone: z.string().min(10, 'Valid phone number is required'),
  vendorContactPerson: z.string().optional(),
  vendorServiceStreet: z.string().min(1, 'Street is required'),
  vendorServiceCity: z.string().min(1, 'City is required'),
  vendorServiceZip: z.string().min(5, 'ZIP is required'),
  vendorServiceState: z.string().length(2, 'State must be 2 letters'),
  vendorBillingDifferent: z.enum(['yes', 'no', 'unknown']),
  vendorBillingStreet: z.string().optional(),
  vendorBillingCity: z.string().optional(),
  vendorBillingZip: z.string().optional(),
  vendorBillingState: z.string().optional(),
};

const vendorSchema = z.object(vendorSchemaBase).refine(data => {
  if (data.vendorBillingDifferent === 'yes') {
    return !!data.vendorBillingStreet && !!data.vendorBillingCity && !!data.vendorBillingZip && !!data.vendorBillingState;
  }
  return true;
}, {
  message: "Billing address fields are required if different from service address",
  path: ["vendorBillingStreet"] // Attaches error near the fields
});

const activitySchema = z.object({
  serviceType: z.enum(['direct_pay_459', 'reimbursement_024']),
  serviceFrequency: z.enum(['one_time', 'monthly']),
  activityDescription: z.string().min(1, 'Description is required'),
  serviceStartDate: z.string().min(1, 'Start date is required'),
  serviceEndDate: z.string().min(1, 'End date is required'),
  posNumber: z.string().optional(),
  posStartDate: z.string().optional(),
  posEndDate: z.string().optional(),
});

const clientSchemaBase = {
  clientFirstName: z.string().min(1, 'First name is required'),
  clientLastName: z.string().min(1, 'Last name is required'),
  clientDob: z.string().min(1, 'Date of birth is required'),
  clientUci: z.string().min(1, 'UCI number is required'),
  preferredLanguage: z.string().min(1, 'Preferred language is required'),
  clientIsMinor: z.boolean(),
  familyRepName: z.string().optional(),
  familyRepRelationship: z.string().optional(),
  familyRepPhone: z.string().optional(),
  familyRepEmail: z.string().email('Enter a valid family representative email').or(z.literal('')).optional(),
  familyRepAddress: z.string().optional(),
  contactPhone: z.string().min(10, 'Contact phone is required'),
  contactEmail: z.string().email('Valid contact email is required'),
  contactStreet: z.string().min(1, 'Street is required'),
  contactCity: z.string().min(1, 'City is required'),
  contactZip: z.string().min(5, 'ZIP is required'),
  contactState: z.string().length(2, 'State must be 2 letters'),
};

const clientSchema = z.object(clientSchemaBase).refine(data => {
  if (data.clientIsMinor) {
    return !!data.familyRepName;
  }
  return true;
}, {
  message: "Family Representative name is required for minors",
  path: ["familyRepName"]
});

const fullSchema = z.object({
  ...coordinatorSchema.shape,
  ...vendorSchemaBase,
  ...activitySchema.shape,
  ...clientSchemaBase,
})
.refine(data => {
  if (data.vendorBillingDifferent === 'yes') {
    return !!data.vendorBillingStreet && !!data.vendorBillingCity && !!data.vendorBillingZip && !!data.vendorBillingState;
  }
  return true;
}, {
  message: "Billing address fields are required if different from service address",
  path: ["vendorBillingStreet"]
})
.refine(data => {
  if (data.clientIsMinor) {
    return !!data.familyRepName;
  }
  return true;
}, {
  message: "Family Representative name is required for minors",
  path: ["familyRepName"]
})
.refine(data => {
  if (data.clientIsMinor) return true;
  const hasFamilyRepDetails = Boolean(
    data.familyRepRelationship?.trim() ||
    data.familyRepPhone?.trim() ||
    data.familyRepEmail?.trim() ||
    data.familyRepAddress?.trim()
  );
  return !hasFamilyRepDetails || Boolean(data.familyRepName?.trim());
}, {
  message: "Name is required when adding a family representative",
  path: ["familyRepName"]
});

type FormValues = z.infer<typeof fullSchema>;

const STEPS = ['Coordinator', 'Vendor', 'Activity', 'Participant', 'Documents', 'Review'];

export default function ReferralNewPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createReferral = useCreateReferral();
  const [currentStep, setCurrentStep] = useState(0);
  const [supportingDocumentUrl, setSupportingDocumentUrl] = useState<string | undefined>(undefined);
  const [familyRepOpen, setFamilyRepOpen] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(fullSchema),
    defaultValues: {
      regionalCenterName: 'Alta California Regional Center',
      coordinatorName: '',
      coordinatorEmail: '',
      coordinatorPhone: '',
      vendorAcceptsChecks: true,
      vendorName: '',
      vendorEmail: '',
      vendorPhone: '',
      vendorContactPerson: '',
      vendorServiceStreet: '',
      vendorServiceCity: '',
      vendorServiceZip: '',
      vendorServiceState: 'CA',
      vendorBillingDifferent: 'no',
      serviceType: 'direct_pay_459',
      serviceFrequency: 'monthly',
      activityDescription: '',
      serviceStartDate: '',
      serviceEndDate: '',
      posNumber: '',
      posStartDate: '',
      posEndDate: '',
      clientFirstName: '',
      clientLastName: '',
      clientDob: '',
      clientUci: '',
      preferredLanguage: 'English',
      clientIsMinor: false,
      familyRepName: '',
      familyRepRelationship: '',
      familyRepPhone: '',
      familyRepEmail: '',
      familyRepAddress: '',
      contactPhone: '',
      contactEmail: '',
      contactStreet: '',
      contactCity: '',
      contactZip: '',
      contactState: 'CA',
    },
    mode: 'onChange'
  });

  const { watch, trigger, formState: { errors } } = form;
  
  // Watchers for conditional logic
  const vendorAcceptsChecks = watch('vendorAcceptsChecks');
  const vendorBillingDifferent = watch('vendorBillingDifferent');
  const clientIsMinor = watch('clientIsMinor');

  const nextStep = async () => {
    if (currentStep >= STEPS.length - 1 || vendorAcceptsChecks === false) return;
    let fieldsToValidate: any[] = [];
    if (currentStep === 0) fieldsToValidate = Object.keys(coordinatorSchema.shape);
    if (currentStep === 1) fieldsToValidate = Object.keys(vendorSchemaBase);
    if (currentStep === 2) fieldsToValidate = Object.keys(activitySchema.shape);
    if (currentStep === 3) fieldsToValidate = Object.keys(clientSchemaBase);

    const isStepValid = await trigger(fieldsToValidate as any);
    if (isStepValid) {
      setCurrentStep(s => s + 1);
      window.scrollTo(0, 0);
    }
  };

  const prevStep = () => {
    setCurrentStep(s => s - 1);
    window.scrollTo(0, 0);
  };

  const onSubmit = (data: FormValues) => {
    // Map flat form data to the nested API shape
    const intakeFields = { ...data };
    // Remove fields that go at the top level
    const serviceFrequency = intakeFields.serviceFrequency;
    delete (intakeFields as any).serviceFrequency;
    if (intakeFields.clientIsMinor) {
      delete (intakeFields as any).familyRepRelationship;
      delete (intakeFields as any).familyRepPhone;
      delete (intakeFields as any).familyRepEmail;
      delete (intakeFields as any).familyRepAddress;
    } else {
      for (const field of ['familyRepName', 'familyRepRelationship', 'familyRepPhone', 'familyRepEmail', 'familyRepAddress'] as const) {
        const value = intakeFields[field];
        if (!value?.trim()) delete (intakeFields as any)[field];
      }
    }
    createReferral.mutate({
      data: {
        submittedVia: 'portal',
        serviceFrequency: serviceFrequency as 'one_time' | 'monthly',
        supportingDocumentUrl: supportingDocumentUrl ?? '',
        intakeFields: intakeFields as any
      }
    }, {
      onSuccess: (res) => {
        trackAnalyticsEvent('referral_submitted', {
          supporting_document_supplied: Boolean(supportingDocumentUrl),
        });
        toast({
          title: "Referral Submitted",
          description: "The referral has been saved. Choose the agreement recipient on the referral page.",
        });
        setLocation(`/referrals/${res.id}`);
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Submission Failed",
          description: err?.data?.message || "An error occurred while saving the referral.",
        });
      }
    });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Referral Intake</h1>
        <p className="text-muted-foreground mt-1">Complete the packet to initiate service authorization.</p>
      </div>

      {/* Progress Bar */}
      <div className="flex items-center justify-between mb-8 relative">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-secondary -z-10 rounded-full overflow-hidden">
          <div 
            className="h-full bg-primary transition-all duration-300" 
            style={{ width: `${(currentStep / (STEPS.length - 1)) * 100}%` }}
          />
        </div>
        {STEPS.map((step, idx) => (
          <div key={step} className="flex flex-col items-center gap-2 bg-background px-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors ${
              idx < currentStep ? 'bg-primary border-primary text-primary-foreground' : 
              idx === currentStep ? 'bg-background border-primary text-primary' : 
              'bg-background border-muted text-muted-foreground'
            }`}>
              {idx < currentStep ? <CheckCircle2 className="w-5 h-5" /> : idx + 1}
            </div>
            <span className={`text-xs font-medium ${idx <= currentStep ? 'text-foreground' : 'text-muted-foreground'}`}>
              {step}
            </span>
          </div>
        ))}
      </div>

      <Form {...form}>
        <form
          onSubmit={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
            e.preventDefault();
            if (!e.repeat && currentStep < STEPS.length - 1) void nextStep();
          }}
          className="space-y-6"
        >
          
          {/* STEP 0: Coordinator */}
          {currentStep === 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Service Coordinator Information</CardTitle>
                <CardDescription>Details of the referring regional center coordinator.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField control={form.control} name="regionalCenterName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Regional Center</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="coordinatorName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Coordinator Name</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="coordinatorEmail" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl><Input type="email" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="coordinatorPhone" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Direct Phone Number</FormLabel>
                      <FormControl><Input type="tel" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* STEP 1: Vendor */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Vendor Eligibility</CardTitle>
                </CardHeader>
                <CardContent>
                  <FormField control={form.control} name="vendorAcceptsChecks" render={({ field }) => (
                    <FormItem className="space-y-3">
                      <FormLabel>Does the vendor accept physical checks for payment?</FormLabel>
                      <FormControl>
                        <RadioGroup
                          onValueChange={(val) => field.onChange(val === 'true')}
                          defaultValue={field.value ? 'true' : 'false'}
                          className="flex flex-col space-y-1"
                        >
                          <FormItem className="flex items-center space-x-3 space-y-0">
                            <FormControl><RadioGroupItem value="true" /></FormControl>
                            <FormLabel className="font-normal">Yes, they accept checks</FormLabel>
                          </FormItem>
                          <FormItem className="flex items-center space-x-3 space-y-0">
                            <FormControl><RadioGroupItem value="false" /></FormControl>
                            <FormLabel className="font-normal text-destructive">No, they do not accept checks</FormLabel>
                          </FormItem>
                        </RadioGroup>
                      </FormControl>
                    </FormItem>
                  )} />
                </CardContent>
              </Card>

              {vendorAcceptsChecks === false ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Cannot Proceed</AlertTitle>
                  <AlertDescription>
                    CEPS (Financial Management Service) can only issue payments via physical check. If the vendor strictly requires ACH, credit card, or Zelle and will not accept a check, we cannot process this referral.
                  </AlertDescription>
                </Alert>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Vendor Details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField control={form.control} name="vendorName" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Vendor / Business Name</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="vendorEmail" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Vendor Email</FormLabel>
                          <FormControl><Input type="email" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="vendorPhone" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Vendor Phone</FormLabel>
                          <FormControl><Input type="tel" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    
                    <Separator className="my-4" />
                    
                    <h3 className="text-sm font-medium">Service Address</h3>
                    <FormField control={form.control} name="vendorServiceStreet" render={({ field }) => (
                      <FormItem><FormControl><Input placeholder="Street Address" {...field} /></FormControl></FormItem>
                    )} />
                    <div className="grid grid-cols-3 gap-4">
                      <FormField control={form.control} name="vendorServiceCity" render={({ field }) => (
                        <FormItem className="col-span-2"><FormControl><Input placeholder="City" {...field} /></FormControl></FormItem>
                      )} />
                      <FormField control={form.control} name="vendorServiceZip" render={({ field }) => (
                        <FormItem><FormControl><Input placeholder="ZIP Code" {...field} /></FormControl></FormItem>
                      )} />
                    </div>

                    <Separator className="my-4" />
                    
                    <FormField control={form.control} name="vendorBillingDifferent" render={({ field }) => (
                      <FormItem className="space-y-3">
                        <FormLabel>Is the billing address different from the service address?</FormLabel>
                        <FormControl>
                          <RadioGroup onValueChange={field.onChange} defaultValue={field.value} className="flex space-x-4">
                            <FormItem className="flex items-center space-x-2 space-y-0"><FormControl><RadioGroupItem value="no" /></FormControl><FormLabel className="font-normal">No</FormLabel></FormItem>
                            <FormItem className="flex items-center space-x-2 space-y-0"><FormControl><RadioGroupItem value="yes" /></FormControl><FormLabel className="font-normal">Yes</FormLabel></FormItem>
                            <FormItem className="flex items-center space-x-2 space-y-0"><FormControl><RadioGroupItem value="unknown" /></FormControl><FormLabel className="font-normal">Unknown</FormLabel></FormItem>
                          </RadioGroup>
                        </FormControl>
                      </FormItem>
                    )} />

                    {vendorBillingDifferent === 'yes' && (
                      <div className="space-y-4 pt-2 border-l-2 border-primary pl-4 ml-2">
                        <h3 className="text-sm font-medium">Billing Address</h3>
                        <FormField control={form.control} name="vendorBillingStreet" render={({ field }) => (
                          <FormItem><FormControl><Input placeholder="Billing Street Address" {...field} /></FormControl><FormMessage /></FormItem>
                        )} />
                        <div className="grid grid-cols-3 gap-4">
                          <FormField control={form.control} name="vendorBillingCity" render={({ field }) => (
                            <FormItem className="col-span-2"><FormControl><Input placeholder="City" {...field} /></FormControl></FormItem>
                          )} />
                          <FormField control={form.control} name="vendorBillingZip" render={({ field }) => (
                            <FormItem><FormControl><Input placeholder="ZIP Code" {...field} /></FormControl></FormItem>
                          )} />
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* STEP 2: Activity */}
          {currentStep === 2 && (
            <Card>
              <CardHeader>
                <CardTitle>Activity Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <FormField control={form.control} name="serviceType" render={({ field }) => (
                  <FormItem className="space-y-3">
                    <FormLabel>Payment Mechanism</FormLabel>
                    <FormControl>
                      <RadioGroup onValueChange={field.onChange} defaultValue={field.value} className="grid grid-cols-2 gap-4">
                        <FormItem>
                          <FormControl><RadioGroupItem value="direct_pay_459" className="peer sr-only" /></FormControl>
                          <FormLabel className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer">
                            <span className="font-semibold mb-1">Direct Pay (459)</span>
                            <span className="text-xs text-muted-foreground text-center">We pay vendor directly</span>
                          </FormLabel>
                        </FormItem>
                        <FormItem>
                          <FormControl><RadioGroupItem value="reimbursement_024" className="peer sr-only" /></FormControl>
                          <FormLabel className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer">
                            <span className="font-semibold mb-1">Reimbursement (024)</span>
                            <span className="text-xs text-muted-foreground text-center">Family pays, we reimburse</span>
                          </FormLabel>
                        </FormItem>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )} />

                <FormField control={form.control} name="activityDescription" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description of Activity</FormLabel>
                    <FormControl><Textarea placeholder="e.g. Weekly art therapy sessions" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="serviceStartDate" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Anticipated Start Date</FormLabel>
                      <FormControl><Input type="date" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="serviceEndDate" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Anticipated End Date</FormLabel>
                      <FormControl><Input type="date" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                <div className="bg-secondary/50 p-4 rounded-lg space-y-4">
                  <h3 className="text-sm font-medium">Current POS Details (If Known)</h3>
                  <FormField control={form.control} name="posNumber" render={({ field }) => (
                    <FormItem>
                      <FormLabel>POS Number</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                    </FormItem>
                  )} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* STEP 3: Client */}
          {currentStep === 3 && (
            <Card>
              <CardHeader>
                <CardTitle>Participant Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="clientFirstName" render={({ field }) => (
                    <FormItem><FormLabel>First Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="clientLastName" render={({ field }) => (
                    <FormItem><FormLabel>Last Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="clientDob" render={({ field }) => (
                    <FormItem><FormLabel>Date of Birth</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="clientUci" render={({ field }) => (
                    <FormItem><FormLabel>UCI Number</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>

                <Separator />

                <FormField control={form.control} name="clientIsMinor" render={({ field }) => (
                  <FormItem className="space-y-3">
                    <FormLabel>Is the participant a minor?</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={(val) => {
                          const isMinor = val === 'true';
                          field.onChange(isMinor);
                          if (isMinor) {
                            form.setValue('familyRepName', '');
                            form.setValue('familyRepRelationship', '');
                            form.setValue('familyRepPhone', '');
                            form.setValue('familyRepEmail', '');
                            form.setValue('familyRepAddress', '');
                            setFamilyRepOpen(false);
                          }
                        }}
                        value={field.value ? 'true' : 'false'}
                        className="flex space-x-4"
                      >
                        <FormItem className="flex items-center space-x-2 space-y-0"><FormControl><RadioGroupItem value="true" /></FormControl><FormLabel className="font-normal">Yes</FormLabel></FormItem>
                        <FormItem className="flex items-center space-x-2 space-y-0"><FormControl><RadioGroupItem value="false" /></FormControl><FormLabel className="font-normal">No</FormLabel></FormItem>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )} />

                <div className="bg-secondary/30 p-4 rounded-lg border space-y-4">
                  <h3 className="text-sm font-medium flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" />
                    {clientIsMinor ? "Parent/Guardian Contact Info" : "Participant Contact Info"}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    This email will receive the digital signature request to authorize services.
                  </p>

                  {clientIsMinor && (
                    <FormField control={form.control} name="familyRepName" render={({ field }) => (
                      <FormItem><FormLabel>Parent/Guardian Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="contactEmail" render={({ field }) => (
                      <FormItem><FormLabel>Email Address</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="contactPhone" render={({ field }) => (
                      <FormItem><FormLabel>Phone Number</FormLabel><FormControl><Input type="tel" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>

                  <FormField control={form.control} name="contactStreet" render={({ field }) => (
                    <FormItem><FormLabel>Mailing Address</FormLabel><FormControl><Input placeholder="Street Address" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <div className="grid grid-cols-3 gap-4">
                    <FormField control={form.control} name="contactCity" render={({ field }) => (
                      <FormItem className="col-span-2"><FormControl><Input placeholder="City" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="contactZip" render={({ field }) => (
                      <FormItem><FormControl><Input placeholder="ZIP" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                </div>

                {!clientIsMinor && (
                  <div className="rounded-lg border">
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full justify-between whitespace-normal text-left"
                      aria-expanded={familyRepOpen}
                      aria-controls="optional-family-representative"
                      onClick={() => setFamilyRepOpen((open) => !open)}
                      data-testid="toggle-optional-family-representative"
                    >
                      <span>Add a family representative (optional)</span>
                      <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${familyRepOpen ? 'rotate-180' : ''}`} />
                    </Button>
                    {familyRepOpen && (
                      <div id="optional-family-representative" className="space-y-4 border-t p-4" data-testid="optional-family-representative">
                        <FormField control={form.control} name="familyRepName" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Name</FormLabel>
                            <FormControl><Input {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={form.control} name="familyRepRelationship" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Relationship</FormLabel>
                            <Select value={field.value || ''} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select relationship" /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="parent">Parent</SelectItem>
                                <SelectItem value="guardian">Guardian</SelectItem>
                                <SelectItem value="conservator">Conservator</SelectItem>
                                <SelectItem value="other">Other</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <FormField control={form.control} name="familyRepPhone" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Phone</FormLabel>
                              <FormControl><Input type="tel" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="familyRepEmail" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Email</FormLabel>
                              <FormControl><Input type="email" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                        <FormField control={form.control} name="familyRepAddress" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Address</FormLabel>
                            <FormControl><Input {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      </div>
                    )}
                  </div>
                )}

              </CardContent>
            </Card>
          )}

          {/* STEP 4: Documents */}
          {currentStep === 4 && (
            <Card>
              <CardHeader>
                <CardTitle>Supporting Documents</CardTitle>
                  <CardDescription>Optionally upload any invoices, receipts, or other supporting documents if available.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Attach Document (Optional)</Label>
                  {supportingDocumentUrl ? (
                    <div className="flex items-center justify-between rounded-md border p-3 text-sm" data-testid="text-referral-document-attached">
                      <span className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-muted-foreground" /> Document attached
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setSupportingDocumentUrl(undefined)}
                        data-testid="button-remove-referral-document"
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <FileUpload
                      label="Drag & drop a supporting document here, or click to browse"
                      onUploaded={(r) => setSupportingDocumentUrl(r.objectPath)}
                    />
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* STEP 5: Review */}
          {currentStep === 5 && (
            <Card>
              <CardHeader>
                <CardTitle>Review & Submit</CardTitle>
                <CardDescription>Verify all information before creating the referral.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid md:grid-cols-2 gap-8 text-sm">
                  <div className="space-y-4">
                    <div>
                      <h4 className="font-semibold text-primary border-b pb-1 mb-2">Coordinator</h4>
                      <dl className="grid grid-cols-3 gap-1">
                        <dt className="text-muted-foreground">Name:</dt><dd className="col-span-2">{watch('coordinatorName')}</dd>
                        <dt className="text-muted-foreground">Center:</dt><dd className="col-span-2">{watch('regionalCenterName')}</dd>
                      </dl>
                    </div>
                    <div>
                      <h4 className="font-semibold text-primary border-b pb-1 mb-2">Vendor</h4>
                      <dl className="grid grid-cols-3 gap-1">
                        <dt className="text-muted-foreground">Name:</dt><dd className="col-span-2">{watch('vendorName')}</dd>
                        <dt className="text-muted-foreground">Accepts Cks:</dt><dd className="col-span-2">{watch('vendorAcceptsChecks') ? 'Yes' : 'No'}</dd>
                      </dl>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <h4 className="font-semibold text-primary border-b pb-1 mb-2">Participant</h4>
                      <dl className="grid grid-cols-3 gap-1">
                        <dt className="text-muted-foreground">Name:</dt><dd className="col-span-2">{watch('clientFirstName')} {watch('clientLastName')}</dd>
                        <dt className="text-muted-foreground">UCI:</dt><dd className="col-span-2">{watch('clientUci')}</dd>
                        <dt className="text-muted-foreground">Contact Email:</dt><dd className="col-span-2 font-medium">{watch('contactEmail')}</dd>
                        {supportingDocumentUrl && (<><dt className="text-muted-foreground">Document:</dt><dd className="col-span-2">Attached</dd></>)}
                      </dl>
                    </div>
                    <div>
                      <h4 className="font-semibold text-primary border-b pb-1 mb-2">Activity</h4>
                      <dl className="grid grid-cols-3 gap-1">
                        <dt className="text-muted-foreground">Type:</dt><dd className="col-span-2">{watch('serviceType') === 'direct_pay_459' ? 'Direct Pay' : 'Reimbursement'}</dd>
                        <dt className="text-muted-foreground">Desc:</dt><dd className="col-span-2 truncate" title={watch('activityDescription')}>{watch('activityDescription')}</dd>
                      </dl>
                    </div>
                  </div>
                </div>

                <Alert className="bg-primary/5 border-primary/20">
                  <AlertTitle className="text-primary">Next Steps</AlertTitle>
                  <AlertDescription>
                    After saving the referral, choose the agreement recipient on the referral page to send the signature link to <strong>{watch('contactEmail')}</strong> or another recipient.
                  </AlertDescription>
                </Alert>

              </CardContent>
            </Card>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between pt-4">
            <Button 
              type="button" 
              variant="outline" 
              onClick={prevStep} 
              disabled={currentStep === 0 || createReferral.isPending}
            >
              <ChevronLeft className="w-4 h-4 mr-2" /> Back
            </Button>
            
            {currentStep < STEPS.length - 1 ? (
              <Button 
                key="next"
                type="button" 
                onClick={nextStep}
                disabled={vendorAcceptsChecks === false}
              >
                Next <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            ) : (
              <Button 
                key="submit"
                type="button"
                onClick={form.handleSubmit(onSubmit)}
                disabled={createReferral.isPending}
                className="bg-chart-5 hover:bg-chart-5/90 text-white"
              >
                {createReferral.isPending ? 'Submitting...' : 'Submit Referral'}
              </Button>
            )}
          </div>
        </form>
      </Form>
    </div>
  );
}
