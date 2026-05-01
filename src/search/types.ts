export type SearchSource = 'web' | 'realtime-web' | 'scholar' | 'github' | 'memory' | 'email' | 'calendar' | 'filesystem' | 'integration';
export type SearchFreshness = 'historical' | 'recent' | 'live';
export type SearchFocus = 'semantic' | 'trust' | 'multi-hop' | 'factual' | 'diagnostic' | 'exploratory';
export type TrustMode = 'official-first' | 'diverse' | 'broad';

export type SearchConstraint = {
  field: 'time' | 'source' | 'domain' | 'format' | 'exclusion' | 'quality' | 'privacy';
  operator: 'must' | 'should' | 'must-not';
  value: string;
  confidence: number;
};

export type SourcePrior = {
  source: SearchSource | string;
  weight: number;
  reason: string;
};

export type SemanticFrame = {
  name: string;
  description: string;
  confidence: number;
  slots: Record<string, string[]>;
};

export type IntentAmbiguity = {
  issue: string;
  candidates: string[];
  resolutionHint: string;
  confidence: number;
};

export type SearchIntent = {
  objective: string;
  normalizedObjective: string;
  semanticQuery: string;
  entities: string[];
  topics: string[];
  constraints: SearchConstraint[];
  sourceHints: SearchSource[];
  sourcePriors: SourcePrior[];
  freshness: SearchFreshness;
  focus: SearchFocus;
  hopBudget: number;
  trustMode: TrustMode;
  querySeeds: string[];
  evidenceTerms: string[];
  sessionKey: string;
  semanticFrames: SemanticFrame[];
  decomposedQuestions: string[];
  ambiguities: IntentAmbiguity[];
  nlu: {
    provider: string;
    confidence: number;
    fallbackUsed: boolean;
    warnings: string[];
  };
};

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: SearchSource;
  publishedAt?: string | null;
  author?: string | null;
  claims?: string[];
  trust?: number;
  freshness?: number;
  score?: number;
};

export type TrustScoreBreakdown = {
  evidenceQuality: number;
  provenance: number;
  recency: number;
  corroboration: number;
  domainReliability: number;
  expertise: number;
  independence: number;
  uncertainty: number;
};

export type TrustedEvidence = SearchResult & {
  trustScore: number;
  trustBreakdown: TrustScoreBreakdown;
  reliability: {
    mean: number;
    variance: number;
    sampleSize: number;
    failureModes: string[];
    epistemicClass: 'primary' | 'expert' | 'institutional' | 'community' | 'unknown';
  };
  provenance: {
    domain: string;
    source: SearchSource | string;
    official: boolean;
    primary: boolean;
  };
};

export type SearchEvidenceNode = {
  id: string;
  label: string;
  type: 'query' | 'result' | 'source' | 'claim' | 'conflict';
  weight: number;
  metadata: Record<string, unknown>;
};

export type SearchEvidenceEdge = {
  from: string;
  to: string;
  relation: 'supports' | 'refines' | 'contradicts' | 'routes' | 'derived-from' | 'corroborates' | 'claims' | 'entails' | 'rebuts';
  weight: number;
};

export type ClaimAssessment = {
  premise: string;
  hypothesis: string;
  relation: 'entails' | 'contradicts' | 'unknown';
  confidence: number;
  rationale: string;
};

export type VerifiedClaim = {
  id: string;
  text: string;
  confidence: number;
  supportedBy: string[];
  contradictedBy: string[];
  verdict: 'supported' | 'contested' | 'unsupported';
  assessments: ClaimAssessment[];
};

export type EvidenceConflict = {
  claim: string;
  supporting: string[];
  contradicting: string[];
  resolution: string;
  confidence: number;
};

export type SearchEvidenceGraph = {
  nodes: SearchEvidenceNode[];
  edges: SearchEvidenceEdge[];
  queries: string[];
  claims: VerifiedClaim[];
  conflicts: EvidenceConflict[];
  summary: string;
  confidence: number;
};

export type SearchStrategyProfile = {
  id: string;
  name: string;
  description: string;
  sourceWeights: Record<SearchSource, number>;
  hopBias: number;
  freshnessBias: number;
  trustBias: number;
  semanticBias: number;
  uses: number;
  successes: number;
  failures: number;
  lastScore: number;
  lastUsedAt: number | null;
};

export type SearchSourceReliability = {
  source: SearchSource | string;
  score: number;
  uses: number;
  successes: number;
  failures: number;
  lastObservedAt: number | null;
  notes: string[];
};

export type SearchOutcome = {
  sessionKey: string;
  strategyId: string;
  query: string;
  source?: SearchSource | string;
  score: number;
  useful?: boolean;
  hopsUsed?: number;
  resultCount?: number;
  relevantCount?: number;
  notes?: string[];
};

export type SearchSignalForecast = {
  source: SearchSource | string;
  topic: string;
  confidence: number;
  reason: string;
  suggestedQueries: string[];
  priority: number;
  latentNeed: {
    label: string;
    features: Record<string, number>;
    horizon: 'immediate' | 'near-term' | 'later';
    intervention: string;
  };
};

export type SearchPolicyRule = {
  id: string;
  description: string;
  enabled: boolean;
  sourceWeights?: Partial<Record<SearchSource, number>>;
  maxHopBudget?: number;
  minTrustScore?: number;
  when?: { focus?: SearchFocus[]; freshness?: SearchFreshness[]; sources?: Array<SearchSource | string>; latentNeed?: string };
  actions?: Array<{ type: 'boost-source' | 'cap-hop-budget' | 'require-corroboration' | 'prefer-provider-nlu'; value: string; weight: number }>;
  guardrails: string[];
};

export type SearchPolicyState = {
  version: number;
  updatedAt: number;
  strategies: SearchStrategyProfile[];
  sourceReliability: Record<string, SearchSourceReliability>;
  queryProfiles: Record<string, { count: number; lastScore: number; lastUpdatedAt: number; averageScore: number; focus: SearchFocus; sourceHints: SearchSource[] }>;
  forecasts: SearchSignalForecast[];
  rules: SearchPolicyRule[];
  history: Array<{ version: number; state: Omit<SearchPolicyState, 'history'> }>;
  auditLog: Array<{ at: number; action: string; version: number; summary: string; accepted: boolean; guardrails: string[] }>;
};

export type SearchPlan = {
  intent: SearchIntent;
  strategy: SearchStrategyProfile;
  queries: string[];
  sourceRanking: Array<{ source: SearchSource | string; score: number; reason: string }>;
  hopPlan: string[];
  trustNotes: string[];
  predictedSignals: SearchSignalForecast[];
  evidenceGraph: SearchEvidenceGraph;
};
