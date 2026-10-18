import { keepPreviousData, useInfiniteQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useGetMessagingUnreadCount, listMessageThreads, useListClientMessageThreads,
  getGetMessagingUnreadCountQueryKey, getListMessageThreadsQueryKey, getListClientMessageThreadsQueryKey,
  type ListMessageThreadsParams, type ListClientMessageThreadsParams,
} from '@workspace/api-client-react';
import { useAuth } from '@/components/auth/auth-provider';

export function useMessagingRole() {
  const { user } = useAuth();
  const role = user?.role;
  return {
    user,
    isMessagingUser: role === 'staff' || role === 'service_coordinator' || role === 'parent_guardian' || role === 'self',
    isStaffLike: role === 'staff' || role === 'service_coordinator',
    isFamily: role === 'parent_guardian' || role === 'self',
  };
}

export function useUnreadCount() {
  const { user, isMessagingUser } = useMessagingRole();
  return useGetMessagingUnreadCount({
    query: {
      enabled: isMessagingUser,
      queryKey: [...getGetMessagingUnreadCountQueryKey(), user?.id],
      refetchInterval: 30000,
      refetchOnWindowFocus: true,
    },
  });
}

export const THREAD_PAGE_SIZE = 50;

/** Inbox list paged by offset in pages of 50; all loaded pages refresh on poll/focus. */
export function useThreadList(params: Omit<ListMessageThreadsParams, 'limit' | 'offset'>, enabled: boolean) {
  const { user } = useAuth();
  const q = useInfiniteQuery({
    queryKey: [...getListMessageThreadsQueryKey(params as ListMessageThreadsParams), 'infinite', user?.id],
    queryFn: ({ pageParam, signal }) => listMessageThreads({ ...params, limit: THREAD_PAGE_SIZE, offset: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    enabled: enabled && !!user,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });
  const seen = new Set<string>();
  const items = (q.data?.pages ?? []).flatMap((p) => p.items).filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const total = q.data?.pages.at(-1)?.total ?? 0;
  return {
    items, total, isLoading: q.isLoading, isError: q.isError, refetch: q.refetch,
    fetchNextPage: q.fetchNextPage, hasNextPage: !!q.hasNextPage, isFetchingNextPage: q.isFetchingNextPage,
  };
}

export function useClientThreadList(clientId: string, params: ListClientMessageThreadsParams, enabled: boolean) {
  const { user } = useAuth();
  return useListClientMessageThreads(clientId, params, {
    query: {
      enabled: enabled && !!user && !!clientId,
      queryKey: [...getListClientMessageThreadsQueryKey(clientId, params), user?.id],
      refetchInterval: 30000,
      refetchOnWindowFocus: true,
      placeholderData: keepPreviousData,
    },
  });
}

/** Invalidate inbox lists, per-client lists and the nav unread count (never the open thread detail). */
export function invalidateMessaging(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: getListMessageThreadsQueryKey() });
  void qc.invalidateQueries({ queryKey: getGetMessagingUnreadCountQueryKey() });
  void qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey[0];
      return typeof k === 'string' && k.startsWith('/api/clients/') && k.endsWith('/message-threads');
    },
  });
}

export function useInvalidateMessaging() {
  const qc = useQueryClient();
  return () => invalidateMessaging(qc);
}

export function errText(e: unknown, fallback = 'Something went wrong. Your text has been kept; please try again.'): string {
  const m = e as { data?: { error?: string }; message?: string } | null;
  return m?.data?.error || m?.message || fallback;
}
