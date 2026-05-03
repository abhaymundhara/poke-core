import type { ConnectionRecord, ConnectionStore } from './types';

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly records = new Map<string, ConnectionRecord>();

  async list(): Promise<ConnectionRecord[]> {
    return [...this.records.values()].map((record) => ({
      ...record,
      metadata: { ...record.metadata },
      scopes: [...record.scopes],
    }));
  }

  async get(connectionId: string): Promise<ConnectionRecord | undefined> {
    const record = this.records.get(connectionId);
    if (!record) {
      return undefined;
    }
    return {
      ...record,
      metadata: { ...record.metadata },
      scopes: [...record.scopes],
    };
  }

  async upsert(record: ConnectionRecord): Promise<void> {
    this.records.set(record.connectionId, {
      ...record,
      metadata: { ...record.metadata },
      scopes: [...record.scopes],
    });
  }

  async delete(connectionId: string): Promise<boolean> {
    return this.records.delete(connectionId);
  }
}
