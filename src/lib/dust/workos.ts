import { jwtDecode } from 'jwt-decode';
import { getAppConfig } from '../config';
import { saveTokens } from './tokens';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const cfg = await getAppConfig();
  const res = await fetch(`https://${cfg.workosDomain}/user_management/authorize/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.workosClientId,
      scope: 'openid profile email',
    }),
  });
  if (!res.ok) {
    throw new Error(`WorkOS device start failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

export async function pollDeviceToken(deviceCode: string): Promise<
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'error'; message: string }
  | { status: 'ok' }
> {
  const cfg = await getAppConfig();
  const res = await fetch(`https://${cfg.workosDomain}/user_management/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: cfg.workosClientId,
    }),
  });
  const data = (await res.json()) as any;

  if (data?.error === 'authorization_pending') return { status: 'pending' };
  if (data?.error === 'slow_down') return { status: 'slow_down' };
  if (data?.error) return { status: 'error', message: data.error_description ?? data.error };

  const tok = data as TokenResponse;
  const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null;

  // Decode region from access token
  let region = 'us-central1';
  try {
    const decoded = jwtDecode<any>(tok.access_token);
    const claim = `${cfg.claimNamespace}region`;
    if (decoded?.[claim]) region = decoded[claim];
  } catch {
    /* ignore */
  }

  await saveTokens(tok.access_token, tok.refresh_token, { region, expiresAt });
  return { status: 'ok' };
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const cfg = await getAppConfig();
  const res = await fetch(`https://${cfg.workosDomain}/user_management/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.workosClientId,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`WorkOS refresh failed: ${res.status}`);
  return (await res.json()) as TokenResponse;
}
