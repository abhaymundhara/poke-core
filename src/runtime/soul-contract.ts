import type { ContextWindowSegment } from '../types.ts';

export type ContextCompactionTelemetry = {
  source: string;
  budget: number;
  inputTokens: number;
  outputTokens: number;
  overflowTokens: number;
  knowledgeOverhangTokens: number;
  selectedSegments: number;
  compactedSegments: number;
  selectedTokenEstimate: number;
  compactedTokenEstimate: number;
  efficiency: number;
};

export type ParityRegressionEvalReport = {
  name: string;
  artifactSha: string;
  baselineSha: string;
  passed: boolean;
  details: string;
  measuredAt: string;
};

export type ParityRegressionEvalEntrypoint = {
  name: string;
  artifactSha: string;
  baselineSha: string;
  run: () => Promise<ParityRegressionEvalReport> | ParityRegressionEvalReport;
};

export type FailureTrigger = {
  name: string;
  condition: string;
  severity: 'warn' | 'rollback';
  rollbackTo: string;
  evidence: string[];
};

export type FailureTelemetry = {
  trigger: string;
  contract: string;
  artifactSha: string;
  rollbackTo: string;
  reason: string;
  evidence: string[];
  emittedAt: string;
};

export type SoulPrimitiveBinding = {
  name: string;
  role: 'compactor' | 'nlu' | 'identity' | 'planner' | 'verifier' | 'memory';
  source: string;
  guaranteed: boolean;
};

export type SoulContractGate = {
  name: string;
  passed: boolean;
  details: string;
};

export type SoulContractManifest = {
  compaction: ContextCompactionTelemetry;
  primitives: SoulPrimitiveBinding[];
  evalEntrypoints: ParityRegressionEvalEntrypoint[];
  failureTriggers: FailureTrigger[];
  regressionGates: SoulContractGate[];
};

export type SoulContractVerification = {
  ok: boolean;
  telemetry: ContextCompactionTelemetry;
  gates: SoulContractGate[];
  failures: FailureTelemetry[];
  reasons: string[];
};

export function buildContextCompactionTelemetry(input: {
  source: string;
  budget: number;
  selectedSegments: number;
  compactedSegments: number;
  selectedTokenEstimate: number;
  compactedTokenEstimate: number;
  overflowTokens: number;
}): ContextCompactionTelemetry {
  const inputTokens = Math.max(0, input.selectedTokenEstimate + input.compactedTokenEstimate + input.overflowTokens);
  const outputTokens = Math.max(0, input.selectedTokenEstimate + input.compactedTokenEstimate);
  return {
    source: input.source,
    budget: Math.max(0, input.budget),
    inputTokens,
    outputTokens,
    overflowTokens: Math.max(0, input.overflowTokens),
    knowledgeOverhangTokens: Math.max(0, input.overflowTokens),
    selectedSegments: Math.max(0, input.selectedSegments),
    compactedSegments: Math.max(0, input.compactedSegments),
    selectedTokenEstimate: Math.max(0, input.selectedTokenEstimate),
    compactedTokenEstimate: Math.max(0, input.compactedTokenEstimate),
    efficiency: inputTokens > 0 ? outputTokens / inputTokens : 0,
  };
}

export function createSoulContractManifest(input: {
  compaction: ContextCompactionTelemetry;
  primitives: SoulPrimitiveBinding[];
  evalEntrypoints: ParityRegressionEvalEntrypoint[];
  failureTriggers: FailureTrigger[];
  regressionGates?: SoulContractGate[];
}): SoulContractManifest {
  return {
    compaction: input.compaction,
    primitives: input.primitives,
    evalEntrypoints: input.evalEntrypoints,
    failureTriggers: input.failureTriggers,
    regressionGates: input.regressionGates ?? [],
  };
}

function gateMessage(name: string, passed: boolean, details: string): SoulContractGate {
  return { name, passed, details };
}

