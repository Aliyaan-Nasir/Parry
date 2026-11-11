/**
 * Live market prices for the testnet oracle: the Pyth-format prices that mainnet Rhea lending
 * itself uses (`aggregate-oracle.near`), read over a mainnet RPC (a free view call). Mirroring
 * them keeps testnet health factors on real NEAR prices.
 */

import { rpc } from "./near";

export const PRICE_SOURCE = process.env.PRICE_SOURCE_ORACLE ?? "aggregate-oracle.near";
export const PRICE_SOURCE_RPC = (process.env.PRICE_SOURCE_RPC ?? "https://free.rpc.fastnear.com,https://near.drpc.org").split(",");

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
      { request_type: "call_function", finality: "final", account_id: PRICE_SOURCE, method_name: "get_price_unsafe", args_base64: Buffer.from(JSON.stringify({ price_identifier: id })).toString("base64") },
      PRICE_SOURCE_RPC,
    );
    if (!r.result) throw new Error(`${PRICE_SOURCE}.get_price_unsafe: ${r.error ?? "no result"}`);
    const p = JSON.parse(Buffer.from(r.result).toString()) as { price: string; conf: string; expo: number; publish_time: number } | null;
    if (!p) throw new Error(`${PRICE_SOURCE} has no price for ${id}`);
    out.push({ id, price: p.price, conf: p.conf, expo: p.expo, publishTime: p.publish_time });
  }
  return out;
}
