import { Faq, FinalCall } from "@/components/landing/Closing";
import { Hero } from "@/components/landing/Hero";
import { Agents, CascadeSlice, Earn, NearBento, ReplayHeadline, ReviewProof } from "@/components/landing/Sections";
import { Ledger, LiveProof, Primitives, ProtectStory } from "@/components/landing/Story";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <LiveProof />
      <Primitives />
      <ProtectStory />
      <CascadeSlice />
      <Ledger />
      <Earn />
      <ReviewProof />
      <NearBento />
      <ReplayHeadline />
      <Agents />
      <Faq />
      <FinalCall />
    </>
  );
}
