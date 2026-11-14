import type { Metadata } from "next";
import { PublicShell } from "@/components/public/PublicShell";
import { ReplayView } from "@/components/public/ReplayView";

export const metadata: Metadata = {
  title: "Crash replay",
  description: "NEAR's worst historical crashes and sharpest rallies replayed through Parry's risk model, guardian and vault: the hours of warning, each step, health with and without Parry, and the vault's short through every spike.",
};

export default function ReplayPage() {
  return (
    <PublicShell title="Replayed through real crashes and spikes." lead="Real hourly NEAR prices from Binance, run through Parry's own risk model, guardian logic and vault rules: how many hours of warning it gave, what the guardian would have done step by step, health with and without it, and how close the vault's short came to liquidation in NEAR's sharpest rallies. Every number is computed by pnpm replay.">
      <ReplayView />
    </PublicShell>
  );
}
