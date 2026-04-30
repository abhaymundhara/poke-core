export type GraphNodeId = string;

export type GraphNode<TState> = {
  id: GraphNodeId;
  name: string;
  run: (state: TState) => Promise<TState> | TState;
  retryPolicy?: {
    maxAttempts: number;
    retryableErrors: string[];
    backoffMs?: number;
  };
};

export type GraphEdge = {
  from: GraphNodeId;
  to: GraphNodeId;
  condition?: (state: unknown) => boolean;
  label?: string;
};

export type GraphCheckpoint<TState> = {
  nodeId: GraphNodeId;
  state: TState;
  at: number;
  attempt: number;
  error?: string;
};

export type GraphExecutionResult<TState> = {
  state: TState;
  visited: GraphCheckpoint<TState>[];
};

export class GraphExecutor<TState extends Record<string, any>> {
  constructor(private nodes: GraphNode<TState>[], private edges: GraphEdge[]) {}

  async run(initialState: TState, startNodeId?: string): Promise<GraphExecutionResult<TState>> {
    const nodeMap = new Map(this.nodes.map((node) => [node.id, node] as const));
    const checkpoints: GraphCheckpoint<TState>[] = [];
    let currentId = startNodeId ?? this.nodes[0]?.id;
    let state = initialState;

    while (currentId) {
      const node = nodeMap.get(currentId);
      if (!node) throw new Error(`graph node not found: ${currentId}`);
      const maxAttempts = node.retryPolicy?.maxAttempts ?? 1;
      const retryableErrors = new Set(node.retryPolicy?.retryableErrors ?? []);
      let attempt = 0;
      let lastError: unknown = null;

      while (attempt < maxAttempts) {
        try {
          state = await node.run(state);
          checkpoints.push({ nodeId: node.id, state: structuredClone(state), at: Date.now(), attempt });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          attempt += 1;
          checkpoints.push({ nodeId: node.id, state: structuredClone(state), at: Date.now(), attempt, error: err instanceof Error ? err.message : String(err) });
          const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
          const retryable = [...retryableErrors].some((pattern) => message.includes(pattern.toLowerCase()));
          if (attempt >= maxAttempts || !retryable) throw err;
          await new Promise((resolve) => setTimeout(resolve, node.retryPolicy?.backoffMs ?? 0));
        }
      }

      const next = this.edges.find((edge) => edge.from === node.id && (!edge.condition || edge.condition(state)));
      if (!next) break;
      currentId = next.to;
    }

    return { state, visited: checkpoints };
  }
}
