import type { Metadata } from "next";
import { Suspense } from "react";
import { CheckView } from "@/components/public/CheckView";
import { PublicShell } from "@/components/public/PublicShell";

export const metadata: Metadata = {
  title: "Check any account",
  description: "Liquidation risk for any NEAR account's Rhea position: health, liquidation price, the chance of liquidation within a day and the time left. No sign-in.",
};

export default function CheckPage() {
  return (
    <PublicShell title="Check any account." lead="Liquidation risk for any NEAR account's lending position on Rhea, read live: health, liquidation price, the chance of liquidation within a day, and the hours left at today's pace. No sign-in, and the link is shareable.">
      <Suspense>
        <CheckView />
      </Suspense>
    </PublicShell>
  );
}
