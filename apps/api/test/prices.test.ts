import { describe, expect, test } from "bun:test";
import { pricesMatch } from "../src/routes";

const wnear = { id: "wrap.near", symbol: "wNEAR" };
const eth = { id: "aurora", symbol: "ETH" };
const usdc = { id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC" };

describe("/v1/prices tokens", () => {
  test("NEAR, wNEAR and the token id name wNEAR, in any case", () => {
    for (const w of ["NEAR", "near", "wNEAR", "WNEAR", "wrap.near", "Wrap.Near", "wrap.testnet"]) expect(pricesMatch(w, wnear)).toBe(true);
    expect(pricesMatch("NEAR", usdc)).toBe(false);
  });

  test("ETH names Aurora's bridged ETH; symbols and ids match case-insensitively", () => {
    expect(pricesMatch("ETH", eth)).toBe(true);
    expect(pricesMatch("eth", eth)).toBe(true);
    expect(pricesMatch("aurora", eth)).toBe(true);
    expect(pricesMatch("usdc", usdc)).toBe(true);
    expect(pricesMatch("USDT", usdc)).toBe(false);
  });
});
