import { Container } from "./Section";
import { ArrowRightIcon } from "./icons";
import { Mark } from "@/components/brand/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { isTestnet } from "@/lib/env";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="border-t border-line">
      <Container className="py-20 sm:py-28">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center" data-reveal>
          <Mark size={44} />
          <h2 id="cta-title" className="mt-6 font-display text-[36px] font-semibold leading-[1.08] tracking-[-0.02em] text-fg sm:text-[48px]">
            Set your guard. Get on with your day.
          </h2>
          <p className="mt-5 max-w-xl text-[17px] leading-8 text-muted">
            {isTestnet
              ? "Parry runs on NEAR testnet. Open the app, or move the test oracle price yourself and watch a live rescue."
              : "Open the app to protect a position or deposit into the vault."}
          </p>
          <div className="mt-9 grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap sm:justify-center">
            <ButtonLink href="/app" size="lg" trailingIcon={<ArrowRightIcon />}>
              Open the app
            </ButtonLink>
            {isTestnet ? (
              <ButtonLink href="/app/shock" size="lg" variant="secondary">
                Try a market shock
              </ButtonLink>
            ) : null}
          </div>
        </div>
      </Container>
    </section>
  );
}
