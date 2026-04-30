# filesystem skill

## mission

the filesystem skill is the local control plane for reading, writing, diffing, and exporting workspace artifacts safely.

it is responsible for deterministic file operations with rollback-friendly behavior.

## core capabilities

- read text and binary-aware metadata
- write files atomically
- compute diffs and content hashes
- export artifacts for downstream steps
- scan directory trees with bounded traversal
- stage changes before commit-like promotion

## boundaries

- never traverse outside the permitted workspace boundary
- never follow symlinks blindly
- never overwrite destructive paths without explicit intent
- never mutate files without preserving a rollback path
- never assume text encoding when a file may be binary
- never recursively scan without depth and entry limits

## input schema

```ts
type FilesystemSkillInput = {
  mode: 'read' | 'write' | 'append' | 'diff' | 'list' | 'stat' | 'hash' | 'export'
  path: string
  content?: string | Uint8Array
  encoding?: 'utf8' | 'base64'
  recursive?: boolean
  maxDepth?: number
  includeHidden?: boolean
  preserveBackup?: boolean
  atomicWrite?: boolean
  allowSymlinks?: boolean
  baselinePath?: string
}
```

## output schema

```ts
type FilesystemSkillOutput = {
  ok: boolean
  output: {
    path: string
    size?: number
    hash?: string
    contents?: string
    diff?: string
    entries?: Array<{
      path: string
      type: 'file' | 'dir' | 'symlink'
      size?: number
    }>
    warnings?: string[]
    backupPath?: string
  }
  retryable: boolean
  note?: string
  trace?: Record<string, unknown>
}
```

## failure modes

- path traversal attempts
- symlink escape
- partial write or interrupted rename
- binary file misread as text
- very large file read without bounds
- permission denied
- missing baseline for diff

## recovery logic

- stage writes to a temp file and rename atomically
- capture a backup before destructive edits
- verify hash after write
- refuse unsafe traversal unless explicitly allowed
- degrade to metadata-only inspection when content is too large or binary
- if a diff cannot be computed, surface the reason rather than inventing one

## advanced league implementation details

- treat the filesystem as a transactional surface
- preserve deterministic ordering in directory scans
- produce stable diffs so downstream agents can reason about edits
- use content hashes to detect drift between read and write
- keep artifact exports separate from source paths
- record the exact pre-write state so rollback can be precise
- prefer small, bounded edits over broad rewrites unless the task demands it

## quality bar

a filesystem action should always be auditable: what changed, where it changed, and how to undo it if needed
