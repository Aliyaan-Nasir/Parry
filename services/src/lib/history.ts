/**
 * NEAR's recent price history, as the risk model reads it. Volatility comes from the market:
 * Hyperliquid's prices rescaled onto the oracle's level (as the enclave does), so a testnet market
 * shock moves health without passing for market volatility. Without market prices, the oracle's.
 */

import type { Sample } from "@parryguard/core";
import type { Sql } from "./db";

async function samples(sql: Sql, source: string, hours: number): Promise<Sample[]> {
  const rows = await sql<{ t: Date; price: number }[]>`
    SELECT t, price FROM prices WHERE asset = 'NEAR' AND source = ${source} AND t > now() - make_interval(hours => ${hours}) ORDER BY t`;
  return rows.map((r) => ({ t: r.t.getTime() / 1000, price: r.price }));
}

/**
 * The oracle's latest price, the market history to measure volatility with (rescaled onto that
 * price), and Hyperliquid's own history (for perps, valued at their own mark).
 */
export async function nearHistory(sql: Sql, hours = 12): Promise<{ price: number; history: Sample[]; hyperliquid: Sample[] }> {
  const oracle = await samples(sql, "oracle", hours);
  const market = await samples(sql, "hyperliquid", hours);
  const price = oracle[oracle.length - 1]?.price ?? 0;
  const last = market[market.length - 1]?.price;
  return { price, history: last && price ? market.map((s) => ({ t: s.t, price: (s.price * price) / last })) : oracle, hyperliquid: market };
}
