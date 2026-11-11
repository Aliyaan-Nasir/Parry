import type { Metadata } from "next";
import { PublicShell } from "@/components/public/PublicShell";
import { ReplayView } from "@/components/public/ReplayView";

export const metadata: Metadata = {
  title: "Crash replay",
  description: "NEAR's worst historical crashes replayed through Parry's risk model and guardian: the hours of warning, each step, and health with and without Parry.",
};

export default function ReplayPage() {
  return (
    <PublicShell title="Replayed through real crashes." lead="Real hourly NEAR prices from Binance, run through Parry's own risk model and guardian logic: how many hours of warning it gave, what the guardian would have done step by step, and health with and without it. The vault runs through the same crashes. Every number is computed by pnpm replay.">
      <ReplayView />
    </PublicShell>
  );
}
