import type { Metadata } from "next";
import { SettingsView } from "./SettingsView";
import { PageHeader } from "@/components/app/PageHeader";
import { ThemeSwitcher } from "@/components/theme/ThemeToggle";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="grid gap-8">
      <PageHeader title="Settings" description="Appearance on this device, and your account's preferences." />
      <div className="grid gap-6" data-stagger>
        <SettingsView />
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
      </div>
    </div>
  );
}
