import type { Pool } from 'pg';
import { PgConnectorRepository } from './connector.repository.js';
import { PgCredentialRepository } from './credential.repository.js';
import { PgEventRepository } from './event.repository.js';
import { PgLedgerRepository } from './ledger.repository.js';
import { PgFindingRepository } from './finding.repository.js';
import type {
  ConnectorRepository,
  CredentialRepository,
  EventRepository,
  LedgerRepository,
  FindingRepository,
} from '../interfaces/index.js';

export interface Repositories {
  connectors: ConnectorRepository;
  credentials: CredentialRepository;
  events: EventRepository;
  ledger: LedgerRepository;
  findings: FindingRepository;
}

export function createRepositories(pool: Pool, encryptionKey: string, merchantSubKeyHex: string): Repositories {
  return {
    connectors: new PgConnectorRepository(pool, encryptionKey),
    credentials: new PgCredentialRepository(pool, encryptionKey),
    events: new PgEventRepository(pool, encryptionKey),
    ledger: new PgLedgerRepository(pool, encryptionKey, merchantSubKeyHex),
    findings: new PgFindingRepository(pool, encryptionKey),
  };
}

export { PgConnectorRepository, PgCredentialRepository, PgEventRepository, PgLedgerRepository, PgFindingRepository };
