"use client";

import { FAQ_ITEMS, FAQ_TESTNET_ITEM } from "./faq-items";
import { SectionHead } from "./Story";
import { Magnetic } from "@/components/fx/Magnetic";
import { Accordion } from "@/components/ui/Accordion";
import { ButtonLink } from "@/components/ui/Button";
import { isTestnet } from "@/lib/env";

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
            <ButtonLink href="/app" size="lg" className="!rounded-full px-8">
              Open the app
            </ButtonLink>
          </Magnetic>
          {isTestnet ? (
            <ButtonLink href="/app/shock" size="lg" variant="secondary" className="!rounded-full px-8">
              Try a market shock
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </section>
  );
}
