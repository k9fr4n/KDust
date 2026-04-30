import { getAppConfig } from '../config';

/**
 * Resolve the Dust API base URL to use based on the token's region.
 *
 * - europe-west1 → https://eu.dust.tt
 * - us-central1  → https://dust.tt
 * - else         → AppConfig.dustBaseUrl (configured fallback)
 */
export async function resolveDustUrl(region: string | null | undefined): Promise<string> {
  const cfg = await getAppConfig();
  switch (region) {
    case 'europe-west1':
      return 'https://eu.dust.tt';
    case 'us-central1':
      return 'https://dust.tt';
    default:
      return cfg.dustBaseUrl;
  }
}
