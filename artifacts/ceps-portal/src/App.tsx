import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Redirect,
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import { AuthProvider, useAuth } from '@/components/auth/auth-provider';
import { AppShell } from '@/components/layout/app-shell';

// Pages
import LoginPage from '@/pages/login';
import MagicLinkConsumePage from '@/pages/auth/magic';
import InviteAcceptPage from '@/pages/invite/[token]';
import SignaturePage from '@/pages/sign';
import DashboardPage from '@/pages/dashboard';
import ReferralsPage from '@/pages/referrals';
import ReferralNewPage from '@/pages/referrals/new';
import ReferralDetailPage from '@/pages/referrals/[id]';
import ClientsPage from '@/pages/clients';
import ClientDetailPage from '@/pages/clients/[id]';
import AuthorizationsPage from '@/pages/authorizations';
import AuthorizationNewPage from '@/pages/authorizations/new';
import InvoicesPage from '@/pages/invoices';
import InvoiceNewPage from '@/pages/invoices/new';
import InvoiceDetailPage from '@/pages/invoices/[id]';
import PaymentsPage from '@/pages/payments';
import RemittancesPage from '@/pages/remittances';
import VendorsPage from '@/pages/vendors';
import VendorDetailPage from '@/pages/vendors/[id]';
import ReportsPage from '@/pages/reports';
import UsersPage from '@/pages/admin/users';
import AuditLogPage from '@/pages/audit-log';
import HelpPage from '@/pages/help';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  if (!user) {
    return <Redirect to="/login" replace />;
  }

  return (
    <AppShell>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/referrals" component={ReferralsPage} />
        <Route path="/referrals/new" component={ReferralNewPage} />
        <Route path="/referrals/:id" component={ReferralDetailPage} />
        <Route path="/clients" component={ClientsPage} />
        <Route path="/clients/:id" component={ClientDetailPage} />
        <Route path="/authorizations" component={AuthorizationsPage} />
        <Route path="/authorizations/new" component={AuthorizationNewPage} />
        <Route path="/invoices" component={InvoicesPage} />
        <Route path="/invoices/new" component={InvoiceNewPage} />
        <Route path="/invoices/:id" component={InvoiceDetailPage} />
        <Route path="/payments" component={PaymentsPage} />
        <Route path="/remittances" component={RemittancesPage} />
        <Route path="/vendors" component={VendorsPage} />
        <Route path="/vendors/:id" component={VendorDetailPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/admin/users" component={UsersPage} />
        <Route path="/audit-log" component={AuditLogPage} />
        <Route path="/help" component={HelpPage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/auth/magic" component={MagicLinkConsumePage} />
        <Route path="/invite/:token" component={InviteAcceptPage} />
        <Route path="/sign/:token" component={SignaturePage} />
        <Route>
          <ProtectedRoutes />
        </Route>
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
