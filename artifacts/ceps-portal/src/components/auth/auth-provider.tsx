import React, { createContext, useContext, ReactNode } from 'react';
import { useGetCurrentUser, SessionUser, getGetCurrentUserQueryKey } from '@workspace/api-client-react';

interface AuthContextType {
  user: SessionUser | null;
  isLoading: boolean;
  error: Error | null;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  error: null,
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const { data: user, isLoading, error } = useGetCurrentUser({
    query: {
      retry: false,
      queryKey: getGetCurrentUserQueryKey()
    }
  });

  return (
    <AuthContext.Provider value={{ user: user || null, isLoading, error: error as Error | null }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
