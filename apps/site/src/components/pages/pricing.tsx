import {
  Button,
  Callout,
  Card,
  CardGrid,
  Cluster,
  Display,
  ProseLayout,
  Section,
  Text,
  TextLink,
} from "@hackcove/ui-react";
import type { ReactNode } from "react";
import { CONTACT } from "../../content/links.ts";
import { ACTION, COMMITMENT, FACTS, LEAD, STATEMENT } from "../../content/pricing.ts";

/** One statement and one action, then the facts and the commitment. */
export function PricingPage(): ReactNode {
  return (
    <ProseLayout
      width="wide"
      title={<Display as="span">{STATEMENT}</Display>}
      subtitle={LEAD}
      gap="lg"
    >
      <Cluster>
        <Button href={ACTION.href} size="lg" data-testid="pricing-action">
          {ACTION.label} <span aria-hidden="true">→</span>
        </Button>
      </Cluster>
      <CardGrid columns={3} data-testid="pricing-facts">
        {FACTS.map((fact) => (
          <Card key={fact.title} title={fact.title}>
            {fact.body}
          </Card>
        ))}
      </CardGrid>
      <Callout tone="positive" title="Our commitment" data-testid="commitment">
        {COMMITMENT}
      </Callout>
      <Section title="Questions">
        <Text as="p">
          Write to <TextLink href={`mailto:${CONTACT}`}>{CONTACT}</TextLink>.
        </Text>
      </Section>
    </ProseLayout>
  );
}
