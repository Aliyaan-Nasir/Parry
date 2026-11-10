"use client";

import type { ReactNode } from "react";
import { AccountProvider } from "./AccountProvider";
import { MoneyProvider } from "./MoneyProvider";
import { ConnectDialog } from "@/components/app/ConnectDialog";

/** The app's own state: the connected account (wallet, passkey or watched) and the display currency. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AccountProvider>
      <MoneyProvider>
        {children}
        <ConnectDialog />
      </MoneyProvider>
    </AccountProvider>
  );
}
