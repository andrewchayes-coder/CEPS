import logoUrl from '@/assets/ceps-logo.png';
import { cn } from '@/lib/utils';

/**
 * CEPS brand logo (blue mark + "Community Engaged Payee Support" wordmark).
 * Replaces the previous text-only wordmark wherever a logo belongs.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src={logoUrl}
      alt="CEPS — Community Engaged Payee Support"
      className={cn('h-10 w-auto', className)}
      data-testid="img-brand-logo"
    />
  );
}
