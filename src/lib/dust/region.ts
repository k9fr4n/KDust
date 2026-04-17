import { getAppConfig } from '../config';

/**
 * Résout l'URL Dust à utiliser en fonction de la région du token.
 *
 * - europe-west1 → https://eu.dust.tt
 * - us-central1  → https://dust.tt
 * - sinon        → valeur configurée dans AppConfig.dustBaseUrl (fallback)
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
