import proofs from "@/lib/proofs.generated.json";
import { FAQ_ITEMS, FAQ_TESTNET_ITEM } from "./faq-items";
import { SectionHead } from "./SectionHead";
import { Magnetic } from "@/components/fx/Magnetic";
import { Marquee } from "@/components/fx/Marquee";
import { Rise } from "@/components/fx/Reveal";
import { Spotlight } from "@/components/fx/Spotlight";
import { Terminal } from "@/components/fx/Terminal";
import { Accordion } from "@/components/ui/Accordion";
import { ButtonLink } from "@/components/ui/Button";
import { isTestnet } from "@/lib/env";

// The landing's static sections, rendered on the server: only their small interactive parts
// (reveals, the accordion, the terminal, the magnetic button) hydrate in the browser.

const ASSETS = ["NEAR", "wNEAR", "LiNEAR", "USDC", "Rhea Lending", "Rhea Exchange", "Hyperliquid", "Aave", "Base", "NEAR Intents", "OutLayer", "NEAR AI Cloud"];
const PRIMITIVES = [
  "Chain Signatures",
  "Universal accounts",
  "Global contracts",
  "Passkeys on chain",
  "Gas keys",
  "ML-DSA-65 keys",
  "Meta transactions",
  "MPC transaction checks",
  "x402 on NEAR",
  "Agent Market",
  "NEP-413 sign-in",
  "Verifiable AI",
];

export function Primitives() {
  const word = (w: string) => <span className="display-sm whitespace-nowrap text-2xl text-fg/70 sm:text-3xl">{w}</span>;
  return (
    <section className="py-16 sm:py-20" aria-label="What Parry runs on">
      <p className="label mb-8 text-center">Built from the assets, venues and primitives it runs on</p>
      <Marquee label="Assets and venues" items={ASSETS.map(word)} seconds={70} />
      <Marquee label="NEAR primitives" items={PRIMITIVES.map(word)} seconds={80} reverse className="mt-5" />
    </section>
  );
}

/** What the guardian can and cannot do, as a two-column ledger. */
export function Ledger() {
  const can = ["Repay your loan from your reserve", "Add collateral from your reserve", "Deleverage atomically, all or nothing", "Reduce or hedge a Hyperliquid position", "Repay your Aave loan on Base"];
  const cannot = ["Move money out of your account", "Act outside your mandate", "Swap its own signing key", "Stop you from revoking or overriding it", "Act without a reviewed, signed plan"];
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead title={["It can only protect.", "It can never take."]} lead="The guardian's powers are written into your own account contract. It acts under your mandate, and you can revoke or override it at any moment." />
        <div className="mt-14 grid border-t border-line sm:grid-cols-2">
          <Rise className="border-b border-line py-8 sm:border-r sm:pr-10">
            <div className="label">It can</div>
            <ul className="mt-5 space-y-4">
              {can.map((c) => (
                <li key={c} className="text-xl text-fg">
                  {c}
                </li>
              ))}
            </ul>
          </Rise>
          <Rise className="border-b border-line py-8 sm:pl-10" delay={120}>
            <div className="label">It never can</div>
            <ul className="mt-5 space-y-4">
              {cannot.map((c) => (
                <li key={c} className="struck text-xl text-fg/60">
                  {c}
                </li>
              ))}
            </ul>
          </Rise>
        </div>
      </div>
    </section>
  );
}

/** Line art per primitive, drawn with one stroke so it can draw itself in. */
const ART: Record<string, string> = {
  "NEP-655 universal accounts and global contracts": "M10 50 h60 M40 20 v60 M20 30 l40 40 M60 30 l-40 40",
  "Chain Signatures": "M15 60 q25 -50 50 0 t50 0 M15 60 h100",
  "MPC foreign-transaction verification": "M20 40 l20 20 l40 -40 M20 70 h80",
  "OutLayer TEE": "M30 20 h60 v60 h-60 z M45 35 h30 v30 h-30 z",
  "NEAR AI Cloud verifiable models": "M20 70 q40 -70 80 0 M60 20 v60",
  "Rhea lending and exchange": "M20 70 v-30 M45 70 v-45 M70 70 v-20 M95 70 v-50",
  "x402 on NEAR": "M20 50 h70 l-15 -15 M90 50 l-15 15",
  "Gas keys (NEP-611)": "M25 50 a15 15 0 1 1 30 0 a15 15 0 1 1 -30 0 M55 50 h50 M90 50 v15 M100 50 v10",
  "Post-quantum keys (ML-DSA-65)": "M20 20 h20 v20 h-20 z M50 20 h20 v20 h-20 z M80 20 h20 v20 h-20 z M20 50 h20 v20 h-20 z M50 50 h20 v20 h-20 z M80 50 h20 v20 h-20 z",
};

