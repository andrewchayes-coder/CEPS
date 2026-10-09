import React, { useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  id: string;
  label?: string;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  testId?: string;
}

export function DownloadReferralConfirmation({ id, label = 'Download confirmation (PDF)', variant = 'default', size = 'default', testId = 'button-download-confirmation' }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const download = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await fetch(`${base}/api/referrals/${encodeURIComponent(id)}/confirmation.pdf`, { credentials: 'include' });
      if (!res.ok) throw new Error(res.status === 403 ? 'You do not have access to this confirmation.' : 'Could not download the confirmation.');
      if (!res.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')) {
        throw new Error('The confirmation response was not a PDF. Please try again.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ceps-referral-confirmation-${id.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download the confirmation.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Button type="button" variant={variant} size={size} onClick={() => void download()} disabled={busy} aria-busy={busy} data-testid={testId}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
        {busy ? 'Preparing PDF…' : label}
      </Button>
      {error && <p role="alert" className="text-xs text-destructive" data-testid="error-download-confirmation">{error} <button type="button" className="underline" onClick={() => void download()} disabled={busy}>Retry</button></p>}
    </div>
  );
}
