# browser skill

## mission

the browser skill navigates volatile web surfaces, extracts durable evidence, and maintains a page-state trail across multi-step interactions.

it is not a generic click machine. it is a stateful browser operator that reasons about page transitions, selector stability, and evidence capture.

## core capabilities

- multi-step navigation across pages, redirects, and in-page transitions
- text and structured extraction from live dom state
- safe interaction with selectors, forms, and links when explicitly requested
- capture of page evidence for replay and audit
- session continuity across related browser steps

## boundaries

- never enter passwords or bypass authentication controls
- never use browser access when email, calendar, filesystem, or integrations can solve the task more directly
- never assume a page is stable just because it loaded once
- never click blindly when a selector or stable anchor exists
- never discard the current url, redirect chain, or extracted evidence
- never perform side effects beyond the explicit objective

## input schema

```ts
type BrowserSkillInput = {
  objective: string
  url?: string
  mode: 'navigate' | 'extract' | 'interact' | 'audit'
  selectors?: string[]
  expectedArtifacts?: string[]
  state?: {
    currentUrl?: string
    history?: string[]
    selectedText?: string
    knownAnchors?: string[]
  }
  interactionPlan?: Array<{
    action: 'click' | 'type' | 'press' | 'select' | 'wait'
    selector?: string
    value?: string
    label?: string
  }>
  retryPolicy?: {
    maxAttempts: number
    backoffMs: number
    recoverableFailures: string[]
  }
}
```

## output schema

```ts
type BrowserSkillOutput = {
  ok: boolean
  output: {
    finalUrl?: string
    title?: string
    text?: string
    htmlDigest?: string
    artifacts: Array<{
      kind: 'text' | 'screenshot' | 'dom' | 'link' | 'form-state'
      value: unknown
    }>
    navigationTrail: Array<{
      from: string
      to: string
      reason: string
    }>
    confidence: number
  }
  retryable: boolean
  note?: string
  trace?: Record<string, unknown>
}
```

## failure modes

- redirect loops
- stale or missing selectors
- lazy-loaded content that has not hydrated yet
- cross-origin iframe content that cannot be read directly
- anti-bot or rate-limit responses
- partial extraction where visible text is not representative
- navigation state lost between steps

## recovery logic

- re-read current url before each step
- prefer stable semantic anchors over brittle nth-child selectors
- retry with backoff when the failure is transient
- if a selector fails, fall back to a broader container and then to visible text extraction
- if a step mutates page state unexpectedly, snapshot what changed and revert by navigating back when safe
- if the page is protected, stop and escalate rather than guessing

## advanced league implementation details

- treat browsing as a graph, not a single request
- preserve navigation provenance and page title evolution
- record the url before and after every significant action
- compute a lightweight digest of the visible page so repeated steps can detect drift
- separate discovery from mutation
- use a deterministic interaction plan with explicit selectors and labels
- when extracting, prefer semantically meaningful text blocks over raw body dumps
- when the task includes multiple independent pages, branch work in parallel and merge evidence afterward
- never lose the browser context just because the current step succeeded

## quality bar

the browser skill should leave behind a traceable paper trail: where it went, what it saw, what it changed, and what evidence was collected
