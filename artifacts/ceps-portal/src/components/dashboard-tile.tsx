import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TILE_VARIANT_STYLES, type TileVariant } from '@/lib/dashboard-models';

interface DashboardTileProps {
  title: string;
  value: number | string;
  subtitle: string;
  href: string;
  variant: TileVariant;
  icon: ReactNode;
  subtitleClassName?: string;
  testId?: string;
}

export function DashboardTile({ title, value, subtitle, href, variant, icon, subtitleClassName, testId }: DashboardTileProps) {
  const s = TILE_VARIANT_STYLES[variant];
  return (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={testId}
    >
      <Card className={`h-full transition-colors hover:bg-accent/50 ${s.card}`}>
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <span className={s.icon} aria-hidden="true">{icon}</span>
        </CardHeader>
        <CardContent>
          <div className={`text-2xl font-bold ${s.value}`}>{value}</div>
          <p className={`text-xs mt-1 ${subtitleClassName ?? 'text-muted-foreground'}`}>{subtitle}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
