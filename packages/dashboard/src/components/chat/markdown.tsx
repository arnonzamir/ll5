"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Components } from "react-markdown";

/**
 * Renders an agent message as GitHub-flavored Markdown — tables, bold/italic,
 * lists, code, links, headings, blockquotes — so the agent can shape the look
 * of its replies. `remark-breaks` keeps single newlines as line breaks (the
 * agent writes multi-line prose with soft breaks). Styling is mapped to the
 * chat's ink/coach palette; tables scroll horizontally so a wide table doesn't
 * blow out the bubble. `dir="auto"` per block keeps RTL (Hebrew) correct.
 */
const components: Components = {
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-[14px] leading-snug">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-ink-100/60">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-ink-300/60 px-2 py-1 text-left font-semibold align-top" dir="auto">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-ink-300/50 px-2 py-1 align-top" dir="auto">{children}</td>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-coach-700 underline underline-offset-2 break-words">{children}</a>
  ),
  ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-snug" dir="auto">{children}</li>,
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0" dir="auto">{children}</p>,
  h1: ({ children }) => <h1 className="text-[1.25em] font-semibold mt-2 mb-1" dir="auto">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[1.15em] font-semibold mt-2 mb-1" dir="auto">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[1.05em] font-semibold mt-2 mb-1" dir="auto">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-coach-500/40 pl-3 my-1 text-ink-700">{children}</blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = (className ?? "").includes("language-");
    if (isBlock) {
      return (
        <code className="block w-full overflow-x-auto bg-ink-100/70 rounded-md p-2 my-1 font-mono text-[13px] leading-snug whitespace-pre">{children}</code>
      );
    }
    return <code className="bg-ink-100/70 rounded px-1 py-0.5 font-mono text-[0.88em]">{children}</code>;
  },
  pre: ({ children }) => <pre className="my-1">{children}</pre>,
  hr: () => <hr className="my-2 border-ink-300/50" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
};

export function Markdown({ content }: { content: string }) {
  return (
    <div className="ll5-md break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
