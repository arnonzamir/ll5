"use client";

import { useState } from "react";
import { Copy, Check, MessageCircle } from "lucide-react";
import { Markdown } from "./markdown";

/**
 * Draft blocks (DECISION-030). Where the agent may not message a contact or
 * group itself (read-only conversations), it hands the user the exact text:
 *
 *   [[draft to="Rotem" via="whatsapp"]]
 *   לא מגיע הערב, מרגיש חולה.
 *   [[/draft]]
 *
 * Rendered as a card with "Copy" and "Open WhatsApp" (wa.me prefills the text;
 * the user picks the chat). The rest of the message renders as Markdown.
 */
const DRAFT_RE = /\[\[draft\s+([^\]]*)\]\]\s*([\s\S]*?)\s*\[\[\/draft\]\]/g;

export interface DraftBlock { to: string; via: string; text: string }
export type Segment = { kind: "md"; text: string } | { kind: "draft"; draft: DraftBlock };

export function splitDrafts(content: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of content.matchAll(DRAFT_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: "md", text: content.slice(last, idx) });
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    out.push({ kind: "draft", draft: { to: attrs.to ?? "", via: (attrs.via ?? "whatsapp").toLowerCase(), text: m[2] } });
    last = idx + m[0].length;
  }
  if (last < content.length) out.push({ kind: "md", text: content.slice(last) });
  return out.length ? out : [{ kind: "md", text: content }];
}

function openUrl(d: DraftBlock): string | null {
  const t = encodeURIComponent(d.text);
  if (d.via === "whatsapp") return `https://wa.me/?text=${t}`;
  if (d.via === "telegram") return `https://t.me/share/url?url=&text=${t}`;
  if (d.via === "sms") return `sms:?body=${t}`;
  return null;
}

export function DraftCard({ draft }: { draft: DraftBlock }) {
  const [copied, setCopied] = useState(false);
  const url = openUrl(draft);
  const copy = async () => {
    try { await navigator.clipboard.writeText(draft.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="my-2 rounded-xl border border-coach-500/40 bg-white/70 p-3 text-[15px] leading-6" dir="auto">
      <div className="text-[11px] uppercase tracking-wide text-coach-700 mb-1 font-mono">
        draft → {draft.to || "…"} · {draft.via}
      </div>
      <div className="whitespace-pre-wrap break-words text-ink-900">{draft.text}</div>
      <div className="mt-2 flex gap-2" dir="ltr">
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-lg border border-ink-300 px-2.5 py-1 text-[13px] hover:bg-ink-100">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
        </button>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" onClick={copy}
             className="inline-flex items-center gap-1 rounded-lg bg-coach-500 px-2.5 py-1 text-[13px] text-white hover:bg-coach-700">
            <MessageCircle className="h-3.5 w-3.5" /> Copy &amp; open {draft.via === "whatsapp" ? "WhatsApp" : draft.via}
          </a>
        )}
      </div>
    </div>
  );
}

/** Assistant message body: Markdown with draft blocks rendered as cards. */
export function AssistantContent({ content }: { content: string }) {
  const segs = splitDrafts(content);
  return (
    <>
      {segs.map((s, i) => (s.kind === "draft" ? <DraftCard key={i} draft={s.draft} /> : <Markdown key={i} content={s.text} />))}
    </>
  );
}
