import { User } from 'lucide-react';

export type AgreementReviewData = {
  clientName: string;
  participantDob?: string | null;
  participantUci?: string | null;
  clientIsMinor: boolean;
  regionalCenter?: string | null;
  serviceCoordinatorName?: string | null;
  serviceCoordinatorPhone?: string | null;
  representativeName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  mailingAddress?: string | null;
  vendorName?: string | null;
  activityDescription?: string | null;
  activityContactName?: string | null;
  activityContactPhone?: string | null;
  activityMailingAddress?: string | null;
  serviceType?: string | null;
  serviceStartDate?: string | null;
  serviceEndDate?: string | null;
  serviceFrequency?: string | null;
  cost?: string | null;
  paymentSchedule?: string | null;
  paymentTypeRequested?: string | null;
  agreementText: string;
};

const shown = (value?: string | null) => value || 'Not specified';
const label = (value?: string | null) => value ? value.replace(/_/g, ' ') : 'Not specified';

export function AgreementReview({ data }: { data: AgreementReviewData }) {
  return (
    <div className="space-y-8" data-testid="agreement-review">
      {data.clientIsMinor && (
        <div className="bg-muted text-muted-foreground p-3 rounded-md text-sm border flex items-center gap-2">
          <User className="w-4 h-4 shrink-0" />
          <strong>Note:</strong> This agreement will be signed on behalf of a minor.
        </div>
      )}

      <div className="bg-secondary/30 rounded-lg border p-6 space-y-6 text-sm">
        <section>
          <h3 className="font-semibold text-base border-b pb-2 mb-3">Participant Information</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Name</p><p className="font-medium">{data.clientName}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">DOB</p><p className="font-medium">{shown(data.participantDob)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">UCI Number</p><p className="font-medium">{shown(data.participantUci)}</p></div>
          </div>
        </section>

        <section>
          <h3 className="font-semibold text-base border-b pb-2 mb-3">Regional Center / Service Coordinator</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Regional Center</p><p className="font-medium">{shown(data.regionalCenter)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Coordinator Name</p><p className="font-medium">{shown(data.serviceCoordinatorName)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Coordinator Phone</p><p className="font-medium">{shown(data.serviceCoordinatorPhone)}</p></div>
          </div>
        </section>

        <section>
          <h3 className="font-semibold text-base border-b pb-2 mb-3">Signer / Representative Contact</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Name</p><p className="font-medium">{shown(data.representativeName)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Phone</p><p className="font-medium">{shown(data.contactPhone)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Email</p><p className="font-medium">{shown(data.contactEmail)}</p></div>
            <div className="sm:col-span-2 lg:col-span-1"><p className="text-muted-foreground text-xs uppercase tracking-wider">Mailing Address</p><p className="font-medium">{shown(data.mailingAddress)}</p></div>
          </div>
        </section>

        <section>
          <h3 className="font-semibold text-base border-b pb-2 mb-3">Vendor & Activity Information</h3>
          <div className="grid sm:grid-cols-3 gap-4">
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Vendor/Program Name</p><p className="font-medium">{shown(data.vendorName)}</p></div>
            <div className="sm:col-span-2"><p className="text-muted-foreground text-xs uppercase tracking-wider">Activity Description</p><p className="font-medium">{shown(data.activityDescription)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Contact Name</p><p className="font-medium">{shown(data.activityContactName)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Contact Phone</p><p className="font-medium">{shown(data.activityContactPhone)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Mailing Address</p><p className="font-medium">{shown(data.activityMailingAddress)}</p></div>
          </div>
        </section>

        <section>
          <h3 className="font-semibold text-base border-b pb-2 mb-3">Service & Payment Details</h3>
          <div className="grid sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Service Type</p><p className="font-medium capitalize">{label(data.serviceType)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Start Date</p><p className="font-medium">{shown(data.serviceStartDate)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">End Date</p><p className="font-medium">{shown(data.serviceEndDate)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Frequency</p><p className="font-medium capitalize" data-testid="agreement-frequency">{label(data.serviceFrequency)}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Cost</p><p className="font-medium" data-testid="agreement-cost">{data.cost ? `$${data.cost}` : 'Not specified'}</p></div>
            <div><p className="text-muted-foreground text-xs uppercase tracking-wider">Payment Schedule</p><p className="font-medium" data-testid="agreement-payment-schedule">{shown(data.paymentSchedule)}</p></div>
            <div className="sm:col-span-2"><p className="text-muted-foreground text-xs uppercase tracking-wider">Payment Type Requested</p><p className="font-medium capitalize" data-testid="agreement-payment-type">{label(data.paymentTypeRequested)}</p></div>
          </div>
        </section>
      </div>

      <section className="space-y-4">
        <h3 className="text-lg font-semibold tracking-tight">Agreement Terms</h3>
        <div className="prose prose-sm max-w-none whitespace-pre-line text-muted-foreground bg-white dark:bg-black rounded-lg border p-6 h-64 overflow-y-auto" data-testid="agreement-terms">
          {data.agreementText}
        </div>
      </section>
    </div>
  );
}