import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { CertificatesView } from "./CertificatesView";

export const metadata: Metadata = { title: "Certificates" };

export default function CertificatesPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Certificates" description="Private proof of a safe position: the enclave signs that health is at least a threshold, for one reader, at one block, until it expires. No amounts leave it." />
      <CertificatesView />
    </div>
  );
}
