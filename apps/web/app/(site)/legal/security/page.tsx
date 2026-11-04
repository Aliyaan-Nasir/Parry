import type { Metadata } from "next";
import { LegalHeader } from "@/components/site/LegalHeader";
import { repoUrl } from "@/lib/env";

export const metadata: Metadata = {
  title: "Security",
  description: "How to report a vulnerability in Parry, and the design limits that keep your funds safe.",
};

export default function SecurityPage() {
  const advisory = repoUrl ? `${repoUrl}/security/advisories/new` : null;
  return (
    <>
      <LegalHeader title="Security">Found a vulnerability? Thank you. Please tell us privately first.</LegalHeader>

      <h2>How to report</h2>
      <p>
        Open a private security advisory on the GitHub repository
        {advisory ? (
          <>
            {" "}
            (
            <a href={advisory} target="_blank" rel="noopener noreferrer">
              new advisory
            </a>
            )
          </>
        ) : null}
        . Please do not open a public issue for a vulnerability.
      </p>
      <p>A useful report includes:</p>
      <ul>
        <li>the affected part: an account or vault contract, the guardian, the API or this site;</li>
        <li>the steps to reproduce it, ideally on testnet;</li>
        <li>what an attacker could gain, and what you think the fix is.</li>
      </ul>

      <h2>Ground rules</h2>
      <ul>
        <li>Test against your own accounts only, and never access other people&apos;s data.</li>
        <li>Do not degrade testnet services for others.</li>
        <li>Give us a fair chance to fix the issue before you disclose it.</li>
      </ul>

      <h2>Limits built into the design</h2>
      <ul>
        <li>The guardian can only take protective actions. The account contract refuses any transfer out.</li>
        <li>Every action stays within the owner&apos;s mandate, and the owner can revoke or override at any moment.</li>
        <li>The guardian runs in a TEE, with a signing key bound to its exact build.</li>
        <li>Each rescue carries the hash of a signed, verifiable AI review on chain.</li>
      </ul>
    </>
  );
}
