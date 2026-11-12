import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountUpdate } from "@/components/app/AccountUpdate";
import { MobileNav, Sidebar } from "@/components/app/AppNav";
import { HashScroll } from "@/components/app/HashScroll";
import { TopBar } from "@/components/app/TopBar";
import { AppProviders } from "@/components/providers/AppProviders";
import { apiUrl } from "@/lib/env";

export const metadata: Metadata = {
  title: { default: "Dashboard", template: "%s | Parry" },
};

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <AppProviders>
      <div className="flex min-h-dvh">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main id="main" tabIndex={-1} className="flex-1 px-4 pb-28 pt-8 outline-none sm:px-6 lg:px-8 lg:pb-12">
            <div className="mx-auto w-full max-w-6xl">
              {apiUrl ? null : (
                <p role="alert" className="mb-6 rounded-lg border border-line bg-raised px-4 py-3 text-sm leading-6 text-muted">
                  This build has no Parry API address, so nothing live can load. Set <code className="num text-fg">NEXT_PUBLIC_API_URL</code> and rebuild.
                </p>
              )}
              <AccountUpdate />
              {children}
            </div>
          </main>
        </div>
        <MobileNav />
        <Suspense>
          <HashScroll />
        </Suspense>
      </div>
    </AppProviders>
  );
}
