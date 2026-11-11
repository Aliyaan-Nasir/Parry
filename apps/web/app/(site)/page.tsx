import { Suspense, type ReactNode } from "react";
import { Faq, FinalCall } from "@/components/landing/Closing";
import { Hero } from "@/components/landing/Hero";
import { Agents, CascadeSlice, Earn, NearBento, ReplayHeadline, ReviewProof } from "@/components/landing/Sections";
import { Ledger, LiveProof, Primitives, ProtectStory } from "@/components/landing/Story";

/** Each section hydrates on its own, so the page never blocks on one long hydration task. */
const Part = ({ children }: { children: ReactNode }) => <Suspense>{children}</Suspense>;

export default function LandingPage() {
  return (
    <>
      <Part>
        <Hero />
      </Part>
      <Part>
        <LiveProof />
      </Part>
      <Part>
        <Primitives />
      </Part>
      <Part>
        <ProtectStory />
      </Part>
      <Part>
        <CascadeSlice />
      </Part>
      <Part>
        <Ledger />
      </Part>
      <Part>
        <Earn />
      </Part>
      <Part>
        <ReviewProof />
      </Part>
      <Part>
        <NearBento />
      </Part>
      <Part>
        <ReplayHeadline />
      </Part>
      <Part>
        <Agents />
      </Part>
      <Part>
        <Faq />
      </Part>
      <Part>
        <FinalCall />
      </Part>
    </>
  );
}
