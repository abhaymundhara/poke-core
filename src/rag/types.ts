export type MemoryDocument = {
  id: string;
  source: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  metadata: Record<string, unknown>;
};

export type ChunkRecord = {
  chunkId: string;
  documentId: string;
  position: number;
  text: string;
  tokenCount: number;
  termVector: Record<string, number>;
  salience: number;
  recencyScore: number;
};

export type RetrievalQuery = {
  query: string;
  k: number;
  filters?: {
    tags?: string[];
    source?: string[];
    documentIds?: string[];
  };
  boost?: {
    recency?: number;
    salience?: number;
    title?: number;
    exactPhrase?: number;
  };
};

export type RetrievalHit = {
  chunkId: string;
  documentId: string;
  title: string;
  source: string;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  recencyScore: number;
  salienceScore: number;
  phraseMatches: string[];
  excerpt: string;
};

export type RetrievalResult = {
  query: string;
  hits: RetrievalHit[];
  coverage: {
    chunksScanned: number;
    documentsScanned: number;
    matchedDocuments: number;
  };
  trace: {
    tokens: string[];
    expandedTokens: string[];
    stages: Array<{ name: string; topScore: number; notes: string[] }>;
  };
};
