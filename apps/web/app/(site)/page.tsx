import { Faq } from "@/components/site/Faq";
import { FinalCta } from "@/components/site/FinalCta";
import { Hero } from "@/components/site/Hero";
import { LiveStats } from "@/components/site/LiveStats";
import { ScrollScenes } from "@/components/site/ScrollScenes";
import {
  EarnSection,
  GuardianSection,
  OnlyOnNearSection,
  PrivacySection,
  ProtectSection,
  ReviewSection,
} from "@/components/site/sections";

export default function LandingPage() {
  return (
    <>
      <ScrollScenes />
      <Hero />
      <LiveStats />
      <ProtectSection />
      <EarnSection />
      <GuardianSection />
      <ReviewSection />
      <PrivacySection />
      <OnlyOnNearSection />
      <Faq />
      <FinalCta />
    </>
  );
}
