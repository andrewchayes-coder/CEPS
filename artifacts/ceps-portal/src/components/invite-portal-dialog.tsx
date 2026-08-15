import React, { useState } from 'react';
import { useCreateInvite } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { UserPlus, Copy, Check } from 'lucide-react';

type Props = {
  linkedRecordType: 'vendor' | 'client';
  linkedRecordId: string;
  recordName: string;
};

export function InvitePortalDialog({ linkedRecordType, linkedRecordId, recordName }: Props) {
  const { toast } = useToast();
  const createInvite = useCreateInvite();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'parent_guardian' | 'self'>('parent_guardian');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const resolvedRole = linkedRecordType === 'vendor' ? 'vendor' : role;

  const reset = () => {
    setEmail('');
    setRole('parent_guardian');
    setInviteUrl(null);
    setCopied(false);
  };

  const handleSend = () => {
    createInvite.mutate(
      {
        data: {
          email: email.trim(),
          role: resolvedRole,
          linkedRecordType,
          linkedRecordId,
        },
      },
      {
        onSuccess: (data) => {
          setInviteUrl(data.inviteUrl);
          toast({ title: 'Invite created', description: 'Share the link below with the invitee.' });
        },
        onError: (err: any) => {
          toast({
            variant: 'destructive',
            title: 'Could not create invite',
            description: err?.data?.message || 'An account with that email may already exist.',
          });
        },
      },
    );
  };

  const handleCopy = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-invite-portal">
          <UserPlus className="w-4 h-4 mr-2" /> Invite to portal
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite to portal</DialogTitle>
          <DialogDescription>
            Send a portal invite for {recordName}. Email delivery isn't set up yet, so copy the
            generated link and share it directly.
          </DialogDescription>
        </DialogHeader>

        {!inviteUrl ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="input-invite-email"
              />
            </div>

            {linkedRecordType === 'client' && (
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as 'parent_guardian' | 'self')}>
                  <SelectTrigger data-testid="select-invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parent_guardian">Parent / Guardian</SelectItem>
                    <SelectItem value="self">Self</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button
              className="w-full"
              onClick={handleSend}
              disabled={createInvite.isPending || !email.trim()}
              data-testid="button-send-invite"
            >
              {createInvite.isPending ? 'Creating...' : 'Create Invite'}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Label>Invite link</Label>
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteUrl} data-testid="text-invite-url" className="text-xs" />
              <Button variant="outline" size="icon" onClick={handleCopy} data-testid="button-copy-invite-url">
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This link lets the invitee set a password and access the portal.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
