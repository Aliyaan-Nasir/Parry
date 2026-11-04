// Number formatting for figures. Every figure is rendered in the mono face with tabular digits.

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatInteger(value: number): string {
  return integer.format(Math.round(value));
}

/** Compact US dollars: $950, $12.4K, $3.2M. */
export function formatUsdCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: abs < 10 ? 2 : 0 }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** "just now", "4 min ago", "3 h ago", or a date for anything older than a day. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
