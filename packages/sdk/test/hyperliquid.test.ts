import { describe, expect, test } from "bun:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hyperliquidBalances, hyperliquidBody, hyperliquidError, hyperliquidMarginBody, hyperliquidOrderBody, marginAmount, ownerActions, ownerCallAction, submitHyperliquid } from "../src/index.js";
import { concatBytes, toHex, utf8 } from "../src/encoding.js";

const SIG = { r: "11".repeat(32), s: "22".repeat(32), v: 28 };

const word = (n: number | bigint) => {
  const out = new Uint8Array(32);
  let v = BigInt(n);
  for (let i = 31; v > 0n; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
};
const k = (s: string) => keccak_256(utf8(s));

/** The EIP-712 digest Hyperliquid recomputes from a `usdClassTransfer` body. */
function classTransferDigest(action: { hyperliquidChain: string; signatureChainId: string; amount: string; toPerp: boolean; nonce: number }): string {
  const domain = keccak_256(
    concatBytes(k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k("HyperliquidSignTransaction"), k("1"), word(BigInt(action.signatureChainId)), new Uint8Array(32)),
  );
  const struct = keccak_256(
    concatBytes(
      k("HyperliquidTransaction:UsdClassTransfer(string hyperliquidChain,string amount,bool toPerp,uint64 nonce)"),
      k(action.hyperliquidChain),
      k(action.amount),
      word(action.toPerp ? 1 : 0),
      word(action.nonce),
    ),
  );
  return toHex(keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domain, struct)));
}

describe("hyperliquid", () => {
  test("the margin body hashes to the digest the account signs", () => {
    // The vectors the contract's tests check against ethers.
    const testnet = hyperliquidMarginBody("997", 1_700_000_000_000, SIG, "testnet");
    expect(classTransferDigest(testnet.action)).toBe("d4b0ab05d405a1e7ce9b28eb6c4ba57972b792dae0036b699b714deabc3f383b");
    const mainnet = hyperliquidMarginBody("997", 1_700_000_000_000, SIG, "mainnet");
    expect(classTransferDigest(mainnet.action)).toBe("1424d2e72a90323e096fc09f48d6a29794923275c225ba62e2e71e951cda37a7");
    expect(testnet).toEqual({
      action: { type: "usdClassTransfer", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", amount: "997", toPerp: true, nonce: 1_700_000_000_000 },
      nonce: 1_700_000_000_000,
      signature: { r: `0x${SIG.r}`, s: `0x${SIG.s}`, v: 28 },
    });
  });

  test("the order body keeps Hyperliquid's key order", () => {
    const order = { asset_index: 54, is_buy: true, price: "3.2", size: "12.3", reduce_only: true, tif: "Ioc" };
    const body = hyperliquidOrderBody(order, 5, SIG);
    expect(JSON.stringify(body)).toBe(
      `{"action":{"type":"order","orders":[{"a":54,"b":true,"p":"3.2","s":"12.3","r":true,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"},"nonce":5,"signature":{"r":"0x${SIG.r}","s":"0x${SIG.s}","v":28},"vaultAddress":null}`,
    );
    expect(() => hyperliquidOrderBody(order, 5, null)).toThrow("no signature");
    expect(() => hyperliquidOrderBody(order, 5, { r: "1", s: "2", v: 1 })).toThrow("no signature");
  });

  test("the body follows the signed action", () => {
    const order = { asset_index: 54, is_buy: false, price: "3", size: "3", reduce_only: false, tif: "Ioc" };
    expect(hyperliquidBody(ownerActions.hlOrder(order, 9), SIG, "testnet")).toEqual(hyperliquidOrderBody(order, 9, SIG));
    expect(hyperliquidBody(ownerActions.hlMarginToPerp("20", 9), SIG, "testnet")).toEqual(hyperliquidMarginBody("20", 9, SIG, "testnet"));
    expect(() => hyperliquidBody(ownerActions.revokeMandate(), SIG, "testnet")).toThrow("only hl_order");
  });

  test("the owner action stands alone and takes plain decimal amounts", () => {
    expect(ownerActions.hlMarginToPerp("48.5", 7)).toEqual({ hl_margin_to_perp: { amount: "48.5", nonce: 7 } });
    for (const bad of ["0", "0.00", "-1", "1e3", "01", "1.", ".5", "1.123456789", ""]) expect(() => ownerActions.hlMarginToPerp(bad, 7)).toThrow("positive USDC amount");
    expect(() => ownerActions.hlMarginToPerp("1", 0)).toThrow("nonce");
    expect(() => ownerCallAction("0uabc.testnet", [ownerActions.hlMarginToPerp("1", 7), ownerActions.revokeMandate()])).toThrow("must be the only action");
  });

  test("margin amounts round down to whole cents", () => {
    expect(marginAmount(50)).toBe("50");
    expect(marginAmount(48.999)).toBe("48.99");
    expect(marginAmount(12.5)).toBe("12.5");
    expect(marginAmount(0.004)).toBeNull();
    expect(marginAmount(0.5, 1)).toBeNull();
  });

  test("submit, read rejections and balances", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fake = (answers: Record<string, unknown>) => async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url, body });
      return new Response(JSON.stringify(answers[(body as { type?: string }).type ?? "exchange"]));
    };
    const rejected = { status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin to place order. asset=54" }] } } };
    const answer = await submitHyperliquid({ action: {} }, "testnet", { fetch: fake({ exchange: rejected }) });
    expect(seen[0]!.url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(hyperliquidError(answer)).toBe("Insufficient margin to place order. asset=54");
    expect(hyperliquidError({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "3" } }] } } })).toBeNull();
    await expect(submitHyperliquid({}, "mainnet", { fetch: fake({ exchange: { status: "err", response: "User or API Wallet 0x0 does not exist." } }) })).rejects.toThrow("does not exist");
    expect(seen[1]!.url).toBe("https://api.hyperliquid.xyz/exchange");

    const balances = await hyperliquidBalances("0xabc", "testnet", {
      fetch: fake({ clearinghouseState: { marginSummary: { accountValue: "12.5" } }, spotClearinghouseState: { balances: [{ coin: "USDC", total: "50.0", hold: "1.5" }] } }),
    });
    expect(balances).toEqual({ perps: 12.5, spotUsdc: 48.5 });
  });
});
