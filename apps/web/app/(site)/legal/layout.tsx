import { LegalNav } from "@/components/site/LegalNav";
import { Container } from "@/components/site/Section";

export default function LegalLayout({ children }: LayoutProps<"/legal">) {
  return (
    <Container className="py-14 sm:py-20">
      <div className="grid gap-10 lg:grid-cols-12">
        <aside className="lg:col-span-3">
          <LegalNav />
        </aside>
        <article className="prose-parry max-w-2xl lg:col-span-8 lg:col-start-5">{children}</article>
      </div>
    </Container>
  );
}
