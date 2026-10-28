import { useState } from "react";
import { Button, Caption, Divider, Overline, Stack, Text } from "@hackcove/ui";

/** Past this many lines, or this many characters, the brief opens collapsed. */
const SHOWN_LINES = 4;
const SHOWN_CHARS = 320;

const long = (brief: string) =>
  brief.split("\n").length > SHOWN_LINES || brief.length > SHOWN_CHARS;

/**
 * The uploader's brief (PS-232): what they say the build changes, shown as they wrote it. Plain
 * text, never markdown; collapsed past a few lines. It is their words, not a measurement: it
 * decides no status and no review.
 */
export function BuildBrief({ brief }: { brief: string | null }) {
  const [open, setOpen] = useState(false);
  if (!brief) return null;
  const collapsible = long(brief);
  const clamped = collapsible && !open;
  return (
    <Stack as="section" gap="xs" data-testid="build-brief">
      <Divider />
      <Overline as="h2">Brief</Overline>
      <Caption tone="muted">The uploader's words, as sent with the build. Not checked.</Caption>
      <div
        className={clamped ? "line-clamp-4 whitespace-pre-wrap" : "whitespace-pre-wrap"}
        data-testid="brief-text"
        data-collapsed={clamped ? "" : undefined}
      >
        <Text>{brief}</Text>
      </div>
      {collapsible && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            data-testid="brief-toggle"
          >
            {open ? "Show less" : "Show all"}
          </Button>
        </div>
      )}
    </Stack>
  );
}