export async function verifySoulContractManifest(manifest: SoulContractManifest): Promise<SoulContractVerification> {
  const gates: SoulContractGate[] = [];
  const failures: FailureTelemetry[] = [];
  const reasons: string[] = [];
  const entrypointNames = new Set<string>();

  const registerGate = (name: string, passed: boolean, details: string): void => {
    gates.push(gateMessage(name, passed, details));
    if (!passed) reasons.push(name + ': ' + details);
  };

  registerGate(
    'compaction.telemetry.present',
    manifest.compaction.inputTokens > 0 && manifest.compaction.outputTokens > 0,
    'input=' + manifest.compaction.inputTokens + ' output=' + manifest.compaction.outputTokens,
  );
  registerGate(
    'compaction.efficiency.in_range',
    manifest.compaction.efficiency > 0 && manifest.compaction.efficiency <= 1,
    'efficiency=' + manifest.compaction.efficiency.toFixed(4),
  );
  registerGate(
    'compaction.overhang.tracked',
    manifest.compaction.knowledgeOverhangTokens >= 0,
    'knowledgeOverhangTokens=' + manifest.compaction.knowledgeOverhangTokens,
  );
  registerGate(
    'primitives.compactor.bound',
    manifest.primitives.some((primitive) => primitive.role === 'compactor' && primitive.guaranteed && primitive.source.length > 0),
    'compactor=' + (manifest.primitives.find((primitive) => primitive.role === 'compactor')?.source ?? 'missing'),
  );
  registerGate(
    'primitives.domain_specific.bound',
    manifest.primitives.some((primitive) => primitive.role !== 'compactor' && primitive.guaranteed && primitive.source.length > 0),
    'domainPrimitives=' + manifest.primitives.filter((primitive) => primitive.role !== 'compactor').length,
  );
  registerGate(
    'eval.entrypoints.present',
    manifest.evalEntrypoints.length > 0,
    'count=' + manifest.evalEntrypoints.length,
  );
  registerGate(
    'failure.triggers.present',
    manifest.failureTriggers.length > 0,
    'count=' + manifest.failureTriggers.length,
  );
  registerGate(
    'rollback.triggers.present',
    manifest.failureTriggers.some((trigger) => trigger.severity === 'rollback'),
    'rollbackTriggers=' + manifest.failureTriggers.filter((trigger) => trigger.severity === 'rollback').length,
  );

  for (const entrypoint of manifest.evalEntrypoints) {
    if (entrypointNames.has(entrypoint.name)) {
      const details = 'duplicate entrypoint ' + entrypoint.name;
      registerGate('eval.' + entrypoint.name + '.unique', false, details);
      failures.push({
        trigger: entrypoint.name,
        contract: 'parity-regression-entrypoint',
        artifactSha: entrypoint.artifactSha,
        rollbackTo: entrypoint.baselineSha,
        reason: details,
        evidence: [entrypoint.name],
        emittedAt: new Date().toISOString(),
      });
      continue;
    }
    entrypointNames.add(entrypoint.name);
    const report = await entrypoint.run();
    registerGate(
      'eval.' + entrypoint.name,
      report.passed,
      report.details + ' baseline=' + report.baselineSha + ' current=' + report.artifactSha,
    );
    if (!report.passed) {
      failures.push({
        trigger: entrypoint.name,
        contract: 'parity-regression-entrypoint',
        artifactSha: report.artifactSha,
        rollbackTo: report.baselineSha,
        reason: report.details,
        evidence: [report.details],
        emittedAt: report.measuredAt,
      });
    }
  }

  if (gates.some((gate) => !gate.passed)) {
    for (const trigger of manifest.failureTriggers) {
      if (trigger.severity === 'rollback') {
        failures.push({
          trigger: trigger.name,
          contract: trigger.condition,
          artifactSha: manifest.evalEntrypoints[0]?.artifactSha ?? 'unknown',
          rollbackTo: trigger.rollbackTo,
          reason: trigger.condition,
          evidence: trigger.evidence,
          emittedAt: new Date().toISOString(),
        });
      }
    }
  }

  const ok = gates.every((gate) => gate.passed) && failures.length === 0;
  return {
    ok,
    telemetry: manifest.compaction,
    gates: [...manifest.regressionGates, ...gates],
    failures,
    reasons,
  };
}
