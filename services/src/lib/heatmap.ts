/**
 * The liquidation heatmap's reader: pages every Rhea lending account read-only (free view calls,
 * `get_accounts_paged`) on testnet and mainnet, a few pages per pass with a pause between calls,
 * and keeps each borrower's liquidation price in Postgres. A cursor per network makes the sweep
 * resumable; accounts not seen in a whole sweep are dropped at its end.
 */

import { chainedCascades, heatBuckets, heatmapPressure, liquidationPrice, healthFactor, underwater, DEFAULT_CASCADE_PARAMS, type HeatmapAccount, type LendingPosition, type Line } from "@parryguard/core";
import { intEnv, RPC_BY_NETWORK, type Network } from "./config";
import type { Sql } from "./db";
import { lendingOf, mainnetTokenOf, pythInfos, remember, rheaAssets, tokenPrices, type RheaAsset, type TokenPrice } from "./markets";
import { view } from "./near";

type RawAccount = {
  account_id: string;
  positions?: Record<string, { RegularPosition?: { collateral: Record<string, string>; borrowed: Record<string, string> } }>;
};

export interface PricedAsset {
  asset: RheaAsset;
  price: TokenPrice;
  decimals: number;
}

/**
 * One account's position from its raw shares: collateral shares are supplied shares and debt
 * shares borrowed shares, each converted at the asset's current share price.
 */
export function accountPosition(raw: RawAccount, assets: Map<string, PricedAsset>): LendingPosition | null {
  const regular = raw.positions?.["REGULAR"]?.RegularPosition;
  if (!regular || Object.keys(regular.borrowed ?? {}).length === 0) return null;
  const line = (tokenId: string, shares: string, side: "supplied" | "borrowed"): Line | null => {
    const a = assets.get(tokenId);
    if (!a) return null;
    const pool = a.asset[side];
    const balance = Number(pool.shares) > 0 ? (Number(shares) * Number(pool.balance)) / Number(pool.shares) : 0;
    const amount = balance / 10 ** (a.decimals + a.asset.extraDecimals);
    return { symbol: tokenId, amount, priceUsd: a.price.priceUsd, volatilityRatio: a.asset.volatilityRatio, driver: a.price.nearLinked };
  };
  const collateral = Object.entries(regular.collateral ?? {}).map(([t, s]) => line(t, s, "supplied")).filter((l): l is Line => l !== null && l.amount > 0);
  const debt = Object.entries(regular.borrowed).map(([t, s]) => line(t, s, "borrowed")).filter((l): l is Line => l !== null && l.amount > 0 && l.volatilityRatio > 0);
  return debt.length ? { collateral, debt } : null;
}

export function heatmapRow(account: string, p: LendingPosition, nearPrice: number): HeatmapAccount & { health: number } {
  const usd = (ls: Line[]) => ls.reduce((s, l) => s + l.amount * l.priceUsd, 0);
  const collateralUsd = usd(p.collateral);
  const debtUsd = usd(p.debt);
  // Driver units: a line's USD over the NEAR price (a liquid staking token counts at its NEAR value).
  const units = (l: Line) => (l.amount * l.priceUsd) / nearPrice;
  const exposure =
    p.collateral.filter((l) => l.driver).reduce((s, l) => s + units(l) * l.volatilityRatio, 0) -
    p.debt.filter((l) => l.driver).reduce((s, l) => s + units(l) / l.volatilityRatio, 0);
  const weighted = (ls: Line[], total: number) => (total > 0 ? ls.reduce((s, l) => s + l.amount * l.priceUsd * l.volatilityRatio, 0) / total : null);
  return {
    account,
    liqPrice: liquidationPrice(p, nearPrice),
    driverCollateralUsd: usd(p.collateral.filter((l) => l.driver)),
    collateralUsd,
    debtUsd,
    exposure,
    collateralRatio: weighted(p.collateral, collateralUsd),
    debtRatio: weighted(p.debt, debtUsd),
    health: healthFactor(p),
  };
}

