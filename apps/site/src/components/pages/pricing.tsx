import {
  Button,
  Callout,
  Caption,
  Card,
  CardGrid,
  Cluster,
  Display,
  Lead,
  PageHeading,
  Stack,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { CONTACT } from "../../content/links.ts";
import { ACTION, COMMITMENT, FACTS, LEAD, STATEMENT } from "../../content/pricing.ts";

/**
 * The statement, its lead and the one action on the left of a hero, the commitment beside them on the
 * right; the facts follow, and the contact line ends the page. Below lg the hero is one column, in
 * that order.
 */
export function PricingPage(): ReactNode {
  return (
    <Stack width="full" gap="lg">
      <div className="grid gap-8 lg:grid-cols-[3fr_2fr] lg:items-start" data-testid="pricing-hero">
        <Stack gap="sm">
          <PageHeading>
            <Display as="span">{STATEMENT}</Display>
          </PageHeading>
          <Lead>{LEAD}</Lead>
          <Cluster>
            <Button href={ACTION.href} size="lg" data-testid="pricing-action">
              {ACTION.label} <span aria-hidden="true">→</span>
            </Button>
          </Cluster>
        </Stack>
        <Callout tone="neutral" title="Our commitment" data-testid="commitment">
          {COMMITMENT}
        </Callout>
      </div>
      <CardGrid columns={3} data-testid="pricing-facts">
        {FACTS.map((fact) => (
          <Card key={fact.title} title={fact.title} icon={fact.icon}>
            {fact.body}
          </Card>
        ))}
      </CardGrid>
      <Caption as="p">
        Questions? Write to <TextLink href={`mailto:${CONTACT}`}>{CONTACT}</TextLink>.
      </Caption>
    </Stack>
  );
}
