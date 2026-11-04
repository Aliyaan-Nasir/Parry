import type { Metadata } from "next";
import Link from "next/link";
import { LegalHeader } from "@/components/site/LegalHeader";
import { repoUrl } from "@/lib/env";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms for using Parry: testnet software, provided as is, and never in custody of your funds.",
};

export default function TermsPage() {
  return (
    <>
      <LegalHeader title="Terms">Short and plain. By using Parry you accept these terms.</LegalHeader>

      <h2>Testnet software, provided as is</h2>
      <p>
        Parry runs on NEAR testnet. Testnet tokens have no value, and testnet networks, contracts and data can be reset or changed
        at any time. Parry is provided as is, without warranties of any kind, express or implied, including fitness for a
        particular purpose. Use it to learn and to test, not to protect real money.
      </p>

      <h2>No custody</h2>
      <p>
        Parry never holds your funds. Your protected account is your own contract, owned by you. The guardian can only take the
        protective actions your mandate allows, it can never move money out of your account, and you can revoke or override it at
        any moment.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>You decide the mandate: thresholds, rescue reserve, daily cap, allowed actions and expiry.</li>
        <li>A rescue can fail or arrive too late, for example when markets move faster than any guardian can act.</li>
        <li>Risk scores and predictions are estimates, not promises.</li>
      </ul>

      <h2>Liability</h2>
      <p>
        To the fullest extent the law allows, the authors of Parry are not liable for any loss arising from using it, including
        losses from liquidations, failed rescues, outages or bugs.
      </p>

      <h2>Open source</h2>
      <p>
        Parry is released under the MIT License
        {repoUrl ? (
          <>
            ; the source is on{" "}
            <a href={repoUrl} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            .
          </>
        ) : (
          "."
        )}{" "}
        See also the <Link href="/legal/privacy">privacy notice</Link> and the <Link href="/legal/security">security policy</Link>.
      </p>

      <h2>Changes</h2>
      <p>These terms may change as Parry develops. The version on this page is the one that applies.</p>
    </>
  );
}
