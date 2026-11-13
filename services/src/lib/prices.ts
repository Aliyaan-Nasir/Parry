/**
 * Live market prices for the testnet oracle: the Pyth-format prices that mainnet Rhea lending
 * itself uses (`aggregate-oracle.near`), read over a mainnet RPC (a free view call). Mirroring
 * them keeps testnet health factors on real NEAR prices.
 *
 * Prices are read the way Rhea reads them, `get_price_no_older_than` within its own freshness
 * bound: `get_price_unsafe` on the aggregate oracle can answer with a price hours old, or none.
 */

import { rpc } from "./near";

export const PRICE_SOURCE = process.env.PRICE_SOURCE_ORACLE ?? "aggregate-oracle.near";
export const PRICE_SOURCE_RPC = (process.env.PRICE_SOURCE_RPC ?? "https://free.rpc.fastnear.com,https://near.drpc.org").split(",");
/** Seconds a source price may be old: mainnet Rhea lending's `pyth_price_valid_duration_sec`. */
export const PRICE_MAX_AGE = Number(process.env.PRICE_SOURCE_MAX_AGE ?? 60);

export interface SourcePrice {
  id: string;
  price: string;
  conf: string;
  expo: number;
  publishTime: number;
}

export async function latest(ids: string[]): Promise<SourcePrice[]> {
  const out: SourcePrice[] = [];
  for (const id of ids) {
    const r = await rpc<{ result?: number[]; error?: string }>(
      "query",
      { request_type: "call_function", finality: "final", account_id: PRICE_SOURCE, method_name: "get_price_no_older_than", args_base64: Buffer.from(JSON.stringify({ price_id: id, age: PRICE_MAX_AGE })).toString("base64") },
      PRICE_SOURCE_RPC,
    );
    if (!r.result) throw new Error(`${PRICE_SOURCE}.get_price_no_older_than: ${r.error ?? "no result"}`);
    const p = JSON.parse(Buffer.from(r.result).toString()) as { price: string; conf: string; expo: number; publish_time: number } | null;
    if (!p) throw new Error(`${PRICE_SOURCE} has no price for ${id} newer than ${PRICE_MAX_AGE} s`);
    out.push({ id, price: p.price, conf: p.conf, expo: p.expo, publishTime: p.publish_time });
  }
  return out;
}
