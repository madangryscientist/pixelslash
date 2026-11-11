import {
  Text,
  BulletList,
  Caption,
  CardGrid,
  ProseLayout,
  Section,
  StatTile,
  SubsectionHeading,
  Table,
  TableBody,
  TableCell,
  TableGroupRow,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";
import {
  type Cell,
  METHOD,
  ROWS,
  type Row,
  SUMMARY,
  TOOLS,
  VALUE_LABEL,
  type Value,
  groups,
} from "../../content/matrix.ts";
import { REPO_PUBLIC, REPO_URL } from "../../content/links.ts";

const BENCH_RESULTS = `${REPO_URL}/blob/main/bench/results/2026-10-20.md`;

/*
 * docs/capabilities/data.json, drawn. Every value, note and link in the tables and lists is read
 * from that file; the counts are computed the way build.py computes them. The paragraphs at the top
 * are by hand, and each figure in them is from bench/results/2026-10-20.md or a cell in that file.
 */

const GROUP_LABEL: Record<string, string> = {
  capture: "Capture",
  diff: "Diff",
  flow: "Review flow",
  platform: "Platform",
};

const TONE: Record<Value, "positive" | "warn" | "danger" | undefined> = {
  y: "positive",
  p: "warn",
  n: "danger",
  "?": undefined,
};

function TheirCell({ cell }: { cell: Cell }): ReactNode {
  const label = VALUE_LABEL[cell.v];
  return (
    <TableCell numeric tone={TONE[cell.v]} title={cell.note || undefined}>
      {cell.link ? (
        <TextLink href={cell.link} external>
          {label}
        </TextLink>
      ) : (
        label
      )}
    </TableCell>
  );
}

function MatrixRow({ row }: { row: Row }): ReactNode {
  return (
    <TableRow
      data-row={row.key}
      data-behind={row.behind ? "1" : "0"}
      tone={row.behind ? "warn" : undefined}
    >
      <TableCell>
        {row.label}
        {row.behind ? <Caption as="span"> (behind)</Caption> : null}
      </TableCell>
      <TableCell numeric tone={TONE[row.ours.v]} title={row.ours.note || undefined}>
        <strong>{VALUE_LABEL[row.ours.v]}</strong>
      </TableCell>
      {TOOLS.map((tool) => {
        const cell = row.theirs[tool.key];
        return cell ? <TheirCell key={tool.key} cell={cell} /> : null;
      })}
    </TableRow>
  );
}

function Matrix(): ReactNode {
  return (
    <Table data-testid="matrix" caption="PixelSlash against five other tools, by capability">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Capability</TableHeaderCell>
          <TableHeaderCell>PixelSlash</TableHeaderCell>
          {TOOLS.map((tool) => (
            <TableHeaderCell key={tool.key}>{tool.name}</TableHeaderCell>
          ))}
        </TableRow>
      </TableHead>
      {groups().map(({ group, rows }) => (
        <TableBody key={group}>
          <TableGroupRow label={GROUP_LABEL[group] ?? group} colSpan={TOOLS.length + 2} />
          {rows.map((row) => (
            <MatrixRow key={row.key} row={row} />
          ))}
        </TableBody>
      ))}
    </Table>
  );
}

/** Who is ahead on a row we are behind on, by name. */
function aheadOf(row: Row): string {
  const ahead = TOOLS.filter((tool) => {
    const cell = row.theirs[tool.key];
    return cell !== undefined && cell.v === "y" && row.ours.v !== "y";
  });
  const names = ahead.length > 0 ? ahead : TOOLS.filter((tool) => row.theirs[tool.key]?.v === "p");
  return names.map((tool) => tool.name).join(", ");
}

function Behind(): ReactNode {
  const behind = ROWS.filter((row) => row.behind);
  return (
    <Section title={`Where we are behind (${behind.length})`}>
      <Text as="p">
        These are the rows where at least one other tool does more than we do. Each one says what is
        missing, in the words of the comparison file.
      </Text>
      <BulletList data-testid="behind-list">
        {behind.map((row) => (
          <li key={row.key} data-behind-item={row.key}>
            <strong>{row.label}</strong>: we are {VALUE_LABEL[row.ours.v].toLowerCase()}; ahead:{" "}
            {aheadOf(row)}. {row.gap ? `Missing: ${row.gap}.` : null}
          </li>
        ))}
      </BulletList>
    </Section>
  );
}

/** The four questions a visitor comes with, in the reading column above the method. */
function WhoFor(): ReactNode {
  return (
    <>
      <Text as="p">
        PixelSlash is for developers and teams who want visual review of their pages without writing
        stories or signing up for a service. It is meant to replace a service such as Chromatic,
        Percy, Argos or Applitools, or Lost Pixel, whose repository is archived and whose makers are
        sunsetting it. Today that means running the review server yourself.
      </Text>
      <Text as="p">
        It is free: source available under the Elastic License 2.0, with all of it in the repository
        and no paid plan to buy. A paid service run by us is planned; it is not on sale.
      </Text>
      <Text as="p">
        No row below is ours alone, so the difference is the mix: a run is local by default, and the
        whole review app is source available and can be self-hosted for your own use. Argos is open
        source too, but its docs say self-hosting is not officially supported, and it is run as a
        managed service. Lost Pixel is local and open source, and is being wound down.
      </Text>
      <Text as="p">
        The diff is measured. On the held-out half of{" "}
        {REPO_PUBLIC ? (
          <TextLink href={BENCH_RESULTS} external>
            our own benchmark, run 2026-10-20
          </TextLink>
        ) : (
          "our own benchmark, run 2026-10-20"
        )}
        , PixelSlash caught 42 of 45 real changes and wrongly flagged 11 of 36 noise pairs; Argos,
        on the same pairs, caught 37 and flagged 24. Argos was faster, at a median of 18.0 ms a pair
        to our 29.3.
      </Text>
    </>
  );
}

/** The prose in the reading column; the table below it takes the page's full width. */
export function ComparePage(): ReactNode {
  return (
    <>
      <ProseLayout
        title="How we compare"
        subtitle={`${SUMMARY.rows} capabilities, against five other tools.`}
        gap="lg"
      >
        <CardGrid columns={3}>
          <StatTile label="Capabilities" value={String(SUMMARY.rows)} data-testid="stat-rows" />
          <StatTile
            label="Level or ahead"
            value={String(SUMMARY.level)}
            tone="positive"
            data-testid="stat-level"
          />
          <StatTile
            label="Behind"
            value={String(SUMMARY.behind)}
            tone="negative"
            data-testid="stat-behind"
          />
        </CardGrid>
        <WhoFor />
        <Text as="p">{METHOD}</Text>
        <Behind />
      </ProseLayout>
      <div className="mt-10 flex flex-col gap-10">
        <Section title="The whole table">
          <Text as="p">
            Hover a cell for its note. Every competitor cell links the page it was read from.
          </Text>
          <Matrix />
        </Section>
        <Section title="Sources">
          <SubsectionHeading as="h3" size="sm">
            Their docs, fetched {SUMMARY.updated}
          </SubsectionHeading>
          <BulletList>
            {TOOLS.map((tool) => (
              <li key={tool.key}>
                {tool.src ? (
                  <TextLink href={tool.src} external>
                    {tool.name}
                  </TextLink>
                ) : (
                  tool.name
                )}
              </li>
            ))}
          </BulletList>
          <Caption as="p">
            Our column was read from the code at {SUMMARY.oursCommit}, audited {SUMMARY.audited}.
          </Caption>
        </Section>
      </div>
    </>
  );
}
