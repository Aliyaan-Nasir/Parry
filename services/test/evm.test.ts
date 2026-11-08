import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { assembleSigned, encodeLength, encodeUnsigned, rlpBytes, rlpDecodeList, signerOf, txHashOf, verifyRequest } from "../src/lib/evm";
import tx from "./fixtures/base-sepolia-tx.json";

const bytes = (h: string) => {
  const s = h.replace(/^0x/, "");
  if (s === "" || /^0+$/.test(s)) return new Uint8Array();
  return hexToBytes(s.length % 2 ? `0${s}` : s);
};

/** 0x02 || rlp([chainId, nonce, tip, maxFee, gas, to, value, data, []]), as the contract builds it. */
function unsigned(t: typeof tx): string {
  const fields = [t.chainId, t.nonce, t.maxPriorityFeePerGas, t.maxFeePerGas, t.gas, t.to, t.value, t.input].map((f, i) =>
    i === 5 || i === 7 ? hexToBytes(f.slice(2)) : bytes(f),
  );
  const payload = [...fields.flatMap((f) => [...rlpBytes(f)]), 0xc0];
  return `0x02${bytesToHex(Uint8Array.of(...encodeLength(payload.length, 0xc0), ...payload))}`;
}

describe("the EVM rescue transaction", () => {
  // A real Base Sepolia transaction: rebuilding it from its fields and signature must give the
  // exact bytes the chain hashed, and recover its sender.
  test("assembles a signed transaction byte for byte", () => {
    const sig = { r: tx.r.slice(2), s: tx.s.slice(2), v: Number(tx.yParity) + 27 };
    const u = unsigned(tx);
    expect(rlpDecodeList(hexToBytes(u.slice(4)))).toHaveLength(9);
    const raw = assembleSigned(u, sig);
    expect(txHashOf(raw)).toBe(tx.hash);
    expect(signerOf(u, sig)).toBe(tx.from);
    expect(
      encodeUnsigned({
        chainId: Number(tx.chainId), nonce: Number(tx.nonce), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), maxFeePerGas: BigInt(tx.maxFeePerGas),
        gasLimit: BigInt(tx.gas), to: tx.to, value: BigInt(tx.value), data: tx.input,
      }),
    ).toBe(u);
  });

  test("a signature from Chain Signatures' shape recovers the signing key's address", () => {
    const key = secp256k1.utils.randomSecretKey();
    const address = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(12))}`;
    const u = unsigned({ ...tx, nonce: "0x0", value: "0x0" });
    const recovered = secp256k1.sign(keccak_256(hexToBytes(u.slice(2))), key, { prehash: false, format: "recovered" });
    // The contract returns r and s as hex and v as 27 or 28.
    const sig = { r: bytesToHex(recovered.slice(1, 33)), s: bytesToHex(recovered.slice(33)), v: recovered[0]! + 27 };
    expect(signerOf(u, sig)).toBe(address);
    const fields = rlpDecodeList(hexToBytes(assembleSigned(u, sig).slice(4)));
    expect(fields).toHaveLength(12);
  });

  test("asks the MPC network to verify on Base, at finality, with the repay log", () => {
    expect(verifyRequest(`0x${"ab".repeat(32)}`, 3)).toEqual({
      request: {
        request: { Base: { tx_id: "ab".repeat(32), extractors: ["BlockHash", { Log: { log_index: 3 } }], finality: "Finalized" } },
        domain_id: 3,
        payload_version: 1,
      },
    });
  });
});
