"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, MotionConfig } from "framer-motion";
import { useState, type ReactNode } from "react";
import { ToastProvider } from "@/components/ui/Toast";

const loadMotionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
    },
  });
}

/**
 * Client providers for every page: React Query (data), Motion (animation, only through `m.*`
 * components, features loaded lazily, reduced motion honored) and toasts.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={loadMotionFeatures} strict>
        <MotionConfig reducedMotion="user">
          <ToastProvider>{children}</ToastProvider>
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  );
}
