import type { ReactNode } from "react";
import { Section } from "./Section";
import {
  ChipIcon,
  CheckIcon,
  CrossIcon,
  EyeIcon,
  LanesIcon,
  LatticeIcon,
  LockIcon,
  MarketIcon,
  PasskeyIcon,
  ReceiptIcon,
  RelayIcon,
  ReviewIcon,
  ShieldRouteIcon,
  SignatureIcon,
  StackIcon,
  VerifiedLinkIcon,
} from "./icons";
import { TierBadge } from "@/components/ui/TierBadge";
import { TIERS } from "@/lib/risk";
import { cn } from "@/lib/cn";

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-line bg-raised", className)}>{children}</div>;
}

function PanelLabel({ children }: { children: ReactNode }) {
  return <p className="num text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{children}</p>;
}

const VENUES = [
  { name: "Rhea", where: "Lending on NEAR" },
  { name: "Hyperliquid", where: "Perps" },
  { name: "Aave", where: "On an EVM chain, through NEAR Chain Signatures" },
] as const;

const SIGNALS = [
  { name: "Liquidation probability", detail: "The chance of liquidation within the next 24 hours." },
  { name: "Time to liquidation", detail: "How long the position has at the current pace." },
  { name: "Cascade pressure", detail: "How much nearby liquidations could push the price further." },
  { name: "Tremor index", detail: "Volatility measured across several windows at once." },
  { name: "Risk score", detail: "All of it in one number from 0 to 100, in four tiers." },
] as const;

