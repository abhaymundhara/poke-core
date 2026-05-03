export type IdentityKind = 'user' | 'contact' | 'organization' | 'agent';
export type IdentityEdgeKind = 'colleague' | 'advisor' | 'friend' | 'manager' | 'team-member';
export type IdentityPlatform = 'github' | 'twitter' | 'x' | 'linkedin' | 'email' | 'phone' | string;

export type IdentityProperty = {
  value: string;
  verified?: boolean;
  confidence?: number;
  source?: string;
};

export type IdentityEmail = IdentityProperty & { email: string };
export type IdentityPhone = IdentityProperty & { phoneNumber: string };
export type IdentityHandle = IdentityProperty & { platform: IdentityPlatform; handle: string };

export type IdentityRecord = {
  identityId: string;
  kind: IdentityKind;
  name: string;
  aliases: string[];
  verifiedEmails: IdentityEmail[];
  phoneNumbers: IdentityPhone[];
  platformHandles: IdentityHandle[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type IdentityEdge = {
  edgeId: string;
  fromIdentityId: string;
  toIdentityId: string;
  edgeKind: IdentityEdgeKind;
  bidirectional: boolean;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type IdentityUpsertInput = {
  identityId?: string;
  kind?: IdentityKind;
  name: string;
  aliases?: string[];
  verifiedEmails?: Array<string | IdentityEmail>;
  phoneNumbers?: Array<string | IdentityPhone | string>;
  platformHandles?: Array<IdentityHandle | { platform: IdentityPlatform; handle: string; verified?: boolean; confidence?: number; source?: string }>;
  metadata?: Record<string, unknown>;
};

export type IdentityLinkInput = {
  fromIdentityId: string;
  toIdentityId: string;
  edgeKind: IdentityEdgeKind;
  confidence?: number;
  bidirectional?: boolean;
  metadata?: Record<string, unknown>;
};

export type ResolveIdentityInput =
  | string
  | { query?: string; identityId?: string; handle?: string; email?: string; phone?: string; platform?: IdentityPlatform; name?: string };

export type IdentityResolutionSignal = 'identityId' | 'email' | 'phone' | 'handle' | 'alias' | 'name';

export type IdentityResolutionCandidate = {
  identity: IdentityRecord;
  confidence: number;
  matchedBy: IdentityResolutionSignal;
  reason: string;
  signals: string[];
};

export type IdentityResolution = {
  query: string;
  normalizedQuery: string;
  candidates: IdentityResolutionCandidate[];
  bestMatch: IdentityResolutionCandidate | null;
};

export type IdentityPathStep = {
  fromIdentityId: string;
  toIdentityId: string;
  edgeId: string;
  edgeKind: IdentityEdgeKind;
  direction: 'forward' | 'reverse';
  confidence: number;
};

export type IdentityPath = {
  fromIdentityId: string;
  toIdentityId: string;
  nodes: IdentityRecord[];
  edges: IdentityPathStep[];
  confidence: number;
  hops: number;
};

export type IdentityQuery = {
  identityId?: string;
  query?: string;
  kind?: IdentityKind;
  depth?: number;
  limit?: number;
};
