/**
 * Live market reads that the API and the services share: every asset Rhea lending lists (with its
 * rates and its configuration), token prices the way Rhea prices them (Pyth feeds on
 * `aggregate-oracle.near`, times the staking rate for liquid staking tokens), 24-hour changes,
 * and Hyperliquid's NEAR funding. Every number carries the source it was read from.
 */

import { contractOn, HYPERLIQUID_NEAR_INDEX, HYPERLIQUID_URL, NEAR_USD, RPC_BY_NETWORK, type Network } from "./config";
import { view } from "./near";
import { PRICE_SOURCE } from "./prices";

const memo = new Map<string, { at: number; value: unknown }>();
/** A small in-process cache for reads many requests share. */
export async function remember<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await read();
  memo.set(key, { at: Date.now(), value });
  return value;
}

export interface RheaAsset {
  tokenId: string;
  supplyApr: number;
  borrowApr: number;
  /** Borrowed over supplied plus reserved. */
  utilization: number;
  /** 0..1 */
  volatilityRatio: number;
  extraDecimals: number;
  supplied: { shares: string; balance: string };
  borrowed: { shares: string; balance: string };
  canBorrow: boolean;
  canUseAsCollateral: boolean;
}

type AssetView = {
  token_id: string;
  supplied: { shares: string; balance: string };
  borrowed: { shares: string; balance: string };
  reserved: string;
  supply_apr: string;
  borrow_apr: string;
  config: { volatility_ratio: number; extra_decimals: number; can_borrow: boolean; can_use_as_collateral: boolean };
};

export const lendingOf = (net: Network): string => contractOn(net, "lending");

/** Every asset a Rhea lending contract lists (`get_assets_paged_detailed`), read live. */
export async function rheaAssets(net: Network): Promise<RheaAsset[]> {
  const out: RheaAsset[] = [];
  for (let from = 0; from < 1000; from += 100) {
    const page = await view<AssetView[]>(lendingOf(net), "get_assets_paged_detailed", { from_index: from, limit: 100 }, "optimistic", RPC_BY_NETWORK[net]);
    for (const a of page) {
      const supplied = Number(a.supplied.balance) + Number(a.reserved);
      out.push({
        tokenId: a.token_id,
        supplyApr: Number(a.supply_apr),
        borrowApr: Number(a.borrow_apr),
        utilization: supplied > 0 ? Number(a.borrowed.balance) / supplied : 0,
        volatilityRatio: a.config.volatility_ratio / 10_000,
        extraDecimals: a.config.extra_decimals,
        supplied: a.supplied,
        borrowed: a.borrowed,
        canBorrow: a.config.can_borrow,
        canUseAsCollateral: a.config.can_use_as_collateral,
      });
    }
    if (page.length < 100) break;
  }
  return out;
}

/** A token's symbol and decimals (`ft_metadata`), cached for a day. */
export async function tokenMeta(net: Network, tokenId: string): Promise<{ symbol: string; decimals: number }> {
  return remember(`meta:${net}:${tokenId}`, 86_400_000, async () => {
    const m = await view<{ symbol: string; decimals: number }>(tokenId, "ft_metadata", {}, "optimistic", RPC_BY_NETWORK[net]).catch(() => null);
    return { symbol: m?.symbol ?? tokenId, decimals: m?.decimals ?? 0 };
  });
}

export interface PythInfo {
  decimals: number;
  price_identifier: string;
  extra_call: string | null;
  default_price: { multiplier: string; decimals: number } | null;
}

/** How mainnet Rhea lending prices each token (`get_all_token_pyth_infos`), cached for an hour. */
export const pythInfos = (): Promise<Record<string, PythInfo>> =>
  remember("pyth-infos", 3_600_000, () => view<Record<string, PythInfo>>(lendingOf("mainnet"), "get_all_token_pyth_infos", {}, "optimistic", RPC_BY_NETWORK.mainnet));

/** Testnet tokens priced as their mainnet counterparts (the testnet oracle mirrors mainnet prices). */
export function mainnetTokenOf(net: Network, tokenId: string): string {
  if (net === "mainnet") return tokenId;
  const map: Record<string, string> = {
    "wrap.testnet": "wrap.near",
    "linear-protocol.testnet": "linear-protocol.near",
    "meta-v2.pool.testnet": "meta-pool.near",
    [contractOn("testnet", "usdc")]: contractOn("mainnet", "usdc"),
  };
  return map[tokenId] ?? tokenId;
}

export interface TokenPrice {
  tokenId: string;
  priceUsd: number;
  /** True when the token moves with NEAR (wNEAR and the liquid staking tokens). */
  nearLinked: boolean;
  source: string;
}

/**
 * USD prices of every token mainnet Rhea lending prices, read the way it reads them: the Pyth
 * feed's price on `aggregate-oracle.near` (`get_price_unsafe`), times the token's own rate view
 * for liquid staking tokens (`ft_price`, `get_st_near_price`, ...), or the configured fixed price.
 */
