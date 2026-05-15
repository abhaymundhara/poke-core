# review skill

## mission

the review skill performs a pre-merge code review against the current diff and the base branch. it is a structural review, not a surface-level style pass.

it is meant to catch the problems tests often miss: trust-boundary violations, unsafe side effects, concurrency hazards, incomplete enum handling, stale docs, and missing recovery paths.

## core capabilities

- compare the current worktree or pull request diff against the base branch
- inspect the surrounding code paths outside the diff when completeness depends on sibling handlers or shared types
- identify concrete, actionable findings with file and line references
- separate blocking correctness issues from informational cleanup
- highlight missing tests, stale documentation, and rollout risk

## boundaries

- never guess at a bug without reading the relevant code path
- never flag style issues as review findings unless they create maintainability or correctness risk
- never recommend a fix without verifying that the pattern matches the codebase
- never ignore surrounding handlers when a new enum, status, or branch is introduced
- never call something safe unless the code path proves it

## input schema

type ReviewSkillInput = {
  objective: string
  baseBranch?: string
  diffScope?: 'pr' | 'worktree' | 'file'
  files?: string[]
  findingsOnly?: boolean
  context?: {
    repo?: string
    branch?: string
    summary?: string
    knownRisks?: string[]
  }
}

## output schema

type ReviewSkillOutput = {
  ok: boolean
  output: {
    verdict: 'clear' | 'changes-needed' | 'needs-followup'
    findings: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'informational'
      file: string
      line?: number
      summary: string
      evidence: string[]
      recommendedFix?: string
    }>
    coverageNotes: string[]
    missingChecks: string[]
    confidence: number
  }
  retryable: boolean
  note?: string
  trace?: Record<string, unknown>
}

## operating loop

1. confirm the branch or diff scope being reviewed
2. read the changed files and the neighboring code that shapes their behavior
3. check for correctness hazards first, then completeness, then documentation drift
4. compare introduced types or values against all call sites and sibling handlers
5. write findings with exact evidence, not vibes
6. if the task includes fixes, make the smallest safe change and re-check the affected path

## quality bar

a good review leaves behind exact, defensible findings and makes it obvious what must change before merge.
