"use client";

import type { ReactNode } from "react";
import { AccountProvider } from "./AccountProvider";
import { LiveProvider } from "./LiveProvider";
import { MoneyProvider } from "./MoneyProvider";
import { ConnectDialog } from "@/components/app/ConnectDialog";

/** The app's own state: the connected account (wallet, passkey or watched), live updates and the display currency. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AccountProvider>
      <LiveProvider>
        <MoneyProvider>
          {children}
          <ConnectDialog />
        </MoneyProvider>
      </LiveProvider>
    </AccountProvider>
  );
}
