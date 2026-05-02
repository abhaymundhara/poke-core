export const RAIDINGAI_ONTOLOGY = {
  scopes: {
    tab: 'tab',
    window: 'window',
    key: 'key-0',
  },
  labels: {
    role: 'role',
    required: 'required',
  },
  locales: {
    enGb: 'en-GB',
    enUs: 'en-US',
  },
  traces: {
    gold: 'gold',
  },
  files: {
    goldTrace: 'gold-trace.json',
  },
} as const;

export type RaidingAiOntology = typeof RAIDINGAI_ONTOLOGY;
