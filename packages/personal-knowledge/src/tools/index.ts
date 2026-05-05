import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FactRepository } from '../repositories/interfaces/fact.repository.js';
import type { PersonRepository } from '../repositories/interfaces/person.repository.js';
import type { PlaceRepository } from '../repositories/interfaces/place.repository.js';
import type { ProfileRepository } from '../repositories/interfaces/profile.repository.js';
import type { DataGapRepository } from '../repositories/interfaces/data-gap.repository.js';
import type { NetworkRepository } from '../repositories/interfaces/network.repository.js';
import type { ObservationRepository } from '../repositories/interfaces/observation.repository.js';
import type { NarrativeRepository } from '../repositories/interfaces/narrative.repository.js';
import { registerProfileTools } from './profile.js';
import { registerFactTools } from './facts.js';
import { registerPeopleTools } from './people.js';
import { registerPlaceTools } from './places.js';
import { registerDataGapTools } from './data-gaps.js';
import { registerSearchTools } from './search.js';
import { registerNetworkTools } from './networks.js';
import { registerNarrativeTools } from './narratives.js';

export interface Repositories {
  profile: ProfileRepository;
  fact: FactRepository;
  person: PersonRepository;
  place: PlaceRepository;
  dataGap: DataGapRepository;
  network: NetworkRepository;
  observation: ObservationRepository;
  narrative: NarrativeRepository;
}

export function registerAllTools(
  server: McpServer,
  repos: Repositories,
  getUserId: () => string,
): void {
  registerProfileTools(server, repos.profile, getUserId);
  registerFactTools(server, repos.fact, getUserId);
  registerPeopleTools(server, repos.person, getUserId);
  registerPlaceTools(server, repos.place, getUserId);
  registerDataGapTools(server, repos.dataGap, getUserId);
  registerSearchTools(server, repos.fact, repos.person, repos.place, getUserId);
  registerNetworkTools(server, repos.network, repos.place, getUserId);
  registerNarrativeTools(
    server,
    repos.observation,
    repos.narrative,
    repos.person,
    repos.place,
    getUserId,
  );
}