export function ProtectSection() {
  return (
    <Section
      id="protect"
      index="01"
      eyebrow="Protect"
      title="Trouble, seen hours before it comes."
      lead="Parry watches your leveraged positions, predicts where each one is heading, and a guardian steps in on its own before liquidation can land."
    >
      <div className="grid gap-5">
        <Panel>
          <div className="border-b border-line px-5 py-4 sm:px-6">
            <PanelLabel>Watched positions</PanelLabel>
          </div>
          <ul className="divide-y divide-line" data-reveal-stagger>
            {VENUES.map((v) => (
              <li key={v.name} className="flex flex-col gap-0.5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <span className="text-[15px] font-semibold text-fg">{v.name}</span>
                <span className="text-sm text-muted">{v.where}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
            <PanelLabel>What it predicts</PanelLabel>
            <div className="flex flex-wrap gap-1.5">
              {TIERS.map((t) => (
                <TierBadge key={t} tier={t} />
              ))}
            </div>
          </div>
          <dl className="grid sm:grid-cols-2" data-reveal-stagger>
            {SIGNALS.map((s, i) => (
              <div
                key={s.name}
                className={cn(
                  "border-line px-5 py-4 sm:px-6",
                  i > 0 && "border-t",
                  i === 1 && "sm:border-t-0",
                  i % 2 === 1 && "sm:border-l",
                  i === SIGNALS.length - 1 && "sm:col-span-2 sm:border-l-0",
                )}
              >
                <dt className="text-[15px] font-semibold text-fg">{s.name}</dt>
                <dd className="mt-1 text-sm leading-6 text-muted">{s.detail}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </Section>
  );
}

function FlowStep({ title, detail, accent = false }: { title: ReactNode; detail: ReactNode; accent?: boolean }) {
  return (
    <div className={cn("rounded-xl border px-5 py-4", accent ? "border-brass/50 bg-brass-soft" : "border-line bg-raised")}>
      <p className="text-[15px] font-semibold text-fg">{title}</p>
      <p className="mt-1 text-sm leading-6 text-muted">{detail}</p>
    </div>
  );
}

function FlowJoin() {
  return (
    <div aria-hidden="true" className="flex justify-center py-1.5">
      <span className="h-6 w-px bg-line-strong" />
    </div>
  );
}

const EARN_POINTS = [
  ["No liquidation for depositors", "You hold vault shares, not a leveraged position."],
  ["A public risk score", "The vault publishes its risk score on chain and pauses deposits when it runs high."],
  ["Proof of reserves", "Attested by the enclave, so the backing can be checked, not trusted."],
] as const;

export function EarnSection() {
  return (
    <Section
      id="earn"
      index="02"
      eyebrow="Earn"
      title="Earn without liquidation risk at all."
      lead="A delta-neutral vault for NEAR. Each share holds its dollar value while it earns staking yield plus funding, and depositors are never liquidated."
      aside={
        <ul className="grid gap-4" data-reveal-stagger>
          {EARN_POINTS.map(([title, detail]) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 text-safe">
                <CheckIcon />
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-fg">{title}</span>
                <span className="mt-1 block text-sm leading-6 text-muted">{detail}</span>
              </span>
            </li>
          ))}
        </ul>
      }
    >
      <ol className="list-none p-0" data-reveal-stagger aria-label="How the vault works">
        <li>
          <FlowStep title="You deposit NEAR" detail="Into the vault contract, for vault shares." />
          <FlowJoin />
        </li>
        <li className="grid gap-3 sm:grid-cols-2">
          <FlowStep title="Staked with LiNEAR" detail="The deposit earns NEAR staking yield." />
          <FlowStep
            title="Short NEAR perp on Hyperliquid"
            detail="Opened from the vault's own Chain Signatures address, 90% hedged by default, earning funding."
          />
        </li>
        <li>
          <FlowJoin />
          <FlowStep accent title="A share that holds its dollar value" detail="Staking yield plus funding, with the price exposure hedged away." />
        </li>
      </ol>
    </Section>
  );
}

const CAN = [
  "Repay your loan",
  "Add collateral",
  "Deleverage atomically",
  "Reduce or hedge a Hyperliquid position",
  "Repay the EVM loan",
] as const;

const NEVER = [
  "Move money out of your account",
  "Act outside your mandate",
  "Swap its own signing key",
  "Stop you from revoking or overriding it",
] as const;

const MANDATE = ["Thresholds", "Rescue reserve", "Daily cap", "Allowed actions", "Expiry"] as const;

export function GuardianSection() {
  return (
    <Section
      id="guardian"
      index="03"
      eyebrow="The guardian"
      title="It can only protect. It can never take."
      lead="The guardian's powers are written into your account contract. It acts under your mandate, and you can revoke or override it at any moment."
    >
      <div className="grid gap-5">
        <Panel className="grid overflow-hidden sm:grid-cols-2">
          <div className="p-5 sm:p-6">
            <PanelLabel>Can do</PanelLabel>
            <ul className="mt-4 grid gap-3" data-reveal-stagger>
              {CAN.map((c) => (
                <li key={c} className="flex items-start gap-3 text-[15px] text-fg">
                  <span className="mt-px text-safe">
                    <CheckIcon />
                  </span>
                  {c}
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-line bg-surface p-5 sm:border-l sm:border-t-0 sm:p-6">
            <PanelLabel>Can never</PanelLabel>
            <ul className="mt-4 grid gap-3" data-reveal-stagger>
              {NEVER.map((c) => (
                <li key={c} className="flex items-start gap-3 text-[15px] text-fg">
                  <span className="mt-px text-critical">
                    <CrossIcon />
                  </span>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </Panel>
        <div className="grid gap-5 md:grid-cols-2">
          <Panel className="p-5 sm:p-6">
            <PanelLabel>Your mandate</PanelLabel>
            <p className="mt-3 text-sm leading-6 text-muted">The account contract enforces it on chain and refuses anything outside it.</p>
            <ul className="mt-4 flex flex-wrap gap-2" data-reveal-stagger>
              {MANDATE.map((m) => (
                <li key={m} className="rounded-full border border-line px-3 py-1 text-[13px] font-semibold text-fg">
                  {m}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel className="p-5 sm:p-6">
            <div className="flex items-center gap-3 text-brass">
              <ChipIcon />
              <PanelLabel>Runs in a TEE</PanelLabel>
            </div>
            <p className="mt-3 text-[15px] leading-7 text-fg">
              The guardian runs on OutLayer in Intel TDX. Its signing key is bound to its exact build, so the key cannot be swapped.
            </p>
          </Panel>
        </div>
      </div>
    </Section>
  );
}

const REVIEW_STEPS = [
  { title: "A rescue is planned", detail: "The guardian drafts the protective action it intends to take." },
  { title: "A verifiable model reviews it", detail: "A NEAR AI Cloud model, running in a TEE, checks the plan before anything moves." },
  { title: "The reasoning is signed", detail: "The model signs its reasoning for that exact plan." },
  { title: "The hash goes on chain", detail: "It is recorded with the action. Anyone can verify it." },
] as const;

export function ReviewSection() {
  return (
    <Section
      id="review"
      index="04"
      eyebrow="AI review"
      title="A second opinion before every rescue."
      lead="No rescue runs on the guardian's word alone. Each plan is reviewed by a verifiable model first, and the proof travels with the action."
    >
      <ol className="relative grid list-none gap-0 p-0" data-reveal-stagger>
        {REVIEW_STEPS.map((s, i) => (
          <li key={s.title} className="relative grid grid-cols-[2.5rem_1fr] gap-4 pb-8 last:pb-0">
            {i < REVIEW_STEPS.length - 1 ? (
              <span aria-hidden="true" className="absolute left-5 top-10 bottom-0 w-px -translate-x-1/2 bg-line-strong" />
            ) : null}
            <span className="num relative z-10 flex size-10 items-center justify-center rounded-full border border-line bg-raised text-sm font-medium text-brass">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div className="pt-1.5">
              <p className="text-[17px] font-semibold text-fg">{s.title}</p>
              <p className="mt-1 text-[15px] leading-7 text-muted">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function PrivacySection() {
  return (
    <Section
      id="privacy"
      index="05"
      eyebrow="Privacy"
      title="Nobody knows when Parry will act."
      lead="Not liquidation hunters, and not even Parry's own servers."
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Panel className="p-5 sm:p-6">
          <div className="flex items-center gap-3 text-brass">
            <LockIcon />
            <PanelLabel>Sealed to the enclave</PanelLabel>
          </div>
          <p className="mt-3 text-[15px] leading-7 text-fg">
            Your thresholds and strategy are sealed inside the enclave. No one outside it can read when or how Parry will step in.
          </p>
        </Panel>
        <Panel className="p-5 sm:p-6">
          <div className="flex items-center gap-3 text-brass">
            <ShieldRouteIcon />
            <PanelLabel>Out of sight</PanelLabel>
          </div>
          <p className="mt-3 text-[15px] leading-7 text-fg">
            On mainnet, rescue swaps go through NEAR Confidential Intents, so liquidation hunters cannot watch the rescue happen.
          </p>
        </Panel>
        <div className="rounded-xl border border-dashed border-line-strong p-5 sm:p-6 md:col-span-2" data-reveal>
          <div className="flex items-center gap-3 text-muted">
            <EyeIcon />
            <PanelLabel>The honest limit</PanelLabel>
          </div>
          <p className="mt-3 text-[15px] leading-7 text-fg">
            Positions on Rhea and Hyperliquid are public on their chains. What stays private is the trigger, the strategy and the
            route.
          </p>
        </div>
      </div>
    </Section>
  );
}

const PRIMITIVES = [
  {
    name: "Universal accounts and global contracts",
    line: "Every protected account is a NEP-655 universal account running one global contract: created in a single call, upgraded only by its owner.",
    Icon: StackIcon,
  },
  { name: "Passkeys on chain", line: "A passkey can own the account. The contract checks its P-256 signature itself: no seed phrase, no wallet.", Icon: PasskeyIcon },
  { name: "Chain Signatures", line: "The account signs Hyperliquid orders and EVM repays through the MPC network, inside an on-chain guard.", Icon: SignatureIcon },
  { name: "OutLayer TEE", line: "The guardian runs in Intel TDX with a key bound to its exact build.", Icon: ChipIcon },
  { name: "NEAR AI Cloud", line: "A verifiable model in a TEE reviews and signs off every rescue plan.", Icon: ReviewIcon },
  { name: "NEP-366 relaying", line: "The relayer pays the gas, so passkey owners never need NEAR to act.", Icon: RelayIcon },
  { name: "Gas keys", line: "Parry's services send on parallel nonce lanes, so a rescue never queues.", Icon: LanesIcon },
  { name: "MPC transaction checks", line: "After an Aave repay on Base, the MPC network reads it on that chain and signs what it found, so NEAR knows the rescue landed.", Icon: VerifiedLinkIcon },
  { name: "NEAR Intents", line: "Rescue swaps compare Rhea with 1Click quotes; on mainnet a confidential reserve on the Intents Agent API refills the account privately.", Icon: ShieldRouteIcon },
  { name: "x402 on NEAR", line: "Anyone, agents included, can buy a risk check with one payment over HTTP.", Icon: ReceiptIcon },
  { name: "Post-quantum keys", line: "The treasury that keeps Parry's services funded signs with an ML-DSA-65 key.", Icon: LatticeIcon },
  { name: "Agent Market", line: "Parry's risk desk answers hires on NEAR's Agent Market with a report for any account.", Icon: MarketIcon },
] as const;

export function OnlyOnNearSection() {
  return (
    <Section
      id="near"
      index="06"
      eyebrow="Only on NEAR"
      title="Built from parts only NEAR has."
      lead="Each piece of Parry leans on a NEAR primitive. Together they make protection that is automatic, private and checkable."
    >
      <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2" data-reveal-stagger>
        {PRIMITIVES.map(({ name, line, Icon }, i) => (
          <li key={name} className={cn("flex gap-4 bg-raised p-5", PRIMITIVES.length % 2 === 1 && i === PRIMITIVES.length - 1 && "sm:col-span-2")}>
            <span className="mt-0.5 text-brass">
              <Icon />
            </span>
            <span>
              <span className="block text-[15px] font-semibold text-fg">{name}</span>
              <span className="mt-1 block text-sm leading-6 text-muted">{line}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
