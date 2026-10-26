import type { InvoiceStatus } from '@workspace/api-client-react';

export interface UserStory {
  as: string;
  want: string;
  soThat: string;
}

export interface WorkflowStep {
  title: string;
  description: string;
}

export interface Workflow {
  name: string;
  summary: string;
  steps: WorkflowStep[];
}

export interface RoleDoc {
  role: string;
  visibleTo: string[];
  label: string;
  overview: string;
  stories: UserStory[];
  workflows: Workflow[];
}

export const invoiceStatusSteps: (WorkflowStep & { status: InvoiceStatus })[] = [
  { status: 'needs_entry', title: 'Awaiting CEPS Entry', description: 'Your document has been submitted. CEPS still needs to enter its invoice lines and review the details.' },
  { status: 'pending_review', title: 'Pending Review', description: 'The invoice has been entered and is waiting for review and validation.' },
  { status: 'validated', title: 'Validated', description: 'The invoice has passed validation checks and is waiting for CEPS approval.' },
  { status: 'approved', title: 'Approved', description: 'CEPS has approved the invoice for payment. Open Payments to see when the check was issued.' },
  { status: 'rejected', title: 'Rejected', description: 'The invoice was not approved. Read the reason and contact CEPS about the correction needed.' },
  { status: 'duplicate', title: 'Duplicate', description: 'The invoice has been flagged as a possible duplicate. CEPS needs to check it before approval.' },
];

function messagesWorkflow(start: string): Workflow {
  return {
    name: 'Messages',
    summary: 'Keep conversations with CEPS attached to the participant record.',
    steps: [
      { title: 'Start a message', description: start },
      { title: 'Check who can see it', description: 'All CEPS staff see every thread in their shared inbox. The participant’s current service coordinator sees threads that include the coordinator, and selected family portal users see only threads they are on. Check the To: line before replying.' },
      { title: 'Read and reply', description: 'Open a thread to read its messages and mark it read for your account. Write a reply and select Send, or use Ctrl+Enter or Cmd+Enter. Messages are permanent: they cannot be edited or deleted.' },
      { title: 'Find older conversations', description: 'Messages starts with threads whose last message is in the last 6 months. Choose Archive (older) for older conversations, or Custom range to select dates. Search and the All / Unread views help you find a thread.' },
      { title: 'Open and resolved threads', description: 'Use the Open / Resolved / All filter to find conversations. Staff and the assigned coordinator can mark a thread resolved or reopen it. A new reply from someone other than the person who resolved it reopens the thread automatically.' },
      { title: 'Check for replies', description: 'There are no email notifications yet. Check Messages when you sign in; the unread badge shows new replies.' },
    ],
  };
}

