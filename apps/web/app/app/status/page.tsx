import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { StatusBoard } from "./StatusBoard";
import { Card } from "@/components/ui/Card";
import { apiUrl, networkLabel } from "@/lib/env";

export const metadata: Metadata = { title: "Status" };

export default function StatusPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Status" description="Whether Parry's services are up, and what this app is connected to." />
      <StatusBoard />
      <Card as="section" aria-labelledby="build-title" padding="none">
        <h2 id="build-title" className="border-b border-line px-5 py-4 text-[15px] font-semibold text-fg sm:px-6">
          This app
        </h2>
        <dl className="grid divide-y divide-line">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 sm:px-6">
            <dt className="text-sm text-muted">Network</dt>
            <dd className="text-sm font-semibold text-fg">NEAR {networkLabel}</dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 sm:px-6">
            <dt className="text-sm text-muted">Parry API</dt>
            <dd className="num min-w-0 break-all text-[13px] text-fg">{apiUrl ?? "Not configured"}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
