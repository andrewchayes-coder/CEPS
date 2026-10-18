import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListMessageRecipients, getListMessageRecipientsQueryKey, createMessageThread } from '@workspace/api-client-react';
import { useMessagingRole, invalidateMessaging, errText } from '@/hooks/use-messaging';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

export function MessageComposeDialog({ open, onOpenChange, clientId, clientName, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; clientId: string; clientName?: string; onCreated: (threadId: string) => void;
}) {
  const { user, isStaffLike, isFamily } = useMessagingRole();
  const isStaff = user?.role === 'staff';
  const qc = useQueryClient();
  const { data: rec, isLoading, isError, refetch } = useListMessageRecipients(clientId, {
    query: { enabled: open && !!clientId, queryKey: [...getListMessageRecipientsQueryKey(clientId), user?.id] },
  });
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [coord, setCoord] = useState(true);
  const [family, setFamily] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setSubject(''); setBody(''); setCoord(true); setFamily([]); setError(null); } }, [open, clientId]);

  const hasCoord = !!rec?.coordinator;
  const staffNeedsRecipient = isStaff && !((hasCoord && coord) || family.length > 0);
  const valid = subject.trim().length > 0 && subject.length <= 200 && body.trim().length > 0 && body.length <= 5000 && !!rec && !staffNeedsRecipient;

  const send = async () => {
    if (!valid || sending) return;
    setSending(true); setError(null);
    try {
      const data = isFamily
        ? { subject: subject.trim(), body: body.trim() }
        : user?.role === 'service_coordinator'
          ? { subject: subject.trim(), body: body.trim(), includeCoordinator: true, familyUserIds: family }
          : { subject: subject.trim(), body: body.trim(), includeCoordinator: hasCoord && coord, familyUserIds: family };
      const created = await createMessageThread(clientId, data);
      invalidateMessaging(qc);
      onOpenChange(false);
      onCreated(created.thread.id);
    } catch (e) {
      setError(errText(e));
    } finally { setSending(false); }
  };

  const toggleFamily = (id: string, on: boolean) => setFamily((f) => (on ? [...f, id] : f.filter((x) => x !== id)));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="compose-message-dialog">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>{clientName ? `About ${clientName}. ` : ''}Messages are permanent and cannot be edited or deleted.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2" data-testid="compose-recipients">
            <Label>To</Label>
            {isLoading ? <Skeleton className="h-10 w-full" /> : isError ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">Recipients could not be loaded.
                <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button></div>
            ) : rec && (
              <>
                {isFamily && <p className="text-sm" data-testid="text-compose-fixed-recipients">To: CEPS staff{rec.coordinator ? ` and ${rec.coordinator.name}` : ''}</p>}
                {user?.role === 'service_coordinator' && <p className="text-sm" data-testid="text-compose-fixed-recipients">CEPS staff and you</p>}
                {isStaff && (
                  <div className="flex items-center gap-2">
                    <Checkbox id="rcpt-coord" checked={hasCoord && coord} disabled={!hasCoord} onCheckedChange={(v) => setCoord(v === true)} data-testid="checkbox-recipient-coordinator" />
                    <Label htmlFor="rcpt-coord" className="font-normal">
                      {hasCoord ? `Service coordinator: ${rec.coordinator?.name}` : 'No coordinator assigned'}
                    </Label>
                  </div>
                )}
                {isStaffLike && rec.family.map((f) => (
                  <div key={f.userId} className="flex items-center gap-2">
                    <Checkbox id={`rcpt-${f.userId}`} checked={family.includes(f.userId)} onCheckedChange={(v) => toggleFamily(f.userId, v === true)} data-testid={`checkbox-recipient-family-${f.userId}`} />
                    <Label htmlFor={`rcpt-${f.userId}`} className="font-normal">{f.name} ({f.relationship || 'Self'})</Label>
                  </div>
                ))}
                {isStaff && staffNeedsRecipient && <p className="text-xs text-destructive" role="alert">Choose at least one recipient.</p>}
                {isStaff && rec.familyWithoutPortal.length > 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="text-compose-no-portal">
                    {rec.familyWithoutPortal.map((p) => p.name).join(', ')} {rec.familyWithoutPortal.length === 1 ? "doesn't" : "don't"} have portal access yet, so they can't receive messages here. Send them a portal invite from the Family Representatives section.
                  </p>
                )}
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="msg-subject">Subject</Label>
            <Input id="msg-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} disabled={sending} data-testid="input-message-subject" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="msg-body">Message</Label>
            <Textarea id="msg-body" rows={6} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} disabled={sending}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
              data-testid="input-message-body" />
            <p className="text-right text-xs text-muted-foreground">{body.length}/5000</p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive" data-testid="error-compose-message">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending} data-testid="button-compose-cancel">Cancel</Button>
          <Button type="button" onClick={() => void send()} disabled={!valid || sending} data-testid="button-compose-send">{sending ? 'Sending...' : 'Send'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
