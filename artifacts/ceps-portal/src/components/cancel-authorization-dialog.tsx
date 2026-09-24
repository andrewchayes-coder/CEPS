import React, { useState } from 'react';
import { apiErrorMessage } from '@/lib/api-error';
import { useCancelAuthorization } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Ban } from 'lucide-react';

type Props = {
  id: string;
  onCanceled?: () => void;
  trigger?: React.ReactNode;
  variant?: 'ghost' | 'outline' | 'default' | 'destructive';
};

export function CancelAuthorizationDialog({ id, onCanceled, trigger, variant = 'ghost' }: Props) {
  const { toast } = useToast();
  const cancelAuthorization = useCancelAuthorization();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const handleCancel = () => {
    if (!reason.trim()) {
      toast({ variant: 'destructive', title: 'Error', description: 'Cancellation reason is required.' });
      return;
    }
    cancelAuthorization.mutate(
      { id, data: { reason: reason.trim() } },
      {
        onSuccess: () => {
          toast({ title: 'Authorization Canceled' });
          setOpen(false);
          setReason('');
          onCanceled?.();
        },
        onError: (error: unknown) => toast({ variant: 'destructive', title: 'Error', description: apiErrorMessage(error, 'Could not cancel authorization.') }),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ? (
          trigger
        ) : (
          <Button variant={variant} size="sm" data-testid="button-cancel-authorization">
            <Ban className="w-4 h-4 text-destructive" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel Authorization</DialogTitle>
          <DialogDescription>
            Are you sure you want to cancel this authorization? This action requires a reason.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Reason for Cancellation</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Provide a required reason for cancellation..."
              data-testid="input-cancel-reason"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={cancelAuthorization.isPending}>
            Back
          </Button>
          <Button
            variant="destructive"
            onClick={handleCancel}
            disabled={!reason.trim() || cancelAuthorization.isPending}
            data-testid="button-confirm-cancel"
          >
            {cancelAuthorization.isPending ? 'Canceling…' : 'Cancel Authorization'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
