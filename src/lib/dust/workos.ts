import { jwtDecode } from 'jwt-decode';
import { getAppConfig } from '../config';
import { clearTokens, saveTokens } from './tokens';

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

  // Decode region from access token.
  let region = 'us-central1';
  try {
    const decoded = jwtDecode<Record<string, unknown>>(tok.access_token);
    console.log('[workos] decoded JWT keys:', Object.keys(decoded));
    const candidates = [
      `${cfg.claimNamespace}region`,
      'https://dust.tt/region',
      'https://eu.dust.tt/region',
      'region',
    ];
    for (const k of candidates) {
      const v = decoded?.[k];
      if (typeof v === 'string' && v.length > 0) {
        region = v;
        console.log('[workos] region claim found via', k, '=', v);
        break;
      }
    }
    if (region === 'us-central1') {
      console.warn(
        '[workos] no region claim found, defaulting to us-central1. Full JWT payload:',
        JSON.stringify(decoded),
      );
    }
  } catch (err) {
    console.error('[workos] failed to decode JWT:', err);
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
  if (!res.ok) {
    // Refresh token rejected by WorkOS (revoked, expired, tampered) —
    // wipe the DustSession so the app stops using a dead token on every
    // subsequent request and the UI surfaces a fresh "Login with Dust"
    // flow. Matches the official Dust CLI behavior
    // (dust-cli/src/utils/authService.ts:55-58, Franck 2026-04-21 18:15).
    if (res.status === 400 || res.status === 401) {
      try {
        await clearTokens();
        console.warn(
          `[dust/workos] refresh token rejected (${res.status}) → DustSession cleared, re-auth required`,
        );
      } catch (e) {
        console.error('[dust/workos] failed to clear tokens after refresh rejection', e);
      }
    }
    throw new Error(`WorkOS refresh failed: ${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}
