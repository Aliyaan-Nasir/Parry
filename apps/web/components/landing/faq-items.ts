import type { AccordionItem } from "@/components/ui/Accordion";

export const FAQ_ITEMS: AccordionItem[] = [
  {
    id: "move-money",
    title: "Can Parry move my money out?",
    content:
      "No. The guardian can only repay, add collateral, deleverage atomically, reduce or hedge a Hyperliquid position, or repay the EVM loan. Your account contract enforces that on chain, and you can revoke or override the guardian at any moment.",
  },
  {
    id: "mandate",
    title: "What is the mandate?",
    content:
      "The rules you give the guardian: thresholds, a rescue reserve, a daily cap, the actions it may take, and an expiry. The account contract refuses anything outside them.",
  },
  {
    id: "justified",
    title: "How do I know a rescue was justified?",
    content:
      "Before every rescue, a verifiable model on NEAR AI Cloud, running in a TEE, reviews the plan and signs its reasoning. The hash goes on chain with the action, so anyone can check it.",
  },
  {
    id: "who-knows",
    title: "Who can tell when Parry will act?",
    content:
      "Nobody, not even Parry's servers: your thresholds and strategy are sealed to the enclave. Your positions on Rhea and Hyperliquid are public on their chains; what stays private is the trigger, the strategy and the route.",
  },
  {
    id: "vault",
    title: "Can I be liquidated in the vault?",
    content:
      "No. Depositors hold vault shares, not leveraged positions. The vault stakes NEAR with LiNEAR and shorts the matching NEAR perp on Hyperliquid, 90% hedged by default. It publishes an on-chain risk score, pauses deposits when that score is high, and publishes a proof of reserves attested by the enclave.",
  },
  {
    id: "seed",
    title: "Do I need a seed phrase or gas?",
    content: "No. Protected accounts are NEAR universal accounts with a passkey owner: no seed phrase and no gas.",
  },
  {
    id: "certificate",
    title: "What does a health certificate prove?",
    content:
      "That the guardian enclave read your position on chain at a stated block and found its health at or above the threshold you named, for one named reader, until the expiry. It does not reveal amounts, collateral, debt or the actual health, and it says nothing about the position after that block.",
  },
  {
    id: "insurance",
    title: "What does the vault's insurance fund cost?",
    content:
      "10% of the vault's positive yield, staking plus funding, goes to the fund. It pays only for named losses: a streak of negative funding, hedge slippage beyond the band, and Hyperliquid margin top-ups under stress, each with per-payout and per-day caps set in the contract.",
  },
  {
    id: "agents",
    title: "Can AI agents use Parry?",
    content: "Yes. Agents can buy risk checks over x402 on NEAR and use Parry through an MCP server.",
  },
];

export const FAQ_TESTNET_ITEM: AccordionItem = {
  id: "mainnet",
  title: "Is Parry on mainnet?",
  content:
    "Not yet. Parry runs on NEAR testnet. The code is ready for mainnet, but nothing is deployed there. On testnet, anyone can move the test oracle price, within limits, to watch a live rescue.",
};

