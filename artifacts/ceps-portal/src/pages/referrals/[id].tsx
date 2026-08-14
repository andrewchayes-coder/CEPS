import React from 'react';
import { useLocation, useParams } from 'wouter';
import { useGetReferral, useUpdateReferral, useSendReferralMagicLink } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { Mail, CheckCircle2, AlertTriangle, FileText, ArrowLeft, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { Link } from 'wouter';

export default function ReferralDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: referral, isLoading, refetch } = useGetReferral(id, {
    query: {
      enabled: !!id,
      queryKey: ['referrals', id]
    }
  });

  const sendMagicLink = useSendReferralMagicLink();
  const updateReferral = useUpdateReferral();

  if (isLoading) return <div className="p-8 text-center">Loading referral...</div>;
  if (!referral) return <div className="p-8 text-center">Referral not found.</div>;

  const handleResendLink = () => {
    sendMagicLink.mutate({ id }, {
      onSuccess: (res) => {
        toast({
          title: "Link Sent",
          description: `Signature link emailed to ${referral.parentEmail}.`,
        });
        if (res.devLink) {
          console.log("Dev Magic Link:", res.devLink);
        }
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to send the magic link.",
        });
      }
    });
  };

  const intake = referral.intakeFields;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link href="/referrals"><ArrowLeft className="w-4 h-4 mr-2" /> Back to Referrals</Link>
      </Button>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Referral: {referral.clientName}</h1>
          <p className="text-muted-foreground mt-1">Submitted on {format(new Date(referral.referralDate), 'MMMM d, yyyy')}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline" className="text-sm px-3 py-1">
            Status: <span className="font-semibold ml-1 capitalize">{referral.status.replace('_', ' ')}</span>
          </Badge>
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Main Info */}
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="w-5 h-5 text-primary" />
                Intake Details
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4 grid sm:grid-cols-2 gap-y-6 gap-x-8 text-sm">
              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Client Info</p>
                <p className="font-semibold">{intake?.clientFirstName} {intake?.clientLastName}</p>
                <p>DOB: {intake?.clientDob}</p>
                <p>UCI: {intake?.clientUci}</p>
                <p>Language: {intake?.preferredLanguage}</p>
              </div>

              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Service Activity</p>
                <p className="font-semibold">
                  {intake?.serviceType === 'direct_pay_459' ? 'Direct Pay (459)' : 'Reimbursement (024)'}
                </p>
                <p className="line-clamp-2" title={intake?.activityDescription}>{intake?.activityDescription}</p>
                <p>Dates: {intake?.serviceStartDate} to {intake?.serviceEndDate}</p>
              </div>

              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Vendor</p>
                <p className="font-semibold">{intake?.vendorName}</p>
                <p>{intake?.vendorEmail}</p>
                <p>{intake?.vendorPhone}</p>
              </div>

              <div className="space-y-1">
                <p className="text-muted-foreground font-medium">Coordinator</p>
                <p className="font-semibold">{intake?.coordinatorName}</p>
                <p>{intake?.regionalCenterName}</p>
                <p>{intake?.coordinatorEmail}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar Actions */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Signature Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {referral.parentSignedAt ? (
                <div className="bg-chart-5/10 text-chart-5 border border-chart-5/20 rounded-md p-4 flex gap-3">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <div className="text-sm">
                    <p className="font-semibold">Signed by {referral.signedByName}</p>
                    <p className="opacity-90">{format(new Date(referral.parentSignedAt), 'MMM d, yyyy h:mm a')}</p>
                  </div>
                </div>
              ) : (
                <div className="bg-chart-2/10 text-chart-2 border border-chart-2/20 rounded-md p-4 flex gap-3">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <div className="text-sm space-y-2">
                    <p className="font-semibold">Awaiting Signature</p>
                    <p className="opacity-90 break-all">{referral.parentEmail}</p>
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="w-full mt-2 bg-white/50 hover:bg-white text-chart-2 border-chart-2/30"
                      onClick={handleResendLink}
                      disabled={sendMagicLink.isPending}
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      {sendMagicLink.isPending ? 'Sending...' : 'Resend Link'}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Alta POS Auth</CardTitle>
            </CardHeader>
            <CardContent>
               {referral.altaAuthReceivedAt ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-chart-5" />
                    Received {format(new Date(referral.altaAuthReceivedAt), 'MMM d, yyyy')}
                  </div>
               ) : (
                 <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">Waiting for official POS authorization from Regional Center.</p>
                    <Button 
                      variant="outline" 
                      className="w-full"
                      onClick={() => {
                        updateReferral.mutate({ id, data: { altaAuthReceivedAt: new Date().toISOString() } }, {
                          onSuccess: () => refetch()
                        });
                      }}
                    >
                      <RefreshCw className="w-4 h-4 mr-2" /> Mark Received
                    </Button>
                 </div>
               )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
