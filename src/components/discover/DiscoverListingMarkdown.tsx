import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function DiscoverListingMarkdown({
  markdown,
  fallback,
}: {
  markdown?: string | null;
  fallback: string;
}) {
  return (
    <div className="prose prose-slate prose-strong:font-semibold prose-em:italic max-w-none text-slate-800">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="mb-4 max-w-[70ch] font-sans text-[1.1rem] leading-8 font-normal text-slate-600 last:mb-0">
              {children}
            </p>
          ),
          li: ({ children }) => (
            <li className="font-sans text-[1rem] leading-7 text-slate-700">
              {children}
            </li>
          ),
        }}
      >
        {markdown ?? fallback}
      </ReactMarkdown>
    </div>
  );
}
