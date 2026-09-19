import React, { useEffect, useState } from 'react';
import {
    useListUnmatchedPos,
    useGetUnmatchedPos,
    getGetUnmatchedPosQueryKey,
    useCompleteUnmatchedPos,
    useListClients,
    useListVendors,
    getListUnmatchedPosQueryKey,
    UnmatchedPosDocument,
    CompleteUnmatchedPosInputPaymentType
} from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertTriangle, ExternalLink, CheckCircle, Search, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SearchableSelect } from '@/components/searchable-select';
import { useDebounce } from '@/hooks/use-debounce';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/auth/auth-provider';
import { Redirect } from 'wouter';

type ApiErrorResponse = { data?: { error?: string; message?: string } };

export default function AuthorizationsUnmatchedPage() {
    const { user, isLoading: authLoading } = useAuth();
    const [queueSearch, setQueueSearch] = useState('');
    const debouncedQueueSearch = useDebounce(queueSearch, 400);

    const { data, isLoading: queueLoading, error } = useListUnmatchedPos(
        { search: debouncedQueueSearch },
        { query: { enabled: user?.role === 'staff', queryKey: getListUnmatchedPosQueryKey({ search: debouncedQueueSearch }) } },
    );
    const items = data?.items ?? [];
    const requestedId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('id') : null;
    const { data: requestedItem } = useGetUnmatchedPos(requestedId ?? '', { query: { enabled: !!requestedId, queryKey: getGetUnmatchedPosQueryKey(requestedId ?? '') } });
    const renderedItems = requestedItem && !items.some((item) => item.id === requestedItem.id)
        ? [requestedItem, ...items] : items;
    useEffect(() => {
        if (!requestedId || !renderedItems.some((item) => item.id === requestedId)) return;
        document.getElementById(`card-unmatched-${requestedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [requestedId, renderedItems]);

    if (authLoading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (!user || user.role !== 'staff') {
        return <Redirect to="/" />;
    }

    return (
        <div className="max-w-5xl mx-auto space-y-6 pb-20">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Unmatched POS Queue</h1>
                    <p className="text-muted-foreground mt-1">POS documents that could not be automatically matched to a participant.</p>
                </div>
                <div className="relative w-full md:w-72">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        aria-label="Search unmatched POS queue"
                        placeholder="Search by name, auth #, or UCI..."
                        className="pl-8"
                        value={queueSearch}
                        onChange={(e) => setQueueSearch(e.target.value)}
                        data-testid="input-queue-search"
                    />
                </div>
            </div>

            {error ? (
                <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Error loading queue</AlertTitle>
                    <AlertDescription>{(error as ApiErrorResponse)?.data?.error || (error as ApiErrorResponse)?.data?.message || 'Could not fetch unmatched POS documents.'}</AlertDescription>
                </Alert>
            ) : queueLoading ? (
                <div className="flex h-64 flex-col items-center justify-center space-y-4">
                    <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                    <p className="text-muted-foreground animate-pulse">Loading queue...</p>
                </div>
             ) : renderedItems.length === 0 ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <CheckCircle className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                        <h3 className="text-lg font-medium">All caught up</h3>
                        <p className="text-muted-foreground">
                            {debouncedQueueSearch ? 'No matches found for your search.' : 'No unmatched POS documents in the queue.'}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-4">
                    <div className="text-sm text-muted-foreground">
                         Showing {renderedItems.length} of {data?.total ?? renderedItems.length} {data?.total === 1 ? 'item' : 'items'}
                    </div>
                    <div className="grid gap-6">
                         {renderedItems.map(item => (
                            <UnmatchedPosCard key={item.id} item={item} highlighted={item.id === requestedId} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function UnmatchedPosCard({ item, highlighted = false }: { item: UnmatchedPosDocument; highlighted?: boolean }) {
    const [clientId, setClientId] = useState<string>(item.suggestedClientId ?? '');
    const [vendorId, setVendorId] = useState<string>('');
    const [paymentType, setPaymentType] = useState<CompleteUnmatchedPosInputPaymentType>(
        item.serviceCode === '459' ? 'direct_payment' :
        item.serviceCode === '024' ? 'reimbursement' :
        item.serviceCode === '490' ? 'fee' : 'direct_payment'
    );

    const [clientSearch, setClientSearch] = useState('');
    const debouncedClientSearch = useDebounce(clientSearch, 300);
    const { data: clientsData, isLoading: clientsLoading } = useListClients({ search: debouncedClientSearch, limit: 50 });
    const clients = clientsData?.items ?? [];
    const clientOptions = item.suggestedClientId && !clients.some((client) => client.id === item.suggestedClientId)
        ? [...clients, { id: item.suggestedClientId, firstName: item.suggestedClientName?.split(' ')[0] ?? 'Suggested', lastName: item.suggestedClientName?.split(' ').slice(1).join(' ') ?? 'Participant', uciNumber: '' }]
        : clients;

    const [vendorSearch, setVendorSearch] = useState('');
    const debouncedVendorSearch = useDebounce(vendorSearch, 300);
    const { data: vendorsData, isLoading: vendorsLoading } = useListVendors({ search: debouncedVendorSearch, limit: 50 });
    const vendors = vendorsData?.items ?? [];

    const completeMatch = useCompleteUnmatchedPos();
    const { toast } = useToast();
    const queryClient = useQueryClient();

    const [warnings, setWarnings] = useState<string[]>([]);

    const handleComplete = (force: boolean = false) => {
        if (!clientId) {
            toast({ variant: 'destructive', title: 'Error', description: 'Participant is required.' });
            return;
        }
        completeMatch.mutate({
            id: item.id,
            data: {
                clientId,
                vendorId: vendorId && vendorId !== 'none' ? vendorId : undefined,
                paymentType,
                acceptMaxAmountWarning: force
            }
        }, {
            onSuccess: (res) => {
                if (!res.saved && res.warnings && res.warnings.length > 0) {
                    setWarnings(res.warnings);
                    toast({
                        variant: 'destructive',
                        title: 'Data Quality Warning',
                        description: 'Please review warnings before forcing match.',
                    });
                } else {
                    toast({ title: 'Match Completed', description: 'Authorization created successfully.' });
                    queryClient.invalidateQueries({ queryKey: getListUnmatchedPosQueryKey() });
                }
            },
            onError: (err: unknown) => {
                const apiErr = err as ApiErrorResponse;
                toast({
                    variant: 'destructive',
                    title: 'Error',
                    description: apiErr?.data?.error || apiErr?.data?.message || 'Failed to complete match.'
                });
            }
        });
    };

    return (
        <Card data-testid={`card-unmatched-${item.id}`} data-highlighted={highlighted ? 'true' : 'false'} className={highlighted ? 'ring-2 ring-primary' : undefined}>
            <CardHeader className="flex flex-row items-start justify-between bg-muted/30 pb-4">
                <div>
                    <CardTitle className="text-lg">Unmatched POS: {item.authNumber || 'No Auth #'}</CardTitle>
                    <CardDescription>Uploaded from {item.sourceFileName}</CardDescription>
                </div>
                <Button variant="outline" size="sm" asChild>
                    <a href={`/api/storage${item.posPdfUrl}`} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-4 h-4 mr-2" /> View PDF
                    </a>
                </Button>
            </CardHeader>
            <CardContent className="pt-6">
                {item.suggestedClientId && (
                    <Alert className="mb-6 border-primary/30 bg-primary/5">
                        <AlertTitle>Suggested match — confirm before completing</AlertTitle>
                        <AlertDescription>
                            {item.suggestedClientName ? `${item.suggestedClientName} was suggested by ${item.suggestionMethod === 'uci' ? 'UCI' : 'name'} match.` : 'A participant was suggested for this document.'}
                        </AlertDescription>
                    </Alert>
                )}
                {warnings.length > 0 && (
                    <Alert variant="destructive" className="mb-6 bg-destructive/10 border-destructive/20 text-destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle>Data Quality Warning</AlertTitle>
                        <AlertDescription className="space-y-2">
                            <ul className="list-disc pl-4 mt-2">
                                {warnings.map((w, i) => <li key={i}>{w}</li>)}
                            </ul>
                            <div className="flex gap-2 pt-2">
                                <Button size="sm" variant="outline" className="border-destructive/30 hover:bg-destructive/20" onClick={() => handleComplete(true)} data-testid={`button-force-save-${item.id}`}>
                                    Force Save Anyway
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setWarnings([])}>Cancel</Button>
                            </div>
                        </AlertDescription>
                    </Alert>
                )}

                <div className="grid md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                        <h4 className="text-sm font-medium border-b pb-2">Parsed Document Fields</h4>
                        <dl className="grid grid-cols-[120px_1fr] gap-x-2 gap-y-3 text-sm">
                            <dt className="text-muted-foreground">Participant Name:</dt>
                            <dd className="font-medium" data-testid={`text-parsed-name-${item.id}`}>{item.clientName || '—'}</dd>

                            <dt className="text-muted-foreground">UCI Number:</dt>
                            <dd className="font-medium" data-testid={`text-parsed-uci-${item.id}`}>{item.uciNumber || '—'}</dd>

                            <dt className="text-muted-foreground">Service Code:</dt>
                            <dd>{item.serviceCode || '—'}</dd>

                            <dt className="text-muted-foreground">Period:</dt>
                            <dd>{item.servicePeriodStart} to {item.servicePeriodEnd}</dd>

                            <dt className="text-muted-foreground">Max Amount:</dt>
                            <dd>{item.maxPeriodAmount ? `$${item.maxPeriodAmount}` : '—'}</dd>

                            <dt className="text-muted-foreground">Caseworker:</dt>
                            <dd>{item.caseworkerName || '—'}</dd>
                        </dl>
                    </div>

                    <div className="space-y-4 bg-secondary/20 p-4 rounded-lg border">
                        <h4 className="text-sm font-medium">Match to System Records</h4>

                        <div className="space-y-3">
                            <div>
                                <label className="text-xs font-medium mb-1 block" htmlFor={`client-select-${item.id}`}>Participant *</label>
                                <SearchableSelect
                                    id={`client-select-${item.id}`} value={clientId}
                                    onValueChange={setClientId}
                                    options={clientOptions.map(c => ({ value: c.id, label: `${c.firstName} ${c.lastName}${c.uciNumber ? ` (${c.uciNumber})` : ''}` }))}
                                    onSearchChange={setClientSearch}
                                    loading={clientsLoading}
                                    placeholder="Search participant..."
                                    data-testid={`select-client-${item.id}`}
                                />
                            </div>

                            <div>
                                <label className="text-xs font-medium mb-1 block" htmlFor={`vendor-select-${item.id}`}>Vendor (Optional)</label>
                                <SearchableSelect
                                    id={`vendor-select-${item.id}`} value={vendorId}
                                    onValueChange={setVendorId}
                                    options={vendors.map(v => ({ value: v.id, label: v.name }))}
                                    onSearchChange={setVendorSearch}
                                    loading={vendorsLoading}
                                    placeholder="Select vendor..."
                                    allowClear
                                    data-testid={`select-vendor-${item.id}`}
                                />
                            </div>

                            <div>
                                <label className="text-xs font-medium mb-1 block" htmlFor={`payment-type-select-${item.id}`}>Payment Type *</label>
                                <Select value={paymentType || ''} onValueChange={(val) => setPaymentType(val as CompleteUnmatchedPosInputPaymentType)}>
                                    <SelectTrigger id={`payment-type-select-${item.id}`} data-testid={`select-payment-type-${item.id}`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="direct_payment">Direct Pay (459)</SelectItem>
                                        <SelectItem value="reimbursement">Reimbursement (024)</SelectItem>
                                        <SelectItem value="fee">FMS Fee (490)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <Button
                            className="w-full mt-4"
                            onClick={() => handleComplete(false)}
                            disabled={completeMatch.isPending}
                            data-testid={`button-complete-${item.id}`}
                        >
                            {completeMatch.isPending ? 'Completing Match...' : 'Complete Match & Create Auth'}
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
