/**
 * Opens an Aave loan on the EVM chain (Base Sepolia on testnet) at a protected account's own
 * Chain Signatures address, signed by the account through its owner: wrap ETH, supply it as
 * collateral, borrow USDC down to a chosen health. Every transaction is built here, its hash
 * signed by the account contract (`owner_call` with `mpc_sign` at `parry-evm`), and broadcast.
 * It then prints the mandate's EVM guard, so the guardian can repay the loan if it gets close
 * to liquidation.
 *
 *   OWNER_ACCOUNT_ID=... OWNER_PRIVATE_KEY=ed25519:... \
 *     bun scripts/evm-position.ts <protected account> [--eth 0.01] [--health 1.15]
 *
 * The derived address needs a little ETH on the chain first; the script prints it and stops if
 * it has none.
 */

import { Near } from "near-kit";
import type { FinalExecutionOutcome } from "near-kit";
import { contract, EVM, network, RPC_URLS } from "../services/src/lib/config";
import { assembleSigned, broadcast, encodeUnsigned, rpc, signingHash, waitForReceipt } from "../services/src/lib/evm";
import { returnValue, txHash } from "../services/src/lib/near";
import { derivedAddress, PATH_EVM, readAave } from "../services/src/lib/positions";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const account = process.argv[2];
const ownerId = process.env.OWNER_ACCOUNT_ID;
const ownerKey = process.env.OWNER_PRIVATE_KEY;
if (!account || account.startsWith("--") || !ownerId || !ownerKey) {
  console.error("usage: OWNER_ACCOUNT_ID=... OWNER_PRIVATE_KEY=... bun scripts/evm-position.ts <protected account> [--eth 0.01] [--health 1.15]");
  process.exit(1);
}
const ethIn = BigInt(Math.round(Number(arg("eth", "0.01")) * 1e6)) * 10n ** 12n;
const targetHealth = Number(arg("health", "1.15"));
if (!(targetHealth > 1.02 && targetHealth < 3)) throw new Error("--health must be between 1.02 and 3");

const word = (v: bigint | string) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : v.toString(16)).padStart(64, "0");
const { pool, usdc, weth } = EVM.aave;
const near = new Near({ network: { networkId: network, rpcUrl: RPC_URLS[0]! }, privateKey: ownerKey as never, defaultSignerId: ownerId });
const address = await derivedAddress(account, PATH_EVM);
console.log(`${account} on ${EVM.name}: ${address}`);

const balance = BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
if (balance < ethIn + 10n ** 15n) {
  console.error(`fund ${address} with at least ${Number(ethIn + 10n ** 15n) / 1e18} ${EVM.name} ETH (it holds ${Number(balance) / 1e18})`);
  process.exit(2);
}

/** Builds one transaction, has the account sign its hash with Chain Signatures, broadcasts it. */
async function send(label: string, to: string, data: string, value = 0n) {
  const [nonce, block, tip, gas] = await Promise.all([
    rpc<string>("eth_getTransactionCount", [address, "pending"]),
    rpc<{ baseFeePerGas: string }>("eth_getBlockByNumber", ["latest", false]),
    rpc<string>("eth_maxPriorityFeePerGas", []),
    rpc<string>("eth_estimateGas", [{ from: address, to, data, value: `0x${value.toString(16)}` }]),
  ]);
  const unsigned = encodeUnsigned({
    chainId: EVM.chainId,
    nonce: Number(nonce),
    maxPriorityFeePerGas: BigInt(tip),
    maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + BigInt(tip),
    gasLimit: (BigInt(gas) * 13n) / 10n,
    to,
    value,
    data,
  });
  const o = (await near
    .transaction(ownerId!)
    .functionCall(account!, "owner_call", { actions: [{ mpc_sign: { path: PATH_EVM, payload: signingHash(unsigned), domain_id: 0 } }] }, { gas: "300 Tgas" as never, attachedDeposit: "1 yocto" as never })
    .send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as FinalExecutionOutcome;
  const sig = returnValue<{ r: string; s: string; v: number }>(o);
  if (!sig) throw new Error(`${label}: the account returned no signature (${txHash(o)})`);
  const hash = await broadcast(assembleSigned(unsigned, sig));
  const r = await waitForReceipt(hash, 90_000);
  if (r?.status !== "0x1") throw new Error(`${label}: ${r ? "reverted" : "no receipt"} (${EVM.explorer}/tx/${hash})`);
  console.log(`${label}: ${EVM.explorer}/tx/${hash} (signed in NEAR ${txHash(o)})`);
}

await send("wrap ETH", weth, "0xd0e30db0", ethIn);
await send("approve the pool", weth, `0x095ea7b3${word(pool)}${word(ethIn)}`);
await send("supply WETH", pool, `0x617ba037${word(weth)}${word(ethIn)}${word(address)}${word(0n)}`);

// Health = collateral × threshold / debt: borrow down to the target.
const data = await rpc<string>("eth_call", [{ to: pool, data: `0xbf92857c${word(address)}` }, "latest"]);
const w = (i: number) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
const [collateralBase, debtBase, threshold] = [w(0), w(1), w(3)];
const borrowBase = (collateralBase * threshold * 10_000n) / BigInt(Math.round(targetHealth * 10_000)) / 10_000n - debtBase;
if (borrowBase <= 0n) throw new Error("already at or under the target health");
// USDC has 6 decimals and Aave's base currency 8, at about one dollar.
const borrow = borrowBase / 100n;
await send("borrow USDC", pool, `0xa415bcad${word(usdc)}${word(borrow)}${word(2n)}${word(0n)}${word(address)}`);

const after = await readAave(pool, address);
console.log(`Aave: ${after?.collateralUsd.toFixed(2)} USD collateral, ${after?.debtUsd.toFixed(2)} USD debt, health ${after?.health.toFixed(3)}`);
console.log("EVM guard for the mandate (the guardian repays from this address's USDC):");
console.log(JSON.stringify({ chain_id: EVM.chainId, pool, asset: usdc, address, max_amount: String(borrow) }, null, 2));
console.log(`signer: ${contract("signer")}`);
