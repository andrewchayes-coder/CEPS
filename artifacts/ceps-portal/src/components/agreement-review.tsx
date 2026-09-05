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
        <div className="prose prose-sm max-w-none text-muted-foreground bg-white dark:bg-black rounded-lg border p-6 h-64 overflow-y-auto" data-testid="agreement-terms">
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
      </section>
    </div>
  );
}