import type { Metadata } from "next";
import { Suspense } from "react";
import { PublicShell } from "@/components/public/PublicShell";
import { VerifyView } from "@/components/public/VerifyView";

export const metadata: Metadata = {
  title: "Verify",
  description: "Re-check a Parry guardian decision, a private health certificate or a transaction: every signature and the hash on chain.",
};

export default function VerifyPage() {
  return (
    <PublicShell title="Verify, don't trust." lead="Paste a guardian decision id, a health certificate hash or a NEAR transaction hash. Every signature is checked again here: the model's TEE signature and its hardware attestation, the enclave's signature, and the hash recorded on chain.">
      <Suspense>
        <VerifyView />
      </Suspense>
    </PublicShell>
  );
}
