"use client";

import { LazyMotion, MotionConfig } from "framer-motion";
import type { ReactNode } from "react";
import { AccountProvider } from "./AccountProvider";
import { LiveProvider } from "./LiveProvider";
import { MoneyProvider } from "./MoneyProvider";
import { ConnectDialog } from "@/components/app/ConnectDialog";
import { ToastProvider } from "@/components/ui/Toast";

const loadMotionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

/** The app's own state: motion, toasts, the connected account (wallet, passkey or watched), live updates and the display currency. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    // Motion (only through `m.*` components, features loaded lazily, reduced motion honored) and toasts live in the app alone.
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
    <AccountProvider>
      <LiveProvider>
        <MoneyProvider>
          {children}
          <ConnectDialog />
        </MoneyProvider>
      </LiveProvider>
    </AccountProvider>
        </ToastProvider>
      </MotionConfig>
    </LazyMotion>
  );
}
