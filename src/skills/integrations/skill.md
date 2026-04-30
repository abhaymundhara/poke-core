# integrations skill

## mission

the integrations skill is the provider router for structured external systems such as github, notion, linear, todoist, vercel, slack, and future custom mcp services.

it resolves the right provider, validates the action shape, and keeps side effects idempotent and observable.

## core capabilities

- route actions to the correct provider adapter
- normalize provider-specific payloads into a stable execution contract
- support dry-run, read, and write semantics
- preserve external ids and provider response artifacts
- coordinate retries, confirmation, and compensation where needed

## boundaries

- never guess which provider should own the action when multiple are plausible
- never execute a destructive write without a clear intent and idempotency strategy
- never hide provider errors behind a false success
- never mix state from one integration into another
- never mutate external records without recording the external identifier and action context

## input schema

```ts
type IntegrationSkillInput = {
  provider: 'github' | 'notion' | 'linear' | 'todoist' | 'vercel' | 'slack' | string
  action: string
  mode: 'read' | 'write' | 'dry-run' | 'compensate'
  payload: Record<string, unknown>
  idempotencyKey?: string
  threadId?: string
  confirmationState?: 'required' | 'confirmed' | 'not-required'
  retryPolicy?: {
    maxAttempts: number
    retryableStatuses: string[]
  }
}
```

## output schema

```ts
type IntegrationSkillOutput = {
  ok: boolean
  output: {
    provider: string
    action: string
    mode: 'read' | 'write' | 'dry-run' | 'compensate'
    externalIds?: string[]
    artifact?: unknown
    riskFlags?: string[]
    nextAction: 'confirm' | 'retry' | 'continue' | 'clarify' | 'done'
  }
  retryable: boolean
  note?: string
  trace?: Record<string, unknown>
}
```

## failure modes

- unsupported provider or action
- auth or permission failure
- rate limit or temporary upstream outage
- duplicate write attempt without stable idempotency
- stale external object snapshot
- partial success with incomplete downstream writes

## recovery logic

- validate provider and action before dispatch
- use idempotency keys for any write path that could be retried
- if a write partially succeeds, fetch the external record to reconcile before retrying
- if the provider is ambiguous, return a clear clarification request
- if the action is read-only, prefer dry-run-compatible shapes even when the provider supports writes
- if compensation exists, prefer it over blind retry after a side effect

## advanced league implementation details

- separate capability routing from execution so the orchestrator can add new providers without changing control flow
- normalize provider responses into a common artifact envelope
- preserve exact provider ids for all created or updated records
- support action-level dry runs to surface risk before committing
- keep provider adapters small and purpose-built
- make the contract explicit enough that new integrations can be added with zero guesswork
- when a task could live in multiple integrations, use parallel inspection and then select the source of truth

## quality bar

a provider action should be traceable, replayable, and safe to retry or compensate if the upstream system misbehaves
