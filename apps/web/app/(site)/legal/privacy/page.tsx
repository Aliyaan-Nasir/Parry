import type { Metadata } from "next";
import Link from "next/link";
import { LegalHeader } from "@/components/site/LegalHeader";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Parry stores, what is public on chain, and what stays sealed in the enclave.",
};

export default function PrivacyPage() {
  return (
    <>
      <LegalHeader title="Privacy">Parry keeps as little as it can, and never sells or shares what it keeps.</LegalHeader>

      <h2>What the service stores</h2>
      <ul>
        <li>
          <strong>Account ids</strong>: the NEAR accounts you connect, so Parry knows which positions to watch.
        </li>
        <li>
          <strong>Alert settings</strong>: which alerts you want and where they should go.
        </li>
        <li>
          <strong>Push subscriptions</strong>: the browser endpoint used to deliver notifications, if you turn them on.
        </li>
      </ul>
      <p>Nothing else: no names, no analytics profiles, no advertising identifiers.</p>

      <h2>What is public by nature</h2>
      <p>
        Blockchains are public. Your account contract, your positions on Rhea and Hyperliquid, every guardian action and the hash
        of each AI review are visible on their chains to anyone.
      </p>

      <h2>What stays private</h2>
      <p>
        Your thresholds and strategy are sealed to the guardian&apos;s enclave. Parry&apos;s own servers cannot read them, so
        nobody knows when Parry will act. On mainnet, rescue swaps go through NEAR Confidential Intents, so the route stays
        private too.
      </p>

      <h2>No tracking</h2>
      <p>
        Parry uses no analytics, no tracking pixels and no third party advertising. See the{" "}
        <Link href="/legal/cookies">cookie notice</Link> for the single preference your browser keeps.
      </p>

      <h2>Your control</h2>
      <p>
        You can turn alerts off at any time, and remove a push subscription by blocking notifications for this site in your
        browser.
      </p>
    </>
  );
}
