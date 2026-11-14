import { describe, expect, test } from "bun:test";
import { fmspcOf, nonceFor, pckChain, signedBody } from "../src/lib/attestation";

describe("attestation evidence", () => {
  test("the nonce is the enclave's: SHA-256 of the label and the block hash", () => {
    expect(nonceFor("abc")).toBe(new Bun.CryptoHasher("sha256").update("parry-attest:v1:abc").digest("hex"));
  });

  test("reads the FMSPC after its OID and the PEM chain inside a quote", () => {
    const der = Uint8Array.from([0x30, 0x82, 0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf8, 0x4d, 0x01, 0x0d, 0x01, 0x04, 0x04, 0x06, 0x90, 0xc0, 0x6f, 0, 0, 0, 0x30]);
    expect(fmspcOf(der)).toBe("90C06F000000");
    expect(() => fmspcOf(Uint8Array.from([1, 2, 3]))).toThrow();
    const pem = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----";
    const quote = Buffer.concat([Buffer.from([1, 2, 3, 4]), Buffer.from(pem, "latin1"), Buffer.from([0, 0])]).toString("hex");
    expect(pckChain(quote)).toBe(pem);
  });

  test("keeps the exact signed bytes of Intel's collateral", () => {
    const body = '{"tcbInfo":{"id":"TDX","version":3,"x":[1, 2]},"signature":"0A0B"}';
    expect(signedBody(body, "tcbInfo")).toEqual({ text: '{"id":"TDX","version":3,"x":[1, 2]}', signature: "0a0b" });
    expect(() => signedBody('{"other":1}', "tcbInfo")).toThrow();
  });
});
