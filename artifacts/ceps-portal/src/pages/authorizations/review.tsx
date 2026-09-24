import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useGetUnmatchedPos, getGetUnmatchedPosQueryKey, useListUnmatchedPos, getListUnmatchedPosQueryKey, useListClients, useListVendors, getListVendorsQueryKey, useGetAuthorization, getGetAuthorizationQueryKey } from '@workspace/api-client-react';
import { Link, Redirect } from 'wouter';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, RefreshCw } from 'lucide-react';
import { useAuth } from '@/components/auth/auth-provider';
import { useDebounce } from '@/hooks/use-debounce';
import { useToast } from '@/hooks/use-toast';
import { DocumentPreview } from '@/components/document-preview';
import { SearchableSelect } from '@/components/searchable-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { posReviewApi, type ReviewAction, type ReviewItem } from '@/lib/pos-review-api';

type Fields = NonNullable<ReviewAction['fields']>;
function initialFields(item: ReviewItem): Fields {
  return {
    authNumber: item.authNumber ?? '',
    serviceCode: item.serviceCode ?? '',
    activityDescription: item.activityDescription ?? '',
    servicePeriodStart: item.servicePeriodStart?.slice(0, 10) ?? '',
    servicePeriodEnd: item.servicePeriodEnd?.slice(0, 10) ?? '',
    unitAmount: '',
    monthlyAmount: item.monthlyAmount ?? '',
    maxPeriodAmount: item.maxPeriodAmount ?? '',
    units: item.units ?? null,
    notes: item.posNotes ?? '',
  };
}
const fieldLabels: { key: 'authNumber' | 'servicePeriodStart' | 'servicePeriodEnd' | 'unitAmount' | 'monthlyAmount' | 'maxPeriodAmount'; label: string; type?: string }[] = [
  { key: 'authNumber', label: 'Authorization #', type: 'text' },
  { key: 'servicePeriodStart', label: 'Service start', type: 'date' },
  { key: 'servicePeriodEnd', label: 'Service end', type: 'date' },
  { key: 'unitAmount', label: 'Unit amount', type: 'number' },
  { key: 'monthlyAmount', label: 'Monthly amount', type: 'number' },
  { key: 'maxPeriodAmount', label: 'Max period amount', type: 'number' },
];

export default function AuthorizationReviewPage() {
  const { user, isLoading: authLoading } = useAuth();
  const params = new URLSearchParams(window.location.search);
  const batchId = params.get('batchId') || '';
  const requestedId = params.get('id') || '';
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(requestedId || null);
  const queueParams = { limit: 1000, ...(batchId ? { batchId } : {}) };
  const queue = useListUnmatchedPos(queueParams, {
    query: {
      enabled: user?.role === 'staff', queryKey: getListUnmatchedPosQueryKey(queueParams),
      refetchInterval: query => query.state.data?.items.some(item => item.parseStatus === 'queued') ? 2000 : false,
    },
  });
  const direct = useGetUnmatchedPos(requestedId, {
    query: { enabled: !!requestedId && user?.role === 'staff', queryKey: getGetUnmatchedPosQueryKey(requestedId) },
  });
  const sorted = useMemo(() => {
    const items = (queue.data?.items ?? []) as ReviewItem[];
    return [...items].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  }, [queue.data?.items]);
  const active = sorted.filter(item => !skipped.includes(item.id));
  const selected = active.find(item => item.id === currentId) ?? (requestedId === currentId && direct.data && !batchId ? direct.data as ReviewItem : undefined) ?? active[Math.min(index, active.length - 1)];
  const effectiveIndex = selected ? Math.max(0, sorted.findIndex(item => item.id === selected.id)) : 0;
  const next = () => { setCurrentId(null); setIndex(0); };
  const skip = () => {
    if (!selected) return;
    setSkipped(previous => [...previous, selected.id]);
    setCurrentId(null);
    setIndex(0);
  };
  if (authLoading) return <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-96 w-full" /></div>;
  if (!user || user.role !== 'staff') return <Redirect to="/" />;
  return <div className="space-y-5 pb-16">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <Link href="/authorizations" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary mb-2"><ArrowLeft className="h-4 w-4 mr-1" />Authorizations</Link>
        <h1 className="text-3xl font-bold tracking-tight">POS review queue</h1>
        <p className="text-muted-foreground mt-1">Check the PDF, complete the fields, then confirm or move on.</p>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground" data-testid="text-review-progress">{selected ? `${effectiveIndex + 1} of ${queue.data?.total ?? sorted.length}` : '0 pending'}</span>
        <Button variant="outline" size="sm" onClick={() => { queue.refetch(); setSkipped([]); }} data-testid="button-refresh-review"><RefreshCw className="h-4 w-4 mr-2" />Refresh</Button>
      </div>
    </header>
    {batchId && <div className="flex items-center justify-between rounded-md bg-secondary/40 px-4 py-2 text-sm"><span>Viewing batch {batchId.slice(0, 8)}</span><Link href="/authorizations/review" className="text-primary hover:underline">Show all pending</Link></div>}
    {queue.isError ? <Card><CardContent className="py-10 text-center"><AlertTriangle className="mx-auto mb-3 text-destructive" /><p>Could not load the queue.</p><Button className="mt-4" onClick={() => queue.refetch()}>Retry</Button></CardContent></Card>
      : queue.isLoading ? <div className="grid gap-5 lg:grid-cols-2"><Skeleton className="h-[600px]" /><Skeleton className="h-[600px]" /></div>
      : selected ? <ReviewEditor key={selected.id} item={selected} onSkip={skip} onDone={() => { setSkipped(previous => [...previous, selected.id]); next(); queue.refetch(); }} />
      : <Card><CardContent className="py-14 text-center"><CheckCircle2 className="mx-auto mb-3 h-9 w-9 text-primary" /><h2 className="text-lg font-semibold">Queue clear</h2><p className="text-muted-foreground">There are no more pending POS documents in this view.</p><Button variant="outline" className="mt-5" asChild><Link href="/authorizations">Back to authorizations</Link></Button></CardContent></Card>}
  </div>;
}

