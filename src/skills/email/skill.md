# email skill

## mission

the email skill handles inbox search, thread reconstruction, drafting, replying, forwarding, and send-side confirmation with full provenance.

it must understand thread context, recipient intent, attachment lineage, and the difference between preview and irreversible send.

## core capabilities

- search across mailboxes using sender, subject, content, time, labels, and attachment clues
- reconstruct threads and identify the latest actionable message
- draft replies and forwards with preserved quoting and attachment handling
- summarize inbox findings into structured action candidates
- classify urgent, informational, and confirmation-required messages
- maintain provider differences without leaking them into the user experience

## boundaries

- never send, forward, or reply without explicit user confirmation
- never invent recipients, subjects, or thread context
- never strip attachment provenance or reorder quoted content carelessly
- never assume gmail and outlook behave identically
- never confuse message metadata with the actual human intent
- never act on incoming automated messages unless the current task explicitly authorizes it

## input schema

```ts
type EmailSkillInput = {
  mode: 'search' | 'summarize' | 'draft' | 'reply' | 'forward' | 'send' | 'label' | 'archive'
  query?: string
  threadId?: string
  messageId?: string
  draftId?: string
  recipients?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  body?: string
  attachments?: Array<{
    name: string
    source: 'existing' | 'user-provided' | 'generated'
    reference?: string
  }>
  confirmationState?: 'required' | 'confirmed' | 'not-required'
  mailboxHints?: {
    provider?: 'gmail' | 'outlook'
    account?: string
    labels?: string[]
  }
  searchStrategy?: {
    parallelSources?: string[]
    maxResults?: number
    dateWindow?: string
  }
}
```

## output schema

```ts
type EmailSkillOutput = {
  ok: boolean
  output: {
    threadId?: string
    messageId?: string
    draftId?: string
    matches?: Array<{
      messageId: string
      threadId?: string
      subject?: string
      sender?: string
      snippet?: string
      reason?: string
    }>
    draft?: {
      recipients: string[]
      subject: string
      body: string
      attachments: string[]
      riskFlags: string[]
    }
    threadSummary?: string
    nextAction: 'confirm' | 'send' | 'continue-search' | 'clarify' | 'done'
  }
  retryable: boolean
  note?: string
  trace?: Record<string, unknown>
}
```

## failure modes

- ambiguous recipient or unresolved alias
- missing thread context
- attachment mismatch or broken attachment reference
- provider limitations or unsupported mailbox features
- rate limits and temporary sync delays
- quoting drift in deep threads
- partial search results from only one mailbox when multiple were relevant

## recovery logic

- search parallel sources when the request could plausibly live in more than one mailbox
- resolve contacts and thread participants before drafting
- preserve the latest human message when reconstructing a reply
- use explicit confirmation boundaries before send-side actions
- if a draft is weak, improve it before surfacing it rather than asking the user to clean it up
- if provider behavior diverges, normalize it behind the skill boundary

## advanced league implementation details

- thread-first reasoning: identify the active human intent before touching compose state
- mailbox-normalized search: email search should be driven by semantics, not just raw text matching
- idempotent send strategy: repeated confirmations should not duplicate sends
- attachment provenance: every attachment should be traceable to its source or generation step
- risk scoring: flag drafts that are ambiguous, multi-party, or likely to require clarification
- multi-source retrieval: if the answer may be in email and documents, search both in parallel and merge results
- inbox summarization: produce concise action candidates with the exact message ids needed for follow-up

## quality bar

the email skill should be able to explain what it found, what it would do, and what still needs confirmation without losing thread integrity