/** The listed assets of a network's lending contract with their prices and decimals. */
export async function pricedAssets(net: Network): Promise<{ assets: Map<string, PricedAsset>; nearPrice: number }> {
  const [list, prices, infos] = await Promise.all([rheaAssets(net), tokenPrices(), pythInfos()]);
  const nearPrice = prices.get("wrap.near")?.priceUsd;
  if (!nearPrice) throw new Error("no NEAR price from the lending oracle");
  const assets = new Map<string, PricedAsset>();
  for (const a of list) {
    const main = mainnetTokenOf(net, a.tokenId);
    const price = prices.get(main);
    const decimals = infos[main]?.decimals;
    if (price && decimals !== undefined) assets.set(a.tokenId, { asset: a, price, decimals });
  }
  return { assets, nearPrice };
}

/**
 * One account's lending position on `net`, every listed asset priced the way Rhea prices it, with
 * the NEAR price it was valued at; null without debt. The prices are shared for a minute.
 */
export async function readLending(net: Network, account: string): Promise<{ position: LendingPosition; nearPrice: number; collateralUsd: number; debtUsd: number } | null> {
  const lending = lendingOf(net);
  if (!lending) return null;
  type Shares = { token_id: string; shares: string }[];
  const [v, { assets, nearPrice }] = await Promise.all([
    view<{ collateral?: Shares; borrowed?: Shares } | null>(lending, "get_account", { account_id: account }, "optimistic", RPC_BY_NETWORK[net]),
    remember(`priced-assets:${net}`, 60_000, () => pricedAssets(net)),
  ]);
  if (!v) return null;
  const shares = (ls: Shares | undefined) => Object.fromEntries((ls ?? []).map((l) => [l.token_id, l.shares]));
  const position = accountPosition({ account_id: account, positions: { REGULAR: { RegularPosition: { collateral: shares(v.collateral), borrowed: shares(v.borrowed) } } } }, assets);
  if (!position) return null;
  const usd = (ls: Line[]) => ls.reduce((s, l) => s + l.amount * l.priceUsd, 0);
  return { position, nearPrice, collateralUsd: usd(position.collateral), debtUsd: usd(position.debt) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads up to `pages` pages of accounts on `net` from the cursor on, stores the borrowers, and
 * moves the cursor; at the end of the list it starts over and drops accounts the finished sweep
 * did not see.
 */
export async function sweep(sql: Sql, net: Network, pages = intEnv("HEATMAP_PAGES", 30)): Promise<{ read: number; borrowers: number; total: number }> {
  const lending = lendingOf(net);
  if (!lending) return { read: 0, borrowers: 0, total: 0 };
  const { assets, nearPrice } = await pricedAssets(net);
  const total = await view<number>(lending, "get_num_accounts", {}, "optimistic", RPC_BY_NETWORK[net]);
  const [c] = await sql<{ next_index: number; sweep_started_at: Date }[]>`SELECT next_index, sweep_started_at FROM heatmap_cursors WHERE network = ${net}`;
  let index = c?.next_index ?? 0;
  if (!c) await sql`INSERT INTO heatmap_cursors (network, total) VALUES (${net}, ${total})`;
  const limit = 100;
  let read = 0;
  let borrowers = 0;
  for (let page = 0; page < pages && index < total; page++) {
    const rows = await view<RawAccount[]>(lending, "get_accounts_paged", { from_index: index, limit }, "optimistic", RPC_BY_NETWORK[net]);
    for (const raw of rows) {
      const p = accountPosition(raw, assets);
      if (!p) {
        await sql`DELETE FROM heatmap_accounts WHERE network = ${net} AND account = ${raw.account_id}`;
        continue;
      }
      const r = heatmapRow(raw.account_id, p, nearPrice);
      borrowers++;
      await sql`INSERT INTO heatmap_accounts (network, account, collateral_usd, debt_usd, driver_collateral_usd, liq_price, health, exposure, collateral_ratio, debt_ratio, read_at)
        VALUES (${net}, ${r.account}, ${r.collateralUsd}, ${r.debtUsd}, ${r.driverCollateralUsd}, ${r.liqPrice}, ${Number.isFinite(r.health) ? r.health : null},
          ${r.exposure ?? null}, ${r.collateralRatio ?? null}, ${r.debtRatio ?? null}, now())
        ON CONFLICT (network, account) DO UPDATE SET collateral_usd = excluded.collateral_usd, debt_usd = excluded.debt_usd,
          driver_collateral_usd = excluded.driver_collateral_usd, liq_price = excluded.liq_price, health = excluded.health,
          exposure = excluded.exposure, collateral_ratio = excluded.collateral_ratio, debt_ratio = excluded.debt_ratio, read_at = now()`;
    }
    read += rows.length;
    index += rows.length;
    if (rows.length < limit) index = total;
    await sleep(intEnv("HEATMAP_PAUSE_MS", 300));
  }
  if (index >= total) {
    // A whole sweep is done: whoever it did not see has left (or repaid); start over.
    await sql`DELETE FROM heatmap_accounts WHERE network = ${net} AND read_at < ${c?.sweep_started_at ?? new Date(0)}`;
    await sql`UPDATE heatmap_cursors SET next_index = 0, total = ${total}, sweep_started_at = now(), swept_at = now(), updated_at = now() WHERE network = ${net}`;
  } else {
    await sql`UPDATE heatmap_cursors SET next_index = ${index}, total = ${total}, updated_at = now() WHERE network = ${net}`;
  }
  return { read, borrowers, total };
}

/** The stored borrowers of a network, as the core heatmap reads them. */
export async function heatmapAccounts(sql: Sql, net: Network): Promise<HeatmapAccount[]> {
  const rows = await sql<{ account: string; liq_price: number | null; driver_collateral_usd: number; collateral_usd: number; debt_usd: number; exposure: number | null; collateral_ratio: number | null; debt_ratio: number | null }[]>`
    SELECT account, liq_price, driver_collateral_usd, collateral_usd, debt_usd, exposure, collateral_ratio, debt_ratio FROM heatmap_accounts WHERE network = ${net}`;
  return rows.map((r) => ({
    account: r.account,
    liqPrice: r.liq_price,
    driverCollateralUsd: r.driver_collateral_usd,
    collateralUsd: r.collateral_usd,
    debtUsd: r.debt_usd,
    exposure: r.exposure,
    collateralRatio: r.collateral_ratio,
    debtRatio: r.debt_ratio,
  }));
}

export const cascadeParams = () => ({ ...DEFAULT_CASCADE_PARAMS, depth2pctUsd: intEnv("CASCADE_DEPTH_2PCT_USD", DEFAULT_CASCADE_PARAMS.depth2pctUsd) });

/**
 * The heatmap a network's stored borrowers make at `price`: buckets, chained cascades, accounts
 * already under water, and the pressure of a 2σ day (the same `heatmapPressure` the market report
 * takes its cascade pressure from, at the same price and volatility).
 */
export async function heatmapView(sql: Sql, net: Network, price: number, sigmaHourly: number) {
  const accounts = await heatmapAccounts(sql, net);
  const [c] = await sql<{ total: number; swept_at: Date | null; updated_at: Date; next_index: number }[]>`SELECT total, swept_at, updated_at, next_index FROM heatmap_cursors WHERE network = ${net}`;
  const buckets = heatBuckets(accounts, price);
  const params = cascadeParams();
  return {
    network: net,
    lending: lendingOf(net),
    price,
    buckets: buckets.filter((b) => b.accounts > 0),
    cascades: chainedCascades(accounts, price, buckets, params).map((x) => ({ from: x.from, to: x.to, collateralUsd: x.collateralUsd, soldUsd: x.soldUsd, accounts: x.accounts, rounds: x.rounds })),
    underwater: underwater(accounts, price),
    pressure: heatmapPressure(accounts, price, sigmaHourly, params),
    accounts: accounts.length,
    sweep: c ? { totalAccounts: c.total, nextIndex: c.next_index, lastFullSweepAt: c.swept_at?.toISOString() ?? null } : null,
    readAt: (c?.updated_at ?? new Date()).toISOString(),
    source: `${lendingOf(net)} get_accounts_paged, priced with ${lendingOf("mainnet")} get_all_token_pyth_infos; liquidations sized by Rhea's rule (back to health 1); market depth ${params.depth2pctUsd} USD per 2 % (CASCADE_DEPTH_2PCT_USD)`,
  };
}
