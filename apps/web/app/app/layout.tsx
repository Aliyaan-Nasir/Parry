import type { Metadata } from "next";
import { MobileNav, Sidebar } from "@/components/app/AppNav";
import { TopBar } from "@/components/app/TopBar";

export const metadata: Metadata = {
  title: { default: "Dashboard", template: "%s | Parry" },
};

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" tabIndex={-1} className="flex-1 px-4 pb-28 pt-8 outline-none sm:px-6 lg:px-8 lg:pb-12">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
