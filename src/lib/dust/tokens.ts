import { db } from '../db';
import { decrypt, encrypt } from '../crypto';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  workspaceId: string | null;
  region: string;
  expiresAt: Date | null;
}

export async function saveTokens(
  accessToken: string,
  refreshToken: string,
  opts: { region?: string; expiresAt?: Date | null } = {},
) {
  const accessTokenEnc = encrypt(accessToken);
  const refreshTokenEnc = encrypt(refreshToken);
  await db.dustSession.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      accessTokenEnc,
      refreshTokenEnc,
      region: opts.region ?? 'us-central1',
      expiresAt: opts.expiresAt ?? null,
    },
    update: {
      accessTokenEnc,
      refreshTokenEnc,
      region: opts.region,
      expiresAt: opts.expiresAt ?? null,
    },
  });
}

export async function saveWorkspaceId(workspaceId: string) {
  await db.dustSession.update({ where: { id: 1 }, data: { workspaceId } });
}

export async function loadTokens(): Promise<StoredTokens | null> {
  const row = await db.dustSession.findUnique({ where: { id: 1 } });
  if (!row) return null;
  return {
    accessToken: decrypt(row.accessTokenEnc),
    refreshToken: decrypt(row.refreshTokenEnc),
    workspaceId: row.workspaceId,
    region: row.region,
    expiresAt: row.expiresAt,
  };
}

export async function clearTokens() {
  await db.dustSession.deleteMany({});
}
