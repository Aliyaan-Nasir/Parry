"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Currency } from "@/lib/api-types";
import { formatMoney, readCurrency, subscribeCurrency, writeCurrency, type MoneyOptions } from "@/lib/money";
import { useFx, useSettings } from "@/lib/queries";
import { useParryAccount } from "./AccountProvider";

export type Money = {
  /** The chosen display currency. */
  currency: Currency;
  /** The currency figures are shown in: the chosen one, or USD while its rate is unavailable. */
  shown: Currency;
  /** Units of the display currency per USD, or null for USD or while the rate is unavailable. */
  rate: number | null;
  /** Formats a USD amount from the API in the display currency. */
  format: (usd: number, opts?: MoneyOptions) => string;
  setCurrency: (currency: Currency) => void;
  /** When the rates were published, for the settings page. */
  ratesUpdatedAt: string | null;
  ratesError: boolean;
};

const MoneyContext = createContext<Money | null>(null);

/** The one money formatter: every USD figure in the app goes through it. */
export function useMoney(): Money {
  const ctx = useContext(MoneyContext);
  if (!ctx) throw new Error("useMoney must be used under <MoneyProvider>");
  return ctx;
}

export function MoneyProvider({ children }: { children: ReactNode }) {
  const { account } = useParryAccount();
  const local = useSyncExternalStore(subscribeCurrency, readCurrency, () => null);
  const settings = useSettings(account);
  // This device's choice wins; without one, the account's saved currency applies.
  const currency: Currency = local ?? settings.data?.displayCurrency ?? "USD";
  const fx = useFx(currency !== "USD");
  const raw = currency === "USD" ? null : (fx.data?.rates[currency] ?? null);
  const rate = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
  const shown: Currency = rate === null ? "USD" : currency;

  const format = useCallback((usd: number, opts?: MoneyOptions) => formatMoney(usd, currency, rate, opts), [currency, rate]);

  const value = useMemo<Money>(
    () => ({
      currency,
      shown,
      rate,
      format,
      setCurrency: writeCurrency,
      ratesUpdatedAt: fx.data?.updatedAt ?? null,
      ratesError: fx.isError,
    }),
    [currency, shown, rate, format, fx.data?.updatedAt, fx.isError],
  );

  return <MoneyContext.Provider value={value}>{children}</MoneyContext.Provider>;
}
