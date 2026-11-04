import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { Mark } from "@/components/brand/Logo";
import { ThemeSwitcher } from "@/components/theme/ThemeToggle";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Settings" description="Appearance on this device, and your account's preferences." />
      <Card as="section" aria-labelledby="appearance-title">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="appearance-title" className="text-[15px] font-semibold text-fg">
              Appearance
            </h2>
            <p className="mt-1 text-sm text-muted">Follow your system, or keep Parry light or dark on this device.</p>
          </div>
          <ThemeSwitcher label="Theme" />
        </div>
      </Card>
      <section aria-labelledby="account-title" className="grid gap-4">
        <h2 id="account-title" className="text-[15px] font-semibold text-fg">
          Account
        </h2>
        <EmptyState
          compact
          titleAs="h3"
          icon={<Mark size={22} />}
          title="Connect an account to change its settings"
          description="Account settings such as alert channels and push notifications are kept with your account."
        />
      </section>
    </div>
  );
}
