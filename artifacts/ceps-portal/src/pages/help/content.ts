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
  label: string;
  overview: string;
  stories: UserStory[];
  workflows: Workflow[];
}

export const roleDocs: RoleDoc[] = [
  {
    role: 'staff',
    label: 'CEPS Admin',
    overview:
      'CEPS staff administer the entire payee support program: intake of new referrals, client records, vendor management, purchase-of-service authorizations, invoice review, payment recording, Alta remittance reconciliation, and user administration.',
    stories: [
      { as: 'a CEPS staff member', want: 'to review incoming referrals from service coordinators', soThat: 'new clients can be onboarded into the program quickly and accurately' },
      { as: 'a CEPS staff member', want: 'to send agreements for e-signature to families and clients', soThat: 'program enrollment is documented without paper forms' },
      { as: 'a CEPS staff member', want: 'to create and track purchase-of-service authorizations', soThat: 'vendor services stay within approved units and date ranges' },
      { as: 'a CEPS staff member', want: 'to review vendor invoices against active authorizations', soThat: 'only valid, authorized services are approved for payment' },
      { as: 'a CEPS staff member', want: 'to record payments and reconcile Alta remittance reports', soThat: 'the check register matches funding received from the regional center' },
      { as: 'a CEPS staff member', want: 'to manage user accounts for all roles', soThat: 'coordinators, families, clients, and vendors can access their own portals securely' },
      { as: 'a CEPS staff member', want: 'to view program-wide reports', soThat: 'I can monitor spending, vendor activity, and client status at a glance' },
    ],
    workflows: [
      {
        name: 'Referral intake & client onboarding',
        summary: 'Turn a new referral from a service coordinator into an active client.',
        steps: [
          { title: 'Review the referral', description: 'Open Referrals, review client details, UCI number, and the coordinator\u2019s notes.' },
          { title: 'Convert to client', description: 'Accept the referral to create the client record, or follow up with the coordinator if information is missing.' },
          { title: 'Send the agreement', description: 'Send the CEPS participation agreement for e-signature to the parent/guardian or self-representing client.' },
          { title: 'Activate the client', description: 'Once the agreement is signed, the client becomes active and services can be authorized.' },
        ],
      },
      {
        name: 'Authorization management',
        summary: 'Create and maintain purchase-of-service authorizations tied to Alta POS documents.',
        steps: [
          { title: 'Create the authorization', description: 'From Authorizations, choose the client and vendor, then enter service code, units, rate, and date range. You can also upload the Alta POS PDF for AI-assisted drafting, then review before saving.' },
          { title: 'Resolve warnings', description: 'If the system flags overlaps or missing data, review the warnings and correct the draft before saving.' },
          { title: 'Monitor utilization', description: 'Track units used as invoices are approved; renew or amend the authorization before it expires.' },
        ],
      },
      {
        name: 'Invoice review & payment',
        summary: 'Approve vendor invoices and record payments with the CEPS fee.',
        steps: [
          { title: 'Review submitted invoices', description: 'Check each invoice line against the matching authorization: service dates, units, and rate.' },
          { title: 'Approve or reject', description: 'Approve valid invoices; reject with a note when something doesn\u2019t match so the vendor can correct it.' },
          { title: 'Record the payment', description: 'Record the check or EFT against the approved invoice. The CEPS administrative fee is tracked alongside the service payment.' },
        ],
      },
      {
        name: 'Remittance reconciliation',
        summary: 'Match Alta remittance reports against the CEPS check register.',
        steps: [
          { title: 'Import the remittance', description: 'From Remittances, add the Alta remittance report for the funding period.' },
          { title: 'Match line items', description: 'Match remittance lines to recorded payments; investigate any unmatched or partially funded lines.' },
          { title: 'Close the period', description: 'When all lines are matched or explained, mark the remittance reconciled.' },
        ],
      },
      {
        name: 'User administration',
        summary: 'Manage portal access for every role.',
        steps: [
          { title: 'Create the user', description: 'From Users, add the person with the correct role and link them to their client or vendor record where applicable.' },
          { title: 'Send a magic link', description: 'Send a sign-in link so they can access the portal without a password, or set an initial password.' },
          { title: 'Deactivate when needed', description: 'Deactivate accounts promptly when a family, client, or vendor leaves the program.' },
        ],
      },
    ],
  },
  {
    role: 'service_coordinator',
    label: 'Service Coordinator',
    overview:
      'Alta Regional Center service coordinators refer clients into the CEPS program and monitor the services and authorizations for the clients on their caseload.',
    stories: [
      { as: 'a service coordinator', want: 'to submit a referral for a client who needs payee support', soThat: 'the family can start receiving FMS services through CEPS' },
      { as: 'a service coordinator', want: 'to see the status of my referrals', soThat: 'I know when a client has been onboarded or if CEPS needs more information' },
      { as: 'a service coordinator', want: 'to view the clients on my caseload and their authorizations', soThat: 'I can verify services match the IPP and stay within approved funding' },
      { as: 'a service coordinator', want: 'to view reports for my caseload', soThat: 'I can prepare for planning meetings with accurate service data' },
    ],
    workflows: [
      {
        name: 'Submitting a referral',
        summary: 'Refer a client into the CEPS program.',
        steps: [
          { title: 'Start the referral', description: 'From Referrals, choose New Referral and enter the client\u2019s details, UCI number, and the services being requested.' },
          { title: 'Add context', description: 'Include notes about the family\u2019s situation and who will represent the client (parent/guardian or self).' },
          { title: 'Track progress', description: 'Watch the referral status \u2014 CEPS staff will accept it, request more information, or contact the family directly.' },
        ],
      },
      {
        name: 'Monitoring your caseload',
        summary: 'Keep an eye on clients, authorizations, and utilization.',
        steps: [
          { title: 'Review clients', description: 'Open Clients to see everyone on your caseload with their program status.' },
          { title: 'Check authorizations', description: 'Open a client to see active authorizations, units used, and expiration dates.' },
          { title: 'Flag issues early', description: 'If an authorization is close to exhausted or expiring, coordinate with CEPS staff before services lapse.' },
        ],
      },
    ],
  },
  {
    role: 'parent_guardian',
    label: 'Parent / Guardian',
    overview:
      'Parents and guardians represent their family member in the CEPS program. They sign agreements, choose vendors with their coordinator, and can see every invoice and payment made on their family member\u2019s behalf.',
    stories: [
      { as: 'a parent or guardian', want: 'to sign the CEPS agreement online', soThat: 'my family member can be enrolled without mailing paperwork' },
      { as: 'a parent or guardian', want: 'to see the invoices vendors submit for my family member', soThat: 'I know exactly what services are being billed' },
      { as: 'a parent or guardian', want: 'to see payments made to vendors', soThat: 'I can confirm program funds are being spent correctly' },
      { as: 'a parent or guardian', want: 'to sign in with a link sent to my email', soThat: 'I don\u2019t have to remember another password' },
    ],
    workflows: [
      {
        name: 'Enrolling your family member',
        summary: 'From referral to active services.',
        steps: [
          { title: 'Work with your coordinator', description: 'Your Alta service coordinator submits the referral to CEPS on your behalf.' },
          { title: 'Sign the agreement', description: 'You\u2019ll receive an email link to review and e-sign the CEPS participation agreement.' },
          { title: 'Get portal access', description: 'CEPS sends you a sign-in link. Use the Magic Link option on the login page any time.' },
        ],
      },
      {
        name: 'Reviewing invoices & payments',
        summary: 'Stay informed about services billed and paid.',
        steps: [
          { title: 'Check invoices', description: 'Open Invoices to see what each vendor has billed, including service dates and amounts.' },
          { title: 'Check payments', description: 'Open Payments to see what CEPS has paid each vendor from your family member\u2019s funding.' },
          { title: 'Ask questions', description: 'If something looks wrong, contact CEPS staff \u2014 invoices can be corrected before payment.' },
        ],
      },
    ],
  },
  {
    role: 'self',
    label: 'Self-Representing Client',
    overview:
      'Self-representing clients manage their own participation in the CEPS program: they sign their own agreement and can see every invoice and payment made with their funding.',
    stories: [
      { as: 'a self-representing client', want: 'to sign my own CEPS agreement online', soThat: 'I stay in control of my program enrollment' },
      { as: 'a self-representing client', want: 'to see the invoices my vendors submit', soThat: 'I know what services are billed under my name' },
      { as: 'a self-representing client', want: 'to see the payments made to my vendors', soThat: 'I can verify my funding is used the way I planned' },
      { as: 'a self-representing client', want: 'to sign in with an emailed link', soThat: 'access is simple and secure' },
    ],
    workflows: [
      {
        name: 'Joining the program',
        summary: 'Enroll and get access to your portal.',
        steps: [
          { title: 'Referral', description: 'Your Alta service coordinator refers you to CEPS.' },
          { title: 'Sign your agreement', description: 'You\u2019ll get an email link to review and e-sign the participation agreement yourself.' },
          { title: 'Sign in', description: 'Use the Magic Link option on the login page \u2014 a sign-in link is emailed to you.' },
        ],
      },
      {
        name: 'Keeping track of your services',
        summary: 'Monitor billing and payments for your services.',
        steps: [
          { title: 'Review invoices', description: 'Open Invoices to see each vendor\u2019s charges for your services.' },
          { title: 'Review payments', description: 'Open Payments to confirm what has been paid and when.' },
          { title: 'Raise concerns', description: 'Contact CEPS staff if a charge doesn\u2019t look right.' },
        ],
      },
    ],
  },
  {
    role: 'vendor',
    label: 'Vendor',
    overview:
      'Vendors deliver services under purchase-of-service authorizations and use the portal to see their active authorizations, submit invoices, and track payments.',
    stories: [
      { as: 'a vendor', want: 'to see my active authorizations with remaining units', soThat: 'I never deliver services beyond what is approved' },
      { as: 'a vendor', want: 'to submit invoices online against an authorization', soThat: 'I get paid faster with fewer back-and-forth corrections' },
      { as: 'a vendor', want: 'to see the status of my invoices', soThat: 'I know what has been approved, rejected, or paid' },
      { as: 'a vendor', want: 'to see my payment history and reports', soThat: 'my bookkeeping matches CEPS records' },
    ],
    workflows: [
      {
        name: 'Submitting an invoice',
        summary: 'Bill for services delivered under an authorization.',
        steps: [
          { title: 'Check the authorization', description: 'Open Authorizations and confirm the client, service code, remaining units, and date range.' },
          { title: 'Create the invoice', description: 'From Invoices, choose New Invoice, select the authorization, and enter service dates and units for each line.' },
          { title: 'Submit for review', description: 'Submit the invoice \u2014 CEPS staff will review it against the authorization.' },
          { title: 'Fix rejections quickly', description: 'If an invoice is rejected, read the note, correct the lines, and resubmit.' },
        ],
      },
      {
        name: 'Tracking payments',
        summary: 'Reconcile what CEPS has paid you.',
        steps: [
          { title: 'Watch invoice status', description: 'Approved invoices move to payment; the status updates on the Invoices page.' },
          { title: 'Review payments', description: 'Open Payments to see check/EFT details for each paid invoice.' },
          { title: 'Run reports', description: 'Use Reports for a summary of payments over a period to match your own records.' },
        ],
      },
    ],
  },
];
