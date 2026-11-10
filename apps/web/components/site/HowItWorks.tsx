import { Container } from "./Section";

const STEPS = [
  {
    tag: "Risk model",
    title: "It watches every position",
    line: "Each position gets a score from 0 to 100, a chance of liquidation within a day and a time to liquidation, hours before trouble comes.",
  },
  {
    tag: "OutLayer TEE",
    title: "It plans in a sealed enclave",
    line: "When your sealed thresholds are crossed, the guardian plans a rescue inside a TEE, signing with a key bound to its exact build.",
  },
  {
    tag: "NEAR AI Cloud",
    title: "A verifiable model reviews it",
    line: "A model running in a TEE checks the plan and signs its verdict. The review's hash rides on chain with the action.",
  },
  {
    tag: "Mandate on chain",
    title: "Your account has the last word",
    line: "The account contract accepts only protective actions within your caps. A transfer out does not exist for the guardian.",
  },
] as const;

/** The guardian in four steps, right under the live figures: what happens between a fall and a rescue. */
export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20 border-t border-line">
      <Container className="py-20 sm:py-24">
        <div className="grid gap-4 lg:grid-cols-12 lg:items-end" data-reveal>
          <div className="lg:col-span-7">
            <p className="num flex items-center gap-3 text-xs font-medium uppercase tracking-[0.14em] text-brass">
              <span aria-hidden="true" className="h-px w-8 bg-brass/60" />
              <span>How it works</span>
            </p>
            <h2 id="how-title" className="mt-5 font-display text-[34px] font-semibold leading-[1.08] tracking-[-0.02em] text-fg sm:text-[44px]">
              Watch, plan, review, act.
            </h2>
          </div>
          <p className="max-w-xl text-[17px] leading-8 text-muted lg:col-span-5">
            Three independent checks stand between a falling price and your collateral: an enclave, a verifiable model and your own account.
          </p>
        </div>
        <ol className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4" data-reveal-stagger>
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-3 bg-raised p-6">
              <div className="flex items-center justify-between gap-3">
                <span className="num text-[13px] font-medium text-muted">{String(i + 1).padStart(2, "0")}</span>
                <span className="num rounded-full border border-line px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-brass">{s.tag}</span>
              </div>
              <h3 className="mt-3 text-[17px] font-semibold tracking-[-0.01em] text-fg">{s.title}</h3>
              <p className="text-sm leading-6 text-muted">{s.line}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
