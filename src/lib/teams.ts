/**
 * Posts a MessageCard payload to a Microsoft Teams "Office 365 connector"
 * webhook. The newer "Workflow / Power Automate" webhooks expect an
 * Adaptive Card shape instead; this helper supports both via a fallback.
 */
export interface TeamsCardFact {
  name: string;
  value: string;
}

export interface TeamsReport {
  title: string;
  summary: string;
  status: 'success' | 'failed';
  details?: string;
  facts?: TeamsCardFact[];
}

export async function postToTeams(webhookUrl: string, r: TeamsReport): Promise<void> {
  const color = r.status === 'success' ? '2EB67D' : 'E01E5A';
  const legacyCard = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    themeColor: color,
    summary: r.title,
    title: r.title,
    sections: [
      {
        activityTitle: r.summary,
        facts: r.facts ?? [],
        text: r.details ? '```\n' + r.details.slice(0, 3500) + '\n```' : undefined,
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(legacyCard),
  });

  if (!res.ok) {
    throw new Error(`Teams webhook failed: ${res.status} ${await res.text()}`);
  }
}