function ReviewEditor({ item, onSkip, onDone }: { item: ReviewItem; onSkip: () => void; onDone: () => void }) {
  const [fields, setFields] = useState<Fields>(() => initialFields(item));
  const previousParseStatus = useRef(item.parseStatus);
  const [clientId, setClientId] = useState(item.suggestedClientId ?? '');
  const [vendorId, setVendorId] = useState('');
  const [showAllVendors, setShowAllVendors] = useState(false);
  const [clientSearch, setClientSearch] = useState('');
  const [vendorSearch, setVendorSearch] = useState('');
  const [paymentType, setPaymentType] = useState<NonNullable<ReviewAction['paymentType']>>(item.serviceCode === '024' ? 'reimbursement' : item.serviceCode === '490' ? 'fee' : 'direct_payment');
  const [discarding, setDiscarding] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [discardReason, setDiscardReason] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string[]>([]);
  const [error, setError] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: clientsData, isLoading: clientsLoading } = useListClients({ search: useDebounce(clientSearch, 300), limit: 50 });
  const clients = clientsData?.items ?? [];
  const vendorParams = { ...(clientId && !showAllVendors ? { clientId } : {}), search: useDebounce(vendorSearch, 300), limit: 50 };
  const { data: vendorData, isLoading: vendorsLoading } = useListVendors(vendorParams, {
    query: { enabled: !!clientId, queryKey: getListVendorsQueryKey(vendorParams) },
  });
  const vendors = vendorData?.items ?? [];
  const { data: suggestedAuth } = useGetAuthorization(item.suggestedAuthorizationId ?? '', {
    query: { enabled: !!item.suggestedAuthorizationId, queryKey: getGetAuthorizationQueryKey(item.suggestedAuthorizationId ?? '') },
  });
  useEffect(() => {
    if (previousParseStatus.current === 'queued' && item.parseStatus !== 'queued') {
      setFields(initialFields(item));
      setClientId(item.suggestedClientId ?? '');
      setPaymentType(item.serviceCode === '024' ? 'reimbursement' : item.serviceCode === '490' ? 'fee' : 'direct_payment');
    }
    previousParseStatus.current = item.parseStatus;
  }, [item]);
  useEffect(() => {
    if (vendorData && vendors.length === 1 && !vendorId && !showAllVendors && !vendorSearch) setVendorId(vendors[0].id);
  }, [vendorData, vendors, vendorId, showAllVendors, vendorSearch]);
  const hasSuggestedAuth = !!item.suggestedAuthorizationId;
  const parsing = item.parseStatus === 'queued';
  const amendmentReady = !hasSuggestedAuth || !!suggestedAuth;
  const amendmentOnly = 'Amendments can change dates, amounts, notes, and the PDF only. Change other details on the authorization record.';
  const changed = (key: keyof Fields) => {
    const original = suggestedAuth;
    if (!original || !['servicePeriodStart', 'servicePeriodEnd', 'unitAmount', 'monthlyAmount', 'maxPeriodAmount', 'notes'].includes(key)) return false;
    const originalValue = key === 'notes' ? original.posNotes : key === 'unitAmount' ? null : original[key];
    return originalValue != null && String(originalValue).slice(0, key.toLowerCase().includes('period') ? 10 : undefined) !== (fields[key] ?? '');
  };

  async function submit(action: ReviewAction['action'], acceptMaxAmountWarning = false) {
    setError('');
    if (parsing || busy || !amendmentReady) return;
    if (action === 'discard' && !discardReason.trim()) { setError('Enter a reason before discarding.'); return; }
    if (action === 'cancel' && !cancellationReason.trim()) { setError('Enter a reason for cancellation.'); return; }
    if (action === 'cancel' && !hasSuggestedAuth) return;
    if (action === 'confirm' || action === 'amend') {
      if (!(action === 'amend' ? suggestedAuth?.clientId : clientId)) { setError('Select a participant before confirming.'); return; }
      if (action === 'confirm' && (!fields.authNumber?.trim() || !['459', '024', '490'].includes(fields.serviceCode ?? ''))) {
        setError('Enter an authorization number and choose a service code.'); return;
      }
      if (!fields.servicePeriodStart || !fields.servicePeriodEnd || fields.servicePeriodEnd < fields.servicePeriodStart) {
        setError('Enter valid service dates with the end on or after the start.'); return;
      }
      const amount = (fields.maxPeriodAmount ?? '').trim();
      if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
        setError('Enter a max period amount greater than zero (up to two decimal places).'); return;
      }
      for (const [label, value] of [['Unit amount', fields.unitAmount], ['Monthly amount', fields.monthlyAmount]] as const) {
        if (value != null && value.trim() && (!/^\d+(\.\d{1,2})?$/.test(value.trim()) || Number(value) < 0)) {
          setError(`${label} must be a valid non-negative amount (up to two decimal places).`); return;
        }
      }
      if (action === 'confirm' && fields.units != null && (!Number.isInteger(fields.units) || fields.units < 0)) {
        setError('Units must be a non-negative whole number.'); return;
      }
    }
    setBusy(true);
    try {
      const amountFields = {
        servicePeriodStart: fields.servicePeriodStart,
        servicePeriodEnd: fields.servicePeriodEnd,
        unitAmount: fields.unitAmount?.trim() || null,
        monthlyAmount: fields.monthlyAmount?.trim() || null,
        maxPeriodAmount: fields.maxPeriodAmount?.trim(),
        notes: fields.notes?.trim() || null,
      };
      const response = await posReviewApi.review(item.id, {
        action,
        ...(action === 'confirm' ? { clientId, vendorId: vendorId || null, paymentType } : {}),
        ...(action === 'confirm' || action === 'amend' ? {
          fields: action === 'amend' ? amountFields : {
            ...amountFields,
            authNumber: fields.authNumber?.trim(),
            serviceCode: fields.serviceCode,
            activityDescription: fields.activityDescription?.trim() || null,
            units: fields.units,
          },
        } : {}),
        reason: action === 'discard' ? discardReason.trim() : action === 'cancel' ? cancellationReason.trim() : undefined,
        acceptMaxAmountWarning,
      });
      if (response.saved === false && response.warnings?.length) { setWarning(response.warnings); return; }
      queryClient.invalidateQueries({ queryKey: getListUnmatchedPosQueryKey() });
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard'] });
      toast({ title: action === 'discard' ? 'POS discarded' : action === 'cancel' ? 'Authorization canceled' : action === 'amend' ? 'Authorization amended' : 'Authorization confirmed' });
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Review failed. Please try again.'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy && !discarding && !canceling && !parsing && amendmentReady) {
        event.preventDefault();
        void submit(hasSuggestedAuth ? 'amend' : 'confirm');
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  const setField = (key: keyof Fields, value: string) => { setWarning([]); setError(''); setFields(previous => ({ ...previous, [key]: value })); };
  return <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)] items-start">
    <div className="lg:sticky lg:top-5">
      <DocumentPreview objectPath={item.posPdfUrl} filename={item.sourceFileName} className="min-h-[550px] lg:h-[calc(100dvh-10rem)]" />
    </div>
    <Card><CardContent className="p-5 md:p-7 space-y-5">
      <div className="border-b pb-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Source document</p>
        <h2 className="text-xl font-semibold truncate">{item.sourceFileName}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Parsed participant: {item.clientName || 'Not found'} {item.uciNumber ? `· UCI ${item.uciNumber}` : ''}</p>
        {parsing && <p role="status" className="mt-2 rounded-md bg-secondary p-3 text-sm" data-testid="status-pos-parsing">Parsing PDF now. You can skip this item while it finishes; review actions will become available automatically.</p>}
        {item.parseStatus === 'failed' && <p role="alert" className="mt-2 text-sm text-destructive">PDF extraction failed: {item.parseError || 'Enter the details from the PDF manually.'}</p>}
        {item.suggestedClientId && <p className="mt-2 text-sm text-primary">Suggested participant: {item.suggestedClientName || 'Matched by UCI or name'} · verify before saving</p>}
        {hasSuggestedAuth && <p className="mt-2 rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-primary" data-testid="text-amendment-suggestion">Amends #{suggestedAuth?.authNumber || fields.authNumber} · changed fields are highlighted below</p>}
        {hasSuggestedAuth && <p className="mt-2 text-xs text-muted-foreground" data-testid="text-amendment-limits">{amendmentOnly}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="review-client">Participant *</Label>
        <SearchableSelect id="review-client" value={hasSuggestedAuth ? suggestedAuth?.clientId ?? clientId : clientId} onValueChange={value => { setClientId(value); setVendorId(''); setShowAllVendors(false); }}
          options={[...clients.map(client => ({ value: client.id, label: `${client.firstName} ${client.lastName}${client.uciNumber ? ` (${client.uciNumber})` : ''}` })), ...(item.suggestedClientId && !clients.some(client => client.id === item.suggestedClientId) ? [{ value: item.suggestedClientId, label: item.suggestedClientName || item.clientName || 'Suggested participant' }] : [])]}
          onSearchChange={setClientSearch} loading={clientsLoading} disabled={hasSuggestedAuth} placeholder="Search participants…" data-testid="select-review-client" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><Label htmlFor="review-vendor">Vendor</Label>
          <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={showAllVendors} disabled={hasSuggestedAuth} onChange={event => { setShowAllVendors(event.target.checked); setVendorId(''); }} data-testid="checkbox-show-all-vendors" />Show all vendors</label>
        </div>
        <SearchableSelect id="review-vendor" value={vendorId} onValueChange={setVendorId} onSearchChange={setVendorSearch}
          options={vendors.map(vendor => ({ value: vendor.id, label: vendor.name }))} loading={vendorsLoading}
          disabled={!clientId || hasSuggestedAuth} placeholder={clientId ? 'Search vendors…' : 'Choose a participant first'} allowClear data-testid="select-review-vendor" />
        <p className="text-xs text-muted-foreground">{showAllVendors ? 'Searching all vendors' : 'Showing vendors linked to this participant, including referrals'}</p>
      </div>
      <div className="space-y-2"><Label htmlFor="review-payment">Payment type</Label>
        <Select value={hasSuggestedAuth ? suggestedAuth?.paymentType ?? paymentType : paymentType} disabled={hasSuggestedAuth} onValueChange={value => setPaymentType(value as NonNullable<ReviewAction['paymentType']>)}>
          <SelectTrigger id="review-payment" data-testid="select-review-payment"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="direct_payment">Direct payment</SelectItem><SelectItem value="reimbursement">Reimbursement</SelectItem><SelectItem value="fee">FMS fee</SelectItem></SelectContent>
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="review-service-code">Service code *</Label>
          <Select value={hasSuggestedAuth ? suggestedAuth?.serviceCode ?? fields.serviceCode ?? '' : fields.serviceCode ?? ''} disabled={hasSuggestedAuth} onValueChange={value => { setField('serviceCode', value); setPaymentType(value === '024' ? 'reimbursement' : value === '490' ? 'fee' : 'direct_payment'); }}>
            <SelectTrigger id="review-service-code" data-testid="select-review-serviceCode"><SelectValue placeholder="Choose service code" /></SelectTrigger>
            <SelectContent><SelectItem value="459">459 · Direct pay</SelectItem><SelectItem value="024">024 · Reimbursement</SelectItem><SelectItem value="490">490 · FMS fee</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="space-y-2"><Label htmlFor="review-units">Units</Label>
          <Input id="review-units" data-testid="input-review-units" type="number" min="0" step="1" disabled={hasSuggestedAuth}
            value={fields.units ?? ''} onChange={event => setFields(previous => ({ ...previous, units: event.target.value === '' ? null : Number(event.target.value) }))} />
        </div>
      </div>
      <div className="space-y-2"><Label htmlFor="review-activity">Activity description</Label>
        <Textarea id="review-activity" data-testid="input-review-activity" disabled={hasSuggestedAuth}
          value={fields.activityDescription ?? ''} onChange={event => setField('activityDescription', event.target.value)} rows={2} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {fieldLabels.map(({ key, label, type }) => <div key={key} className={`space-y-2 ${changed(key) ? 'rounded-md bg-primary/10 p-2 ring-1 ring-primary/30' : ''}`}>
          <Label htmlFor={`review-${key}`}>{label}{['authNumber', 'servicePeriodStart', 'servicePeriodEnd', 'maxPeriodAmount'].includes(key) && ' *'}{changed(key) && <span className="ml-1 text-xs text-primary">(changed)</span>}</Label>
          <Input id={`review-${key}`} data-testid={`input-review-${key}`} type={type} step={type === 'number' ? '0.01' : undefined}
            disabled={hasSuggestedAuth && key === 'authNumber'} title={hasSuggestedAuth && key === 'authNumber' ? amendmentOnly : undefined}
            value={hasSuggestedAuth && key === 'authNumber' ? suggestedAuth?.authNumber ?? fields.authNumber ?? '' : fields[key] ?? ''} onChange={event => setField(key, event.target.value)} />
        </div>)}
      </div>
      <div className="space-y-2"><Label htmlFor="review-notes">POS notes</Label>
        <Textarea id="review-notes" value={fields.notes ?? ''} onChange={event => setField('notes', event.target.value)} data-testid="input-review-notes" rows={3} />
      </div>
      {warning.length > 0 && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><p className="font-medium">Review amount warning</p><ul className="list-disc pl-5">{warning.map(text => <li key={text}>{text}</li>)}</ul><Button variant="outline" size="sm" className="mt-2" onClick={() => submit(hasSuggestedAuth ? 'amend' : 'confirm', true)} disabled={busy || parsing}>Accept warning & confirm</Button></div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2 border-t pt-5">
        <Button onClick={() => submit(hasSuggestedAuth ? 'amend' : 'confirm')} disabled={busy || parsing || !amendmentReady} data-testid="button-confirm-next">Confirm & Next <ArrowRight className="ml-2 h-4 w-4" /></Button>
        {hasSuggestedAuth && <Button variant="outline" onClick={() => { setCanceling(!canceling); setDiscarding(false); }} disabled={busy || parsing || !amendmentReady} data-testid="button-mark-cancellation">Mark as Cancellation</Button>}
        <Button variant="outline" onClick={onSkip} disabled={busy} data-testid="button-skip-pos">Skip</Button>
        <Button variant="ghost" className="text-destructive" onClick={() => { setDiscarding(!discarding); setCanceling(false); }} disabled={busy || parsing} data-testid="button-discard-pos">Discard</Button>
      </div>
      {canceling && <div className="space-y-2 rounded-md border border-primary/30 p-3">
        <Label htmlFor="cancellation-reason">Reason for cancellation *</Label>
        <Textarea id="cancellation-reason" value={cancellationReason} onChange={event => setCancellationReason(event.target.value)} placeholder="Why is this authorization being canceled?" data-testid="input-cancellation-reason" />
        <Button variant="destructive" onClick={() => submit('cancel')} disabled={busy || !cancellationReason.trim()} data-testid="button-confirm-cancellation">Confirm cancellation</Button>
      </div>}
      {discarding && <div className="space-y-2 rounded-md border border-destructive/30 p-3">
        <Label htmlFor="discard-reason">Reason for discarding *</Label>
        <Textarea id="discard-reason" value={discardReason} onChange={event => setDiscardReason(event.target.value)} placeholder="Why should this POS not become an authorization?" data-testid="input-discard-reason" />
        <Button variant="destructive" onClick={() => submit('discard')} disabled={busy || !discardReason.trim()} data-testid="button-confirm-discard">Discard POS</Button>
      </div>}
      <p className="text-xs text-muted-foreground">Shortcut: Ctrl/Cmd + Enter to confirm and continue.</p>
    </CardContent></Card>
  </div>;
}