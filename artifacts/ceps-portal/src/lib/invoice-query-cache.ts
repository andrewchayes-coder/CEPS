import type { QueryClient } from '@tanstack/react-query';

/** Invoice forms use both generated and legacy list/detail/queue keys. */
export function invalidateInvoiceQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      const key = queryKey[0];
      return typeof key === 'string' && (
        key.startsWith('invoice') || key.startsWith('/api/invoices') || key === 'client-case'
      );
    },
  });
}
