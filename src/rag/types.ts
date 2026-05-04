export type MemoryDocument = {
  id: string;
  source: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  metadata: Record<string, unknown>;
  threadId?: string;
  relationshipId?: string;
  importance?: number;
};

export type DocumentLifecycle = 'relationship' | 'thread' | 'transactional' | 'preference' | 'reference' | 'filesystem' | 'calendar' | 'unknown';

export type ChunkRecord = {
  chunkId: string;
  documentId: string;
  position: number;
  text: string;
  tokenCount: number;
  termVector: Record<string, number>;
  embedding: number[];
  salience: number;
  recencyScore: number;
  lifecycle: DocumentLifecycle;
  source: string;
};

export type EmbeddingModel = {
  readonly dimension?: number;
  embedText(text: string): number[];
};

export type RetrievalQuery = {
  query: string;
  k: number;
  mode?: 'hybrid' | 'semantic' | 'lexical';
  filters?: {
    tags?: string[];
    source?: string[];
    documentIds?: string[];
    compaction?: {
      tokenBudget?: number;
      maxDocuments?: number;
      preserveLifecycle?: DocumentLifecycle[];
      preserveSources?: string[];
    };
  };
  boost?: {
    recency?: number;
    salience?: number;
    title?: number;
    exactPhrase?: number;
  };
};

export type RetrievalEvidenceHit = {
  chunkId: string;
  documentId: string;
  title: string;
  source: string;
  lifecycle: DocumentLifecycle;
  score: number;
  excerpt: string;
  rationale: string;
};

export type RetrievalHit = {
  chunkId: string;
  documentId: string;
  title: string;
  source: string;
  lifecycle: DocumentLifecycle;
  score: number;
  baseScore: number;
  lexicalScore: number;
  semanticScore: number;
  rerankScore: number;
  recencyScore: number;
  salienceScore: number;
  sourceScore: number;
  grade: 'strong' | 'usable' | 'weak';
  gradeScore: number;
  gradeRationale: string;
  phraseMatches: string[];
  excerpt: string;
  evidence: RetrievalEvidenceHit[];
};

export type RetrievalResult = {
  query: string;
  hits: RetrievalHit[];
  coverage: {
    chunksScanned: number;
    chunksIndexed: number;
    lexicalCandidates: number;
    vectorCandidates: number;
    gradedCandidates: number;
    documentsScanned: number;
    matchedDocuments: number;
  };
  trace: {
    tokens: string[];
    expandedTokens: string[];
    rewrites?: string[];
    stages: Array<{ name: string; topScore: number; notes: string[] }>;
    compaction?: {
      summary: string;
      budgetTokens: number;
      usedTokens: number;
      retained: number;
      dropped: number;
    };
    evidence?: Array<{
      anchorDocumentId: string;
      evidence: RetrievalEvidenceHit[];
    }>;
    needsFallback?: boolean;
  };
};

export type RagCorpusSnapshot = {
  version: 1;
  exportedAt: number;
  documents: MemoryDocument[];
  chunks: ChunkRecord[];
  lastCompaction: string | null;
};
