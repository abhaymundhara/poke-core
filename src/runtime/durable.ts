import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type DurableStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type DurableCheckpoint = {
  label: string;
  at: string;
  state?: unknown;
  note?: string;
};

export type DurableRunRecord<TInput = unknown, TOutput = unknown> = {
  id: string;
  kind: string;
  status: DurableStatus;
  createdAt: string;
  updatedAt: string;
  input: TInput;
  output?: TOutput;
  error?: string;
  checkpoints: DurableCheckpoint[];
};

export class JsonFileDurableStore<TInput = unknown, TOutput = unknown> {
  constructor(private rootDir: string) {}

  private pathFor(id: string): string {
    return join(this.rootDir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async create(kind: string, input: TInput): Promise<DurableRunRecord<TInput, TOutput>> {
    await this.ensureDir();
    const record: DurableRunRecord<TInput, TOutput> = {
      id: randomUUID(),
      kind,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      input,
      checkpoints: [],
    };
    await this.save(record);
    return record;
  }

  async save(record: DurableRunRecord<TInput, TOutput>): Promise<void> {
    await this.ensureDir();
    record.updatedAt = new Date().toISOString();
    await writeFile(this.pathFor(record.id), JSON.stringify(record, null, 2), 'utf8');
  }

  async get(id: string): Promise<DurableRunRecord<TInput, TOutput> | null> {
    try {
      const raw = await readFile(this.pathFor(id), 'utf8');
      return JSON.parse(raw) as DurableRunRecord<TInput, TOutput>;
    } catch {
      return null;
    }
  }

  async list(kind?: string): Promise<DurableRunRecord<TInput, TOutput>[]> {
    await this.ensureDir();
    const files = await readdir(this.rootDir);
    const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
      try {
        const raw = await readFile(join(this.rootDir, file), 'utf8');
        return JSON.parse(raw) as DurableRunRecord<TInput, TOutput>;
      } catch {
        return null;
      }
    }));
    return records.filter((record): record is DurableRunRecord<TInput, TOutput> => Boolean(record) && (!kind || record.kind === kind));
  }

  async checkpoint(id: string, label: string, state?: unknown, note?: string): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.mustGet(id);
    record.checkpoints.push({ label, at: new Date().toISOString(), state, note });
    await this.save(record);
    return record;
  }

  async complete(id: string, output: TOutput): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.mustGet(id);
    record.status = 'succeeded';
    record.output = output;
    record.error = undefined;
    await this.save(record);
    return record;
  }

  async fail(id: string, error: unknown): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.mustGet(id);
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    await this.save(record);
    return record;
  }

  async resume(id: string): Promise<DurableRunRecord<TInput, TOutput>> {
    return await this.mustGet(id);
  }

  private async mustGet(id: string): Promise<DurableRunRecord<TInput, TOutput>> {
    const record = await this.get(id);
    if (!record) throw new Error(`durable run not found: ${id}`);
    return record;
  }
}
