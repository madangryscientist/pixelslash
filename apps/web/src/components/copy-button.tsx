import { useState } from "react";

/** Puts `text` on the clipboard and says so; inert until the page is hydrated. */
export function CopyButton({ text, hydrated }: { text: string; hydrated: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      disabled={!hydrated}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      className="shrink-0 rounded font-sans text-xs text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-violet-600"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

/** One line of mono text in a box, with a copy button: a command or a token to paste elsewhere. */
export function CopyLine({
  text,
  hydrated,
  testId,
}: {
  text: string;
  hydrated: boolean;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-[12.5px] text-slate-900">
      <code data-testid={testId} className="min-w-0 break-words">
        {text}
      </code>
      <CopyButton text={text} hydrated={hydrated} />
    </div>
  );
}
