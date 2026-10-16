import { useAuth } from '@/components/auth/auth-provider';
import { HelpDocumentation } from './help-documentation';

export default function HelpPage() {
  const { user } = useAuth();
  return <HelpDocumentation role={user?.role} />;
}
