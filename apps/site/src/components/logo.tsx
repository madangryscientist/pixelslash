import { useId } from "react";
import type { ReactNode } from "react";

/** The app's mark (apps/web's shell): a mauve-to-blue tile cut by one slash. Also public/favicon.svg. */
export function Logo({ size = 24 }: { size?: number }): ReactNode {
  // Two marks on one page (header and footer) must not share a gradient id.
  const id = useId();
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#cba6f7" />
          <stop offset="1" stopColor="#89b4fa" />
        </linearGradient>
      </defs>
      <rect width="20" height="20" rx="5" fill={`url(#${id})`} />
      <path d="M4.5 13.5 15.5 6.5" stroke="#11111b" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