export function NearBento() {
  const items = proofs.items;
  return (
    <section id="near" className="scroll-mt-24 py-24 sm:py-32">
      <div className="mx-auto max-w-[1180px] px-4 sm:px-6">
        <SectionHead title={["Built from parts", "only NEAR has."]} lead="Each guarantee comes from a NEAR primitive, and each links to a transaction on testnet that shows it working." />
        <div className="ruled mt-14 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it, i) => (
            <Spotlight key={it.name} fill className="p-6 sm:p-7">
              <Rise delay={(i % 3) * 80}>
                <svg viewBox="0 0 120 90" className="draw-in h-16 w-24" aria-hidden="true">
                  <path d={ART[it.name] ?? "M20 45 h80"} pathLength={1} style={{ stroke: "var(--parry-brass-fill)" }} fill="none" strokeWidth={1.5} />
                </svg>
                <h3 className="mt-5 text-lg text-fg">{it.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{it.what}</p>
                {it.links.length ? (
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                    {it.links.slice(0, 3).map((l) => (
                      <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="text-brass underline-offset-4 hover:underline">
                        {l.label}
                      </a>
                    ))}
                  </div>
                ) : null}
              </Rise>
            </Spotlight>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Agents() {
  return (
    <section id="agents" className="scroll-mt-24 py-24 sm:py-32">
      <div className="mx-auto grid max-w-[1180px] gap-12 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <SectionHead
          title={["Agents can", "use it too."]}
          lead="Everything a person sees, an agent can read through the MCP server: positions, risk, the guardian's log and its proofs, the vault. Write tools are capped and testnet only, and risk checks can be paid per call over x402 on NEAR."
        />
        <Terminal
          title="claude"
          lines={[
            { kind: "cmd", text: "claude mcp add parry -- npx -y @parry/mcp" },
            { kind: "out", text: "Added stdio MCP server parry" },
            { kind: "comment", text: "# ask the agent: is alice.near at risk?" },
            { kind: "cmd", text: "parry.risk_check({ account: \"alice.near\" })" },
            { kind: "out", text: "health 1.32 (caution), liquidation at $2.79" },
            { kind: "out", text: "liquidation in 24 h: 0.4 %, median time beyond 30 days" },
            { kind: "out", text: "score 11 of 100, Tremor index 98 % a year (stressed)" },
          ]}
        />
      </div>
    </section>
  );
}

export function Faq() {
  const items = isTestnet ? [FAQ_TESTNET_ITEM, ...FAQ_ITEMS] : FAQ_ITEMS;
  return (
    <section id="faq" className="scroll-mt-24 py-24 sm:py-32">
      <div className="mx-auto grid max-w-[1180px] gap-12 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
        <SectionHead title={["Plain", "answers."]} lead="What Parry can and cannot do, in a few lines each." />
        <Accordion items={items} />
      </div>
    </section>
  );
}

export function FinalCall() {
  return (
    <section className="grain relative overflow-hidden py-28 sm:py-40">
      <div aria-hidden="true" className="glow-brass absolute left-1/2 top-1/2 -z-10 h-[420px] w-[900px] -translate-x-1/2 -translate-y-1/2" />
      <div className="mx-auto max-w-[1180px] px-4 text-center sm:px-6">
        <SectionHead center title={["Set your guard.", "Get on with your day."]} lead={isTestnet ? "Parry runs on NEAR testnet. Open the app, or move the test oracle yourself and watch a live rescue." : "Open the app to protect a position or deposit into the vault."} />
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Magnetic>
            <ButtonLink prefetch={false} href="/app" size="lg" className="!rounded-full px-8">
              Open the app
            </ButtonLink>
          </Magnetic>
          {isTestnet ? (
            <ButtonLink prefetch={false} href="/app/shock" size="lg" variant="secondary" className="!rounded-full px-8">
              Try a market shock
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </section>
  );
}