export const roleDocs: RoleDoc[] = [
  {
    role: 'staff',
    visibleTo: ['staff'],
    label: 'CEPS Staff',
    overview:
      'CEPS staff support referrals, participants, vendors, authorizations, invoices, payments, and remittances. Each staff account is assigned a role that determines its permissions. The protected Admin role can manage users and roles; other roles can be configured on the Roles screen.',
    stories: [
      { as: 'a CEPS staff member', want: 'to review incoming referrals from service coordinators', soThat: 'new participants can be onboarded into the program quickly and accurately' },
      { as: 'a CEPS staff member', want: 'to send agreements for e-signature to families and participants', soThat: 'program enrollment is documented without paper forms' },
      { as: 'a CEPS staff member', want: 'to create and track purchase-of-service authorizations', soThat: 'vendor services stay within approved units and date ranges' },
      { as: 'a CEPS staff member', want: 'to review vendor invoices against active authorizations', soThat: 'only valid, authorized services are approved for payment' },
      { as: 'a CEPS staff member', want: 'to record payments and reconcile Remittance Reports', soThat: 'the check register matches funding received from the regional center' },
      { as: 'a CEPS staff member', want: 'to manage user accounts for all roles', soThat: 'coordinators, families, participants, and vendors can access their own portals securely' },
      { as: 'a CEPS staff member', want: 'to view program-wide reports', soThat: 'I can monitor spending, vendor activity, and participant status at a glance' },
    ],
    workflows: [
      messagesWorkflow('Open a participant record and choose New message in Messages, or open Messages in the left navigation, choose New message, and select the participant. Enter a subject and message, choose the coordinator and/or family portal recipients, then send. Staff can add eligible family members to an existing thread.'),
      {
        name: 'Referrals & participant onboarding',
        summary: 'Turn a new referral from a service coordinator into an active participant.',
        steps: [
          { title: 'Review the referral', description: 'Open Referrals, review participant details, UCI number, and the coordinator\u2019s notes.' },
          { title: 'Review participant updates', description: 'Submitting a referral creates or links the participant record. If the referral is awaiting CEPS review, use Coordinator referral review to compare the submitted details and approve or reject the proposed changes.' },
          { title: 'Send the agreement', description: 'Send the CEPS participation agreement for e-signature to the parent/guardian or self-representing participant.' },
          { title: 'Track enrollment', description: 'After the agreement is signed, check the referral status and outstanding authorization, vendor W-9, and invoice requirements. Signing alone does not complete those steps.' },
        ],
      },
      {
        name: 'Authorization management',
        summary: 'Create and maintain purchase-of-service authorizations tied to Alta POS documents.',
        steps: [
          { title: 'Create the authorization', description: 'From Authorizations, choose the participant and vendor, then enter the POS Number, Service Code, Period Start Date, Period End Date, Received Date, and Max Period Amount. Monthly Amount is optional. You can also upload the Alta POS PDF for AI-assisted drafting, then review before saving.' },
          { title: 'Resolve warnings', description: 'If the system flags overlaps or missing data, review the warnings and correct the draft before saving.' },
          { title: 'Monitor utilization', description: 'Track authorization usage as payments are recorded; fee authorizations track monthly fees. Renew or amend an authorization before it expires.' },
        ],
      },
      {
        name: 'Invoice review & payment',
        summary: 'Review submitted documents, approve invoices, and track payments and monthly fees.',
        steps: [
          { title: 'Complete Awaiting CEPS Entry', description: 'Open documents marked Awaiting CEPS Entry and enter their invoice lines. Confirm Invoice or Receipt separately from the payment type, check the submitted service start and end dates, and save the entry before validation.' },
          { title: 'Validate the invoice', description: 'Review the validation results and check each entered line against its authorization, service month, and amount before approval.' },
          { title: 'Approve or reject', description: 'Approve valid invoices; reject with a note when something doesn\u2019t match so the vendor can correct it.' },
          { title: 'Record the payment', description: 'Record each check line against its authorization and service month. On the participant Payments tab, each line shows its own amount and remittance state, while the Payments Log remains one row per check.' },
          { title: 'Review monthly fees', description: 'The participant Fees tab groups the $160 administrative fee by service month, shows its 490 fee authorization, and marks it Paid only when a fee remittance is matched.' },
        ],
      },
      {
        name: 'Alta FMS payment import',
        summary: 'Audit QuickBooks checks against approved invoices before recording payments.',
        steps: [
          { title: 'Choose a workbook', description: 'From Payments, select Import Alta FMS Payments and upload the Transaction Detail by Account .xlsx file. No payments are saved during this audit.' },
          { title: 'Review the audit', description: 'Compare each check’s payee and amount with the approved vendor, approved amount, and remaining unpaid amount. Open linked invoices and review who approved them. Green rows match; flagged rows explain the discrepancy. Download the audit CSV for your records.' },
          { title: 'Resolve exceptions', description: 'Correct the source workbook and re-upload, or enter an individual acknowledgment note for each actionable exception. When several approved invoices could apply, open them and deliberately choose one as well. Unknown participants, unknown authorizations, and already imported rows cannot be acknowledged and are skipped.' },
          { title: 'Import reviewed checks', description: 'Import is available only after every actionable flag has a note. Review the post-import results and download the correction or full audit CSV as needed. Check-Run Reconciliation remains a separate workflow.' },
        ],
      },
      {
        name: 'Remittance reconciliation',
        summary: 'Match Remittance Reports against the CEPS check register.',
        steps: [
          { title: 'Import the remittance', description: 'From Remittances, add the Remittance Report for the funding period.' },
          { title: 'Match line items', description: 'Match each remittance to a check line or monthly fee. Open a payment to see which remittance paid each line; investigate unmatched or partially funded lines.' },
          { title: 'Check the remaining balance', description: 'Review the remaining amount and allocation lines. A fully allocated remittance is marked matched automatically; there is no separate Mark reconciled action.' },
        ],
      },
      {
        name: 'User administration',
        summary: 'Manage portal access for every role.',
        steps: [
          { title: 'Create the user', description: 'From Users, add the person with the correct role and link them to their participant or vendor record where applicable.' },
          { title: 'Provide sign-in details', description: 'Create and share a sign-in link so the person can access the portal without a password, or set an initial password. Do not rely on automatic email delivery.' },
          { title: 'Deactivate when needed', description: 'Deactivate accounts promptly when a family, participant, or vendor leaves the program.' },
        ],
      },
    ],
  },
  {
    role: 'service_coordinator',
    visibleTo: ['staff', 'service_coordinator'],
    label: 'Service Coordinator',
    overview:
      'Alta Regional Center service coordinators refer participants into the CEPS program and monitor the services and authorizations for the participants on their caseload.',
    stories: [
      { as: 'a service coordinator', want: 'to submit a referral for a participant who needs payee support', soThat: 'the family can start receiving FMS services through CEPS' },
      { as: 'a service coordinator', want: 'to see the status of my referrals', soThat: 'I know when a participant has been onboarded or if CEPS needs more information' },
      { as: 'a service coordinator', want: 'to view the participants on my caseload and their authorizations', soThat: 'I can verify services match the IPP and stay within approved funding' },
      { as: 'a service coordinator', want: 'to view reports for my caseload', soThat: 'I can prepare for planning meetings with accurate service data' },
      { as: 'a service coordinator', want: 'to submit an invoice or receipt with service dates and supporting files', soThat: 'CEPS can enter the billing details and review it for payment' },
    ],
    workflows: [
      messagesWorkflow('Open a participant on your caseload and choose New message in Messages, or choose New message from Messages in the left navigation and select the participant. Enter a subject and message, optionally include family portal users, and send. CEPS staff and you are included. You can also add eligible family members to a thread you can see.'),
      {
        name: 'Submitting a referral',
        summary: 'Refer a participant into the CEPS program.',
        steps: [
          { title: 'Start the referral', description: 'From Referrals, choose New Referral and enter the participant\u2019s details, UCI number, and the services being requested.' },
          { title: 'Complete the details', description: 'Enter the vendor and addresses, service dates and required authorization amount, participant details, preferred language, and any family representative details. Attach supporting documents if available.' },
          { title: 'Track progress', description: 'Watch the referral status \u2014 CEPS staff will accept it, request more information, or contact the family directly.' },
        ],
      },
      {
        name: 'Submitting an invoice or receipt',
        summary: 'Send supporting documents to CEPS for entry and review.',
        steps: [
          { title: 'Choose the participant', description: 'From Invoices, choose Submit Invoice and select a participant on your caseload. Select the vendor if known; it is optional at submission.' },
          { title: 'Identify the document and dates', description: 'Choose Invoice or Receipt and enter the service start and end dates.' },
          { title: 'Attach and submit files', description: 'Attach one or more supporting files and submit them to CEPS. Each file becomes a separate submission; check each file’s result and retry any that failed.' },
          { title: 'Follow the review', description: 'Each submission starts as Awaiting CEPS Entry. CEPS enters the invoice lines and reviews them, then the status moves through Pending Review, Validated, and Approved as applicable. Open Payments to see issued checks. Check the invoice for any rejection or duplicate warning.' },
        ],
      },
      {
        name: 'Downloading a referral confirmation',
        summary: 'Keep a PDF confirmation of a submitted referral.',
        steps: [
          { title: 'Download after submission', description: 'On the confirmation screen after saving a new referral, choose Download confirmation to save the PDF.' },
          { title: 'Download again later', description: 'Open the saved referral from Referrals and choose Download confirmation.' },
        ],
      },
      {
        name: 'Participant notes',
        summary: 'Share participant context with CEPS staff.',
        steps: [
          { title: 'Open the participant', description: 'Open a participant on your caseload and find the Notes section on their profile.' },
          { title: 'Add a note', description: 'Write and save a plain-text note. The note is visible to CEPS staff.' },
          { title: 'Keep your notes current', description: 'Use Edit on your own notes to correct or update them. Edits are recorded in the audit history.' },
        ],
      },
      {
        name: 'Monitoring your caseload',
        summary: 'Keep an eye on participants, authorizations, and utilization.',
        steps: [
          { title: 'Review participants', description: 'Open Participants to see everyone on your caseload with their program status.' },
          { title: 'Check authorizations', description: 'Use the Expiring Authorizations tile on your dashboard to see how many active authorizations end in the next 30 days. Select the tile to open the report.' },
          { title: 'Use caseload reports', description: 'Reports opens to Expiring Authorizations and shows participants on your caseload only. You can also open the Pending Authorization report.' },
          { title: 'Flag issues early', description: 'If an authorization is close to exhausted or expiring, coordinate with CEPS staff before services lapse.' },
        ],
      },
    ],
  },
  {
    role: 'parent_guardian',
    visibleTo: ['staff', 'service_coordinator', 'parent_guardian'],
    label: 'Parent / Guardian',
    overview:
      'Parents and guardians represent their family member in the CEPS program. They sign agreements, choose vendors with their coordinator, and can see every invoice and payment made on their family member\u2019s behalf.',
    stories: [
      { as: 'a parent or guardian', want: 'to sign the CEPS agreement online', soThat: 'my family member can be enrolled without mailing paperwork' },
      { as: 'a parent or guardian', want: 'to submit invoices or receipts with service dates and supporting files', soThat: 'CEPS can enter and review the billing for my family member' },
      { as: 'a parent or guardian', want: 'to see payments made to vendors', soThat: 'I can confirm program funds are being spent correctly' },
      { as: 'a parent or guardian', want: 'to sign in with a link provided by CEPS', soThat: 'I don\u2019t have to remember another password' },
    ],
    workflows: [
      messagesWorkflow('Open Messages in the left navigation or use Messages with CEPS on your family member’s record. Choose New message, enter a subject and message, and send it to CEPS staff and the coordinator shown. You can also reply to conversations you have been included in.'),
      {
        name: 'Enrolling your family member',
        summary: 'From referral to active services.',
        steps: [
          { title: 'Work with your coordinator', description: 'Your Alta service coordinator submits the referral to CEPS on your behalf.' },
          { title: 'Sign the agreement', description: 'Open the agreement link provided by CEPS to review and e-sign the CEPS participation agreement.' },
          { title: 'Get portal access', description: 'Use the password or sign-in link provided by CEPS to access your account.' },
        ],
      },
      {
        name: 'Submitting an invoice or receipt',
        summary: 'Send documents for your family member without entering invoice lines.',
        steps: [
          { title: 'Start the submission', description: 'From Invoices, choose Submit Invoice. The submission is linked to your family member; select a vendor if known.' },
          { title: 'Add the document details', description: 'Choose Invoice or Receipt and enter the service start and end dates.' },
          { title: 'Attach and submit files', description: 'Attach one or more files, then submit them to CEPS. Each file becomes a separate submission. Check each result and retry any failed files.' },
          { title: 'Leave billing entry to CEPS', description: 'The status starts as Awaiting CEPS Entry. CEPS enters the invoice lines and reviews the submission; you do not need to enter amounts or authorization lines.' },
        ],
      },
      {
        name: 'Reviewing invoices & payments',
        summary: 'Stay informed about services billed and paid.',
        steps: [
          { title: 'Check invoices', description: 'Open Invoices to see what each vendor has billed, including service dates and amounts.' },
          ...invoiceStatusSteps,
          { title: 'Check payments', description: 'Open a participant’s Payments tab to see each check line by service month, what has been remitted, and the monthly fee status on the Fees tab.' },
          { title: 'Ask questions', description: 'If something looks wrong, contact CEPS staff \u2014 invoices can be corrected before payment.' },
        ],
      },
    ],
  },
  {
    role: 'self',
    visibleTo: ['staff', 'service_coordinator', 'self'],
    label: 'Self-Representing Participant',
    overview:
      'Self-representing participants manage their own participation in the CEPS program: they sign their own agreement and can see every invoice and payment made with their funding.',
    stories: [
      { as: 'a self-representing participant', want: 'to sign my own CEPS agreement online', soThat: 'I stay in control of my program enrollment' },
      { as: 'a self-representing participant', want: 'to submit invoices or receipts with service dates and supporting files', soThat: 'CEPS can enter and review my billing documents' },
      { as: 'a self-representing participant', want: 'to see the payments made to my vendors', soThat: 'I can verify my funding is used the way I planned' },
      { as: 'a self-representing participant', want: 'to sign in with a link provided by CEPS', soThat: 'access is simple and secure' },
    ],
    workflows: [
      messagesWorkflow('Open Messages in the left navigation or use Messages with CEPS on your participant record. Choose New message, enter a subject and message, and send it to CEPS staff and the coordinator shown. You can also reply to conversations you have been included in.'),
      {
        name: 'Joining the program',
        summary: 'Enroll and get access to your portal.',
        steps: [
          { title: 'Referral', description: 'Your Alta service coordinator refers you to CEPS.' },
          { title: 'Sign your agreement', description: 'Use the agreement link provided by CEPS to review and e-sign the participation agreement yourself.' },
          { title: 'Sign in', description: 'Use the password or sign-in link provided by CEPS to access your account.' },
        ],
      },
      {
        name: 'Submitting an invoice or receipt',
        summary: 'Send your documents to CEPS for billing entry and review.',
        steps: [
          { title: 'Start the submission', description: 'From Invoices, choose Submit Invoice. The submission is linked to your participant record; select a vendor if known.' },
          { title: 'Add the document details', description: 'Choose Invoice or Receipt and enter the service start and end dates.' },
          { title: 'Attach and submit files', description: 'Attach one or more files and submit them to CEPS. Each file becomes a separate submission; check each result and retry any failed files.' },
          { title: 'Leave billing entry to CEPS', description: 'Your submission starts as Awaiting CEPS Entry. CEPS enters the invoice lines and reviews them. You do not need to enter amounts or authorization lines.' },
        ],
      },
      {
        name: 'Keeping track of your services',
        summary: 'Monitor billing and payments for your services.',
        steps: [
          { title: 'Review invoices', description: 'Open Invoices to see each vendor\u2019s charges for your services.' },
          ...invoiceStatusSteps,
          { title: 'Review payments', description: 'Open your Payments tab to see each check line, service month, and remittance status; open Fees to see monthly fee authorizations and whether they are Paid.' },
          { title: 'Raise concerns', description: 'Contact CEPS staff if a charge doesn\u2019t look right.' },
        ],
      },
    ],
  },
  {
    role: 'vendor',
    visibleTo: ['staff', 'vendor'],
    label: 'Vendor',
    overview:
      'Vendors deliver services under purchase-of-service authorizations and use the portal to see their active authorizations, submit invoices, and track payments.',
    stories: [
      { as: 'a vendor', want: 'to see my active authorizations with remaining funding', soThat: 'I never deliver services beyond what is approved' },
      { as: 'a vendor', want: 'to submit invoices online against an authorization', soThat: 'I get paid faster with fewer back-and-forth corrections' },
      { as: 'a vendor', want: 'to see the status of my invoices and payment history', soThat: 'I know what has been approved or rejected and which checks have been issued' },
      { as: 'a vendor', want: 'to see my payment history and reports', soThat: 'my bookkeeping matches CEPS records' },
    ],
    workflows: [
      {
        name: 'Submitting an invoice',
        summary: 'Bill for services delivered under an authorization.',
        steps: [
          { title: 'Check the authorization', description: 'Open Authorizations and confirm the participant, service code, remaining funding, and date range.' },
          { title: 'Create the invoice', description: 'From Invoices, choose Submit Invoice, select the participant, confirm the vendor, choose the payment type and Invoice or Receipt document type, and attach the document. For each line, select an authorization and enter its service month and amount.' },
          { title: 'Submit for review', description: 'Submit the invoice \u2014 CEPS staff will review it against the authorization.' },
          { title: 'Fix rejections quickly', description: 'If an invoice is rejected, read the note, then submit a corrected invoice as a new submission (or contact CEPS).' },
        ],
      },
      {
        name: 'Tracking payments',
        summary: 'Reconcile what CEPS has paid you.',
        steps: [
          { title: 'Watch invoice status', description: 'Approved means CEPS approved the invoice for payment, not that a check has been issued. Open Payments to check issued payments.' },
          { title: 'Review payments', description: 'Open Payments to see check details, service months, and remittance status for your payments.' },
          { title: 'Run reports', description: 'Use Reports for a summary of payments over a period to match your own records.' },
        ],
      },
    ],
  },
];

export function getVisibleRoleDocs(role?: string): RoleDoc[] {
  return role ? roleDocs.filter((doc) => doc.visibleTo.includes(role)) : [];
}