export async function tokenPrices(): Promise<Map<string, TokenPrice>> {
  return remember("token-prices", 60_000, async () => {
    const infos = await pythInfos();
    const feeds = [...new Set(Object.values(infos).map((i) => i.price_identifier).filter((id) => !/^0+$/.test(id)))];
    const feedPrice = new Map<string, number>();
    await Promise.all(
      feeds.map(async (id) => {
        const p = await view<{ price: string; expo: number } | null>(PRICE_SOURCE, "get_price_unsafe", { price_identifier: id }, "optimistic", RPC_BY_NETWORK.mainnet).catch(() => null);
        if (p) feedPrice.set(id, Number(p.price) * 10 ** p.expo);
      }),
    );
    const out = new Map<string, TokenPrice>();
    await Promise.all(
      Object.entries(infos).map(async ([tokenId, info]) => {
        if (info.default_price) {
          out.set(tokenId, { tokenId, priceUsd: Number(info.default_price.multiplier) / 10 ** (info.default_price.decimals - info.decimals), nearLinked: false, source: `${lendingOf("mainnet")} fixed price` });
          return;
        }
        const base = feedPrice.get(info.price_identifier);
        if (base === undefined) return;
        let priceUsd = base;
        let source = `${PRICE_SOURCE} get_price_unsafe (Pyth ${info.price_identifier.slice(0, 8)})`;
        if (info.extra_call) {
          const rate = await view<string>(tokenId, info.extra_call, {}, "optimistic", RPC_BY_NETWORK.mainnet).catch(() => null);
          if (rate === null) return;
          priceUsd = base * (Number(rate) / 1e24);
          source += ` × ${tokenId} ${info.extra_call}`;
        }
        out.set(tokenId, { tokenId, priceUsd, nearLinked: info.price_identifier === NEAR_USD, source });
      }),
    );
    return out;
  });
}

/** Pyth feeds with a Binance spot market for the 24-hour change. */
const BINANCE_BY_FEED: Record<string, string> = {
  [NEAR_USD]: "NEARUSDT",
  e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: "BTCUSDT",
  ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: "ETHUSDT",
  be9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24: "ZECUSDT",
  eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a: "USDCUSDT",
};
export const BINANCE_TICKER = "https://data-api.binance.vision/api/v3/ticker/24hr";

/** 24-hour changes (fractions) from Binance's public spot tickers, keyed by Pyth feed id. */
export async function changes24h(fetchFn: typeof fetch = fetch): Promise<Map<string, { change: number; symbol: string }>> {
  return remember("changes-24h", 120_000, async () => {
    const symbols = Object.values(BINANCE_BY_FEED);
    const res = await fetchFn(`${BINANCE_TICKER}?symbols=${encodeURIComponent(JSON.stringify(symbols))}`, { signal: AbortSignal.timeout(10_000) });
    const out = new Map<string, { change: number; symbol: string }>();
    if (!res.ok) return out;
    const rows = (await res.json()) as { symbol: string; priceChangePercent: string }[];
    for (const [feed, symbol] of Object.entries(BINANCE_BY_FEED)) {
      const r = rows.find((x) => x.symbol === symbol);
      if (r) out.set(feed, { change: Number(r.priceChangePercent) / 100, symbol });
    }
    return out;
  });
}

export interface HyperliquidFunding {
  /** The current hourly funding rate of the NEAR perp (positive: longs pay shorts). */
  fundingHourly: number | null;
  /** The mean hourly funding over the last 24 hours, annualized. */
  funding24hApr: number | null;
  source: string;
}

/** Hyperliquid's NEAR funding: the live rate (`metaAndAssetCtxs`) and the last day's (`fundingHistory`). */
export async function hyperliquidFunding(fetchFn: typeof fetch = fetch): Promise<HyperliquidFunding> {
  return remember("hl-funding", 60_000, async () => {
    const post = async <T>(body: unknown): Promise<T> => {
      const res = await fetchFn(`${HYPERLIQUID_URL}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`hyperliquid info ${res.status}`);
      return (await res.json()) as T;
    };
    const [meta, history] = await Promise.all([
      post<[{ universe: { name: string }[] }, { funding: string }[]]>({ type: "metaAndAssetCtxs" }).catch(() => null),
      post<{ fundingRate: string }[]>({ type: "fundingHistory", coin: "NEAR", startTime: Date.now() - 86_400_000 }).catch(() => null),
    ]);
    const index = meta ? meta[0].universe.findIndex((u) => u.name === "NEAR") : -1;
    const ctx = meta && index >= 0 ? meta[1][index] : meta?.[1][HYPERLIQUID_NEAR_INDEX];
    const rates = (history ?? []).map((h) => Number(h.fundingRate)).filter(Number.isFinite);
    return {
      fundingHourly: ctx ? Number(ctx.funding) : null,
      funding24hApr: rates.length ? (rates.reduce((s, x) => s + x, 0) / rates.length) * 24 * 365 : null,
      source: `${HYPERLIQUID_URL}/info metaAndAssetCtxs and fundingHistory (NEAR)`,
    };
  });
}
