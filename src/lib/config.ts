import { db } from './db';

export interface AppConfigData {
  dustBaseUrl: string;
  workosClientId: string;
  workosDomain: string;
  claimNamespace: string;
  defaultTeamsWebhook: string | null;
}

export async function getAppConfig(): Promise<AppConfigData> {
  const existing = await db.appConfig.findUnique({ where: { id: 1 } });
  if (existing) {
    return {
      dustBaseUrl: existing.dustBaseUrl,
      workosClientId: existing.workosClientId,
      workosDomain: existing.workosDomain,
      claimNamespace: existing.claimNamespace,
      defaultTeamsWebhook: existing.defaultTeamsWebhook,
    };
  }
  // bootstrap from env
  const created = await db.appConfig.create({
    data: {
      id: 1,
      dustBaseUrl: process.env.DUST_BASE_URL ?? 'https://dust.tt',
      workosClientId: process.env.WORKOS_CLIENT_ID ?? '',
      workosDomain: process.env.WORKOS_DOMAIN ?? 'api.workos.com',
      claimNamespace: process.env.WORKOS_CLAIM_NAMESPACE ?? 'https://dust.tt/',
      defaultTeamsWebhook: null,
    },
  });
  return {
    dustBaseUrl: created.dustBaseUrl,
    workosClientId: created.workosClientId,
    workosDomain: created.workosDomain,
    claimNamespace: created.claimNamespace,
    defaultTeamsWebhook: created.defaultTeamsWebhook,
  };
}

export async function updateAppConfig(patch: Partial<AppConfigData>) {
  const current = await getAppConfig();
  return db.appConfig.update({ where: { id: 1 }, data: { ...current, ...patch } });
}
