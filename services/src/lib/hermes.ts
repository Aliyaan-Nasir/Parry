/** Pyth's Hermes service: the live market prices the testnet oracle feeder publishes. */

import { HERMES_URL } from "./config";

export interface HermesPrice {
  id: string;
  price: string;
  conf: string;
  expo: number;
  publishTime: number;
}

export async function latest(ids: string[]): Promise<HermesPrice[]> {
  const q = ids.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(`${HERMES_URL}/v2/updates/price/latest?${q}&parsed=true`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`hermes ${res.status}`);
  const body = (await res.json()) as { parsed: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
  return body.parsed.map((p) => ({ id: p.id, price: p.price.price, conf: p.price.conf, expo: p.price.expo, publishTime: p.price.publish_time }));
}
