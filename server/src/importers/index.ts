import type { Importer } from './types.js';
import { sslFabrikCrewList } from './sslFabrikCrewList.js';

/** Register importers for further competitions here. */
export const importers: Record<string, Importer> = {
  [sslFabrikCrewList.id]: sslFabrikCrewList,
};
