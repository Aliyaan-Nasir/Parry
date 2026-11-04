import { Container } from "./Section";
import { HeroDeflection } from "./HeroDeflection";
import { ArrowDownIcon, ArrowRightIcon } from "./icons";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink, buttonClasses } from "@/components/ui/Button";
import { isTestnet, networkLabel } from "@/lib/env";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative">
      <Container className="grid items-center gap-12 pb-16 pt-12 sm:pt-16 lg:grid-cols-12 lg:gap-10 lg:pb-24 lg:pt-20">
        <div className="lg:col-span-6 xl:col-span-5">
          <Badge tone="brass" variant="soft" size="md">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {isTestnet ? `Live on NEAR ${networkLabel.toLowerCase()}` : "Live on NEAR"}
          </Badge>
          <h1
            id="hero-title"
            className="mt-6 font-display text-[44px] font-semibold leading-[1.02] tracking-[-0.025em] text-fg sm:text-[60px] lg:text-[64px]"
          >
            Liquidation, turned aside.
          </h1>
          <p className="mt-6 max-w-[34rem] text-lg leading-8 text-muted">
            Parry keeps your money from getting liquidated, and lets you earn without liquidation risk at all. It sees trouble hours
            before it comes, and a guardian that can only protect steps in on its own.
          </p>
          <div className="mt-9 grid gap-3 sm:flex sm:flex-wrap sm:items-center">
            <ButtonLink href="/app" size="lg" trailingIcon={<ArrowRightIcon />}>
              Open the app
            </ButtonLink>
            <a href="#protect" className={buttonClasses({ variant: "ghost", size: "lg" })}>
              How it works
              <ArrowDownIcon />
            </a>
          </div>
        </div>
        <div className="lg:col-span-6 xl:col-span-7">
          <div className="overflow-hidden rounded-2xl border border-line bg-raised">
            <HeroDeflection />
            <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-5 py-3.5 text-[12px] font-medium text-muted sm:px-6" aria-label="Legend">
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="h-0.5 w-5 rounded-full bg-fg" />
                Health
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="h-0.5 w-5 rounded-full bg-safe" />
                After Parry steps in
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="w-5 border-t-2 border-dotted border-muted" />
                Projected without Parry
              </li>
            </ul>
          </div>
        </div>
      </Container>
    </section>
  );
}
