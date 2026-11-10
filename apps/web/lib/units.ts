// Formatting for the app's figures that are not money: health, percentages, durations, token
// amounts in their smallest units. Money goes through useMoney (lib/money.ts).

const dp = (digits: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const upTo = (digits: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits });

/** Health factor with two decimals; null (no debt) reads as "No debt". */
export function formatHealth(health: number | null | undefined): string {
  if (health === null || health === undefined || !Number.isFinite(health)) return "No debt";
  // Rounded like every other figure, except that a health below 1 never rounds up to 1.00.
  return dp(2).format(health < 1 ? Math.floor(health * 100) / 100 : Math.round(health * 100) / 100);
}

/** A 0..1 fraction as a percentage: 0.0435 is "4.35%". */
export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return "n/a";
  return `${dp(digits).format(fraction * 100)}%`;
}

/** A probability: below 0.1% reads "under 0.1%", near certain reads "over 99.9%". */
export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  if (p <= 0) return "0%";
  if (p < 0.001) return "under 0.1%";
  if (p > 0.999) return "over 99.9%";
  return `${upTo(1).format(p * 100)}%`;
}

/** Hours as a short duration; null or beyond 30 days reads "more than 30 days". */
export function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours >= 720) return "more than 30 days";
  if (hours < 1 / 60) return "under 1 min";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${upTo(hours < 10 ? 1 : 0).format(hours)} h`;
  return `${upTo(1).format(hours / 24)} days`;
}

/** Basis points as a percentage: 250 is "2.5%". */
export function formatBps(bps: number): string {
  return `${upTo(2).format(bps / 100)}%`;
}

/** A plain number with a fixed number of decimals. */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "n/a";
  return dp(digits).format(value);
}

/** A token amount in smallest units (decimal string) as a decimal string, trimmed to `digits`. */
export function fromUnits(amount: string | bigint, decimals: number, digits = 4): string {
  let n: bigint;
  try {
    n = typeof amount === "bigint" ? amount : BigInt(amount);
  } catch {
    return "n/a";
  }
  const negative = n < 0n;
  if (negative) n = -n;
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  const text = `${new Intl.NumberFormat("en-US").format(whole)}${frac ? `.${frac}` : ""}`;
  return negative ? `-${text}` : text;
}

/** A token amount in smallest units as a JavaScript number (for previews and charts only). */
export function unitsToNumber(amount: string | bigint, decimals: number): number {
  try {
    const n = typeof amount === "bigint" ? amount : BigInt(amount);
    const base = 10n ** BigInt(decimals);
    return Number(n / base) + Number(n % base) / Number(base);
  } catch {
    return Number.NaN;
  }
}

/** A decimal amount ("12.5") to smallest units, refusing anything that is not a plain decimal. */
export function toUnits(amount: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Shortens long ids for display: 0uwgjhgw...cnj0. */
export function shortId(id: string, head = 8, tail = 6): string {
  if (id.length <= head + tail + 3) return id;
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

/** A unix time in seconds or an ISO string as a short local date and time. */
export function formatDateTime(at: number | string): string {
  const t = typeof at === "number" ? at * 1000 : Date.parse(at);
  if (!Number.isFinite(t)) return "n/a";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Seconds from now until a unix time, as "in 12 min" or "expired". */
export function formatUntil(atSeconds: number, nowMs: number = Date.now()): string {
  const s = Math.round(atSeconds - nowMs / 1000);
  if (s <= 0) return "expired";
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 172_800) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86_400)} days`;
}
