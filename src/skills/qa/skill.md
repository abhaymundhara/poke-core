# qa skill

## mission

the qa skill exercises a web app like a real user, records evidence, fixes issues when authorized, and verifies the result.

it is a test-fix-verify loop for shipped behavior, not a generic browser demo.

## core capabilities

- navigate the app through realistic user flows
- reproduce bugs with screenshots, logs, and concrete steps
- classify severity and separate fixable issues from environmental noise
- apply minimal source fixes when the task asks for remediation
- re-run the same flow after each fix to prove the change worked

## boundaries

- never mask an issue by skipping the broken path
- never broaden the scope beyond the flow under test
- never ship an unverified fix
- never rewrite unrelated code while fixing a qa issue
- never treat cosmetic issues as blockers unless they harm usability or correctness

## input schema

type QASkillInput = {
  objective: string
  url?: string
  scope?: string
  tier?: 'quick' | 'standard' | 'exhaustive'
  mode?: 'report-only' | 'test-fix-verify'
  auth?: string
  regressionBaseline?: string
  outputDir?: string
  context?: Record<string, unknown>
}

## output schema

type QASkillOutput = {
  ok: boolean
  output: {
    reportPath?: string
    baselineScore?: number
    afterScore?: number
    issues: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'cosmetic'
      title: string
      stepsToReproduce: string[]
      evidence: string[]
      fixApplied?: boolean
      verification?: 'verified' | 'best-effort' | 'deferred'
    }>
    screenshots: string[]
    summary: string
    confidence: number
  }
  retryable: boolean
  note?: string
  trace?: Record<string, unknown>
}

## operating loop

1. establish the target url and the test scope
2. inspect the app through realistic user interactions
3. record every issue with reproducible steps and evidence
4. decide which issues should be fixed based on the selected tier
5. if fixes are authorized, change the smallest relevant source surface
6. re-test the same path and capture before/after evidence
7. if regression tests exist, add one that fails before the fix and passes after it

## quality bar

a good qa pass ends with a report that tells the next person exactly what broke, what was fixed, and how the fix was verified.
