// Money: every USD figure from the API goes through one formatter, converted to the display
// currency with the API's rates (/v1/fx). Without a rate the figure stays in US dollars.

import { isCurrency, type Currency } from "./api-types";

export const CURRENCY_STORAGE_KEY = "parry-currency";
export const CURRENCY_EVENT = "parry-currency-change";

export type MoneyOptions = {
  /** $12.4K instead of $12,400.00. */
  compact?: boolean;
  /** Fixed fraction digits; by default 0 above 1,000, 2 above 1 and 4 below. */
  digits?: number;
  /** Prefix positive values with "+". */
  signed?: boolean;
};

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: Currency, compact: boolean, digits: number): Intl.NumberFormat {
  const key = `${currency}:${compact}:${digits}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      ...(compact ? { notation: "compact", maximumFractionDigits: 1 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    });
    formatters.set(key, f);
  }
  return f;
}

function autoDigits(value: number, currency: Currency): number {
  const abs = Math.abs(value);
  // Yen and rupees carry big numbers for small amounts: fewer decimals read better.
  const big = currency === "JPY" || currency === "INR";
  if (abs >= 1000) return 0;
  if (abs >= 1) return big ? 0 : 2;
  if (abs === 0) return 2;
  return big ? 2 : 4;
}

/** Formats a USD amount in `currency` at `rate` (units of currency per USD). */
export function formatMoney(usd: number, currency: Currency, rate: number | null, opts: MoneyOptions = {}): string {
  if (!Number.isFinite(usd)) return "n/a";
  const useRate = currency !== "USD" && rate !== null && Number.isFinite(rate) && rate > 0;
  const shown: Currency = useRate ? currency : "USD";
  const value = useRate ? usd * (rate as number) : usd;
  const compact = !!opts.compact && Math.abs(value) >= 10_000;
  const text = formatterFor(shown, compact, opts.digits ?? autoDigits(value, shown)).format(value);
  return opts.signed && value > 0 ? `+${text}` : text;
}

/** The choice made on this page, kept in memory too in case storage is unavailable. */
let chosen: Currency | null | undefined;

export function readCurrency(): Currency | null {
  if (chosen !== undefined) return chosen;
  try {
    const v = window.localStorage.getItem(CURRENCY_STORAGE_KEY);
    return isCurrency(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeCurrency(currency: Currency): void {
  chosen = currency === "USD" ? null : currency;
  try {
    if (currency === "USD") window.localStorage.removeItem(CURRENCY_STORAGE_KEY);
    else window.localStorage.setItem(CURRENCY_STORAGE_KEY, currency);
  } catch {
    // Storage can be unavailable; the choice then lasts for this page only.
  }
  window.dispatchEvent(new Event(CURRENCY_EVENT));
}

export function subscribeCurrency(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== CURRENCY_STORAGE_KEY) return;
    chosen = undefined;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CURRENCY_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CURRENCY_EVENT, onChange);
  };
}
