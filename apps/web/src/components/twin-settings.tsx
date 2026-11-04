import { Button, ButtonGroup, Card, SectionHeading, Select, Stack, Text } from "@hackcove/ui-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { saveTwinProject } from "#/server/twin-fns";

/**
 * The project this one's shots are paired with (PS-295): the web app and the native app often live
 * in two projects of one org. Pairing is by snapshot name and theme; it reads, and changes no diff.
 */
export function TwinSettings({
  projectId,
  saved,
  options,
  hydrated,
}: {
  projectId: string;
  saved: string | null;
  options: { id: string; name: string }[];
  hydrated: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState(saved ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveTwinProject({ data: { projectId, twinProjectId: chosen } });
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="twin-project">
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Twin project</SectionHeading>
          <Text as="p">
            Another project of this org that holds the same screens on another platform, for a web
            app and its native app in two projects. A build&apos;s shots are paired with the shots
            of the same name and theme there: the twin project&apos;s build at the same commit, else
            its current baselines. Pairing only reads; it changes no diff or review.
          </Text>
        </Stack>
        {options.length === 0 ? (
          <Text as="p" tone="muted" data-testid="no-twin-options">
            This org has no other project to link.
          </Text>
        ) : (
          <>
            <Select
              aria-label="Twin project"
              value={chosen}
              disabled={!hydrated}
              onChange={(e) => setChosen(e.target.value)}
              width="lg"
            >
              <option value="">None</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
            {error && (
              <Text as="p" tone="danger" role="alert">
                {error}
              </Text>
            )}
            <ButtonGroup>
              <Button
                disabled={!hydrated || chosen === (saved ?? "")}
                busy={busy}
                busyLabel="Saving…"
                onClick={() => void save()}
              >
                Save twin project
              </Button>
            </ButtonGroup>
          </>
        )}
      </Stack>
    </Card>
  );
}
