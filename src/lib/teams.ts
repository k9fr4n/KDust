/**
 * Envoie un message MessageCard sur un webhook Microsoft Teams (connector).
 * Les webhooks "Workflow / Power Automate" utilisent un payload Adaptive Card
 * légèrement différent : ce helper gère les deux formats par un fallback.
 */
export interface TeamsReport {
  title: string;
  summary: string;
  status: 'success' | 'failed';
  details?: string;
  facts?: Array<{ name: string; value: string }>;
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
