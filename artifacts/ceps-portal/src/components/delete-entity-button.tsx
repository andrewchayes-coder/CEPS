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
import { Link } from 'wouter';

type DeleteBlocker = {
  type: string;
  label: string;
  count: number;
  records: Array<{ id: string; label: string; href: string }>;
};

type DeleteConflict = {
  error: string;
  blockers: DeleteBlocker[];
};

function getDeleteConflict(error: unknown): DeleteConflict | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: number; data?: unknown };
  if (candidate.status !== 409 || !candidate.data || typeof candidate.data !== 'object') return null;
  const data = candidate.data as Partial<DeleteConflict>;
  return typeof data.error === 'string' && Array.isArray(data.blockers)
    ? { error: data.error, blockers: data.blockers }
    : null;
}

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
  const [conflict, setConflict] = useState<DeleteConflict | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setConflict(null);
    try {
      await onDelete();
      toast({ title: `${entityLabel} deleted` });
      setOpen(false);
      onDeleted?.();
    } catch (error) {
      const deleteConflict = getDeleteConflict(error);
      if (deleteConflict) {
        setConflict(deleteConflict);
        return;
      }
      if (!suppressErrorToast) {
        toast({ variant: 'destructive', title: 'Error', description: `Could not delete this ${entityLabel.toLowerCase()}.` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setConflict(null);
    }}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled} data-testid={testId} className={variant === 'outline' ? 'text-destructive hover:text-destructive' : undefined}>
          <Trash2 className="w-4 h-4 mr-2" /> {buttonLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{conflict ? `Cannot delete ${entityLabel.toLowerCase()}` : `Delete ${entityLabel}?`}</AlertDialogTitle>
          {conflict ? (
            <div className="space-y-4 text-sm text-muted-foreground" data-testid="delete-conflict-details">
              <p>{conflict.error} Review the records below before trying again.</p>
              <div className="space-y-3">
                {conflict.blockers.map((group) => (
                  <div key={group.type}>
                    <p className="font-medium text-foreground">{group.count} {group.count === 1 ? group.label.replace(/s$/, '') : group.label}</p>
                    <ul className="mt-1 space-y-1">
                      {group.records.map((record) => (
                        <li key={record.id}>
                          <Link
                            href={record.href}
                            onClick={() => setOpen(false)}
                            className="text-primary underline underline-offset-2 hover:no-underline"
                          >
                            {record.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <AlertDialogDescription>
              This will hide the record from all views. Continue?
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{conflict ? 'Close' : 'Cancel'}</AlertDialogCancel>
          {!conflict && <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            disabled={busy}
            data-testid="button-confirm-delete"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
