import type { ReactNode } from "react";
import { Section } from "./Section";
import { FileIcon, PlugIcon, ReceiptIcon, SparkIcon } from "./icons";
import { CopyButton } from "@/components/app/bits";
import { apiUrl } from "@/lib/env";

function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-surface py-1 pl-3 pr-1">
      <code className="num min-w-0 overflow-x-auto whitespace-nowrap py-1 text-[13px] leading-5 text-fg [scrollbar-width:none]">
        {code}
      </code>
      <CopyButton value={code} label={label} />
    </div>
  );
}

function Tool({ icon, title, line, children }: { icon: ReactNode; title: string; line: string; children: ReactNode }) {
  return (
    <li className="flex min-w-0 flex-col gap-4 bg-raised p-5 sm:p-6">
      <div className="flex gap-4">
        <span className="mt-0.5 text-brass">{icon}</span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold text-fg">{title}</span>
          <span className="mt-1 block text-sm leading-6 text-muted">{line}</span>
        </span>
      </div>
      <div className="mt-auto grid gap-2">{children}</div>
    </li>
  );
}

/** How an agent reads and uses Parry: llms.txt, the MCP server, the skill and paid risk checks. */
export function AgentsSection() {
  const mcp = apiUrl ? `${apiUrl}/mcp` : null;
  return (
    <Section
      id="agents"
      index="07"
      eyebrow="For agents"
      title="Agents can use it too."
      lead="Everything a person sees, an agent can read: positions, risk, the guardian log and its proofs, the vault. Write tools are capped and testnet only."
    >
      <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2" data-reveal-stagger>
        <Tool icon={<FileIcon />} title="llms.txt" line="A plain map of Parry for language models: what it does, and where every doc and tool is.">
          <a href="/llms.txt" className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-brass underline-offset-4 hover:underline">
            Read /llms.txt
          </a>
        </Tool>
        <Tool icon={<PlugIcon />} title="MCP server" line="Risk checks (free, or paid over x402), the guardian log and its verification, rescue routes, the vault and service status, as MCP tools.">
          {mcp ? <Snippet code={mcp} label="MCP endpoint" /> : null}
          <Snippet code="npx -y @parry/mcp" label="MCP server command" />
        </Tool>
        <Tool icon={<SparkIcon />} title="Agent skill" line="Teaches coding agents to use Parry and to extend it.">
          <Snippet code="npx skills add Aliyaan-Nasir/Parry" label="skill install command" />
        </Tool>
        <Tool icon={<ReceiptIcon />} title="SDK and paid checks" line="Read, build calls and verify proofs from code; buy a risk check per call over x402 on NEAR.">
          <Snippet code="npm install @parry/sdk" label="SDK install command" />
        </Tool>
      </ul>
    </Section>
  );
}
