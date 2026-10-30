import { Text, Callout, Card, CardGrid, ProseLayout, Section, TextLink } from "@hackcove/ui";
import type { ReactNode } from "react";
import { CONTACT } from "../../content/links.ts";
import { COMMITMENT, FACTS } from "../../content/pricing.ts";

export function PricingPage(): ReactNode {
  return (
    <ProseLayout title="Pricing" subtitle="Free, and you can run all of it yourself." gap="lg">
      <CardGrid columns={3}>
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
