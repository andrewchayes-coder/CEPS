import React from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { Link, useLocation } from 'wouter';
import { useLogout } from '@workspace/api-client-react';
import { 
  LayoutDashboard, 
  Users, 
  FileText, 
  FileCheck, 
  Receipt, 
  CreditCard,
  Building2,
  Settings,
  LogOut,
  FolderSync,
  PieChart
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface NavItem {
  title: string;
  href: string;
  icon: React.ElementType;
  roles: string[];
}

const navItems: NavItem[] = [
  { title: 'Dashboard', href: '/', icon: LayoutDashboard, roles: ['staff', 'service_coordinator', 'vendor', 'parent_guardian', 'self'] },
  { title: 'Referrals', href: '/referrals', icon: FileText, roles: ['staff', 'service_coordinator'] },
  { title: 'Clients', href: '/clients', icon: Users, roles: ['staff', 'service_coordinator'] },
  { title: 'Authorizations', href: '/authorizations', icon: FileCheck, roles: ['staff', 'service_coordinator', 'vendor'] },
  { title: 'Invoices', href: '/invoices', icon: Receipt, roles: ['staff', 'vendor', 'parent_guardian', 'self'] },
  { title: 'Payments', href: '/payments', icon: CreditCard, roles: ['staff', 'vendor', 'parent_guardian', 'self'] },
  { title: 'Remittances', href: '/remittances', icon: FolderSync, roles: ['staff'] },
  { title: 'Vendors', href: '/vendors', icon: Building2, roles: ['staff'] },
  { title: 'Reports', href: '/reports', icon: PieChart, roles: ['staff', 'service_coordinator', 'vendor'] },
  { title: 'Users', href: '/admin/users', icon: Settings, roles: ['staff'] },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const logout = useLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        window.location.href = '/login';
      }
    });
  };

  const filteredNavItems = navItems.filter(item => 
    user && item.roles.includes(user.role)
  );

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-card flex flex-col hidden md:flex shrink-0">
        <div className="h-16 flex items-center px-6 border-b shrink-0">
          <div className="flex items-center gap-2 text-primary font-bold text-xl tracking-tight">
            {/* <BrandMark /> */}
            <span>CEPS</span>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-1">
          {filteredNavItems.map((item) => {
            const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href));
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive 
                    ? "bg-primary text-primary-foreground" 
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {item.title}
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t shrink-0">
          <div className="mb-4">
            <p className="text-sm font-medium text-foreground truncate">{user?.name}</p>
            <p className="text-xs text-muted-foreground truncate capitalize">{user?.role.replace('_', ' ')}</p>
          </div>
          <Button variant="outline" className="w-full justify-start text-muted-foreground" onClick={handleLogout}>
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile Header */}
        <header className="h-16 border-b bg-card flex items-center justify-between px-4 md:hidden shrink-0">
          <div className="text-primary font-bold text-lg tracking-tight">CEPS</div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <LogOut className="w-4 h-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
