export interface EnvConfig {
  port: number;
  nodeEnv: string;
  logLevel: string;
  /** Legacy API key auth fallback (same convention as sibling MCPs). */
  apiKey: string;
  userId: string;
  /** HMAC secret for ll5.* tokens — validates inbound calls AND mints the
   *  service token for internal gateway calls. */
  authSecret: string;
  /** Vaultwarden base URL, e.g. https://vault.noninoni.click */
  vaultUrl: string;
  /** Machine-account API key (bw login --apikey). Empty until the operator
   *  runs the bootstrap and sets the secrets — the service then runs in
   *  "unconfigured" mode (loud logs, tools report vault down) instead of
   *  crash-looping. */
  bwClientId: string;
  bwClientSecret: string;
  /** Machine-account master password (bw unlock). Never logged. */
  bwPassword: string;
  /** Internal CDP endpoint of the shared browser container, e.g. http://browser:9222 */
  browserCdpUrl: string;
  /** Internal gateway URL, e.g. http://gateway:3000 */
  gatewayUrl: string;
  /** Localhost port for the bw serve sidecar. */
  bwServePort: number;
  /** Organization / collection scoping (DECISION-022: only the LL5 org's
   *  agent collection is ever visible to this service). */
  vaultOrgName: string;
  vaultCollectionName: string;
}

export function loadEnv(): EnvConfig {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} environment variable is required`);
    return v;
  };

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    apiKey: required('API_KEY'),
    userId: required('USER_ID'),
    authSecret: required('AUTH_SECRET'),
    vaultUrl: required('VAULT_URL').replace(/\/+$/, ''),
    bwClientId: process.env.BW_CLIENTID || '',
    bwClientSecret: process.env.BW_CLIENTSECRET || '',
    bwPassword: process.env.BW_PASSWORD || '',
    browserCdpUrl: required('BROWSER_CDP_URL').replace(/\/+$/, ''),
    gatewayUrl: required('GATEWAY_URL').replace(/\/+$/, ''),
    bwServePort: parseInt(process.env.BW_SERVE_PORT || '8087', 10),
    vaultOrgName: process.env.VAULT_ORG_NAME || 'LL5',
    vaultCollectionName: process.env.VAULT_COLLECTION_NAME || 'agent',
  };
}
