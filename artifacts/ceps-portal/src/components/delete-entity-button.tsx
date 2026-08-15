import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { Trash2 } from 'lucide-react';

type Props = {
  // Called to perform the delete; must return a promise.
  onDelete: () => Promise<unknown>;
  entityLabel: string;
  testId: string;
  onDeleted?: () => void;
  disabled?: boolean;
  variant?: 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'default' | 'icon';
  buttonLabel?: string;
  // When true, the caller's onDelete is responsible for its own error toast.
  suppressErrorToast?: boolean;
};

// Staff-only delete control with an AlertDialog confirmation. The parent page is
// responsible for hiding this behind a role check.
export function DeleteEntityButton({
  onDelete,
  entityLabel,
  testId,
  onDeleted,
  disabled,
  variant = 'outline',
  size = 'sm',
  buttonLabel = 'Delete',
  suppressErrorToast = false,
}: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onDelete();
      toast({ title: `${entityLabel} deleted` });
      setOpen(false);
      onDeleted?.();
    } catch {
      if (!suppressErrorToast) {
        toast({ variant: 'destructive', title: 'Error', description: `Could not delete this ${entityLabel.toLowerCase()}.` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled} data-testid={testId} className={variant === 'outline' ? 'text-destructive hover:text-destructive' : undefined}>
          <Trash2 className="w-4 h-4 mr-2" /> {buttonLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entityLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will hide the record from all views. Continue?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            disabled={busy}
            data-testid="button-confirm-delete"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
