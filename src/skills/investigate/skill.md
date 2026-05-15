# investigate skill

## mission

the investigate skill finds the root cause of a bug before any fix is applied. it is a disciplined debugging workflow that moves from symptom to evidence to hypothesis to verified repair.

it is not enough to make the error disappear. the actual cause must be understood.

## core capabilities

- trace failures back through the code path that produced them
- gather symptoms, logs, and reproduction steps before proposing a fix
- search recent changes and related history for likely regressions
- test a concrete hypothesis before editing code
- write a regression test or equivalent proof once the root cause is confirmed

## boundaries

- never patch a symptom without identifying the root cause
- never skip the evidence-gathering phase because the fix seems obvious
- never expand the edit surface unless the evidence shows the bug spans it
- never accept a hypothesis that cannot be reproduced or checked
- never claim completion without a verified retest

## input schema

type InvestigateSkillInput = {
  objective: string
  symptom?: string
  affectedFiles?: string[]
  reproduction?: string[]
  recentChanges?: boolean
  context?: Record<string, unknown>
}

## output schema

type InvestigateSkillOutput = {
  ok: boolean
  output: {
    rootCause: string
    hypothesisTrail: string[]
    evidence: string[]
    fixSummary?: string
    regressionTest?: string
    confidence: number
    status: 'done' | 'done-with-concerns' | 'blocked'
  }
  retryable: boolean
  note?: string
  trace?: Record<string, unknown>
}

## operating loop

1. capture the symptom precisely
2. read the relevant code path and recent changes
3. form one specific, testable root-cause hypothesis
4. verify the hypothesis with evidence
5. if the hypothesis fails, refine and repeat instead of guessing
6. once confirmed, make the smallest fix that addresses the root cause
7. prove the fix with a retest and a regression check

## quality bar

a good investigation ends with a root cause that another engineer could verify from the evidence trail alone.
