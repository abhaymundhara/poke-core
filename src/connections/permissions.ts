import type { PermissionDecision, PermissionRule, PermissionScope, PermissionSubject } from './types';

const SCOPE_ORDER: PermissionScope[] = ['read', 'write', 'admin'];

function normalizeScopes(scopes: PermissionScope[]): PermissionScope[] {
  const values = Array.from(new Set(scopes));
  values.sort((left, right) => SCOPE_ORDER.indexOf(left) - SCOPE_ORDER.indexOf(right));
  return values;
}

function scopeCovers(granted: PermissionScope, required: PermissionScope): boolean {
  return SCOPE_ORDER.indexOf(granted) >= SCOPE_ORDER.indexOf(required);
}

export class PermissionRegistry {
  private readonly rules = new Map<string, PermissionRule[]>();

  register(rule: PermissionRule): this {
    const key = this.keyFor({ subject: rule.subject, action: rule.action, provider: rule.provider });
    const current = this.rules.get(key) ?? [];
    const next = current.filter((item) => !(item.subject === rule.subject && item.action === rule.action && item.provider === rule.provider));
    next.push({ ...rule, scopes: normalizeScopes(rule.scopes) });
    this.rules.set(key, next);
    return this;
  }

  requiredScopes(subject: PermissionSubject): PermissionRule | undefined {
    return this.lookup(subject);
  }

  authorize(subject: PermissionSubject, grantedScopes: PermissionScope[] = []): PermissionDecision {
    const rule = this.lookup(subject);
    const requiredScopes = rule?.scopes ?? [];
    const normalizedGranted = normalizeScopes(grantedScopes);
    const missingScopes = requiredScopes.filter((scope) => !normalizedGranted.some((item) => scopeCovers(item, scope)));
    return {
      allowed: requiredScopes.length === 0 ? true : missingScopes.length === 0,
      requiredScopes,
      grantedScopes: normalizedGranted,
      missingScopes,
      rule,
    };
  }

  ensure(subject: PermissionSubject, grantedScopes: PermissionScope[] = []): PermissionDecision {
    const decision = this.authorize(subject, grantedScopes);
    if (!decision.allowed) {
      throw new Error('missing required permission scopes: ' + decision.missingScopes.join(', '));
    }
    return decision;
  }

  listRules(): PermissionRule[] {
    return [...this.rules.values()].flat().map((rule) => ({ ...rule, scopes: [...rule.scopes] }));
  }

  private lookup(subject: PermissionSubject): PermissionRule | undefined {
    const exact = this.rules.get(this.keyFor(subject)) ?? [];
    if (exact.length > 0) {
      return exact[exact.length - 1];
    }
    const providerSpecific = this.rules.get(this.keyFor({ subject: subject.subject, action: subject.action, provider: '*' })) ?? [];
    if (providerSpecific.length > 0) {
      return providerSpecific[providerSpecific.length - 1];
    }
    const subjectOnly = this.rules.get(this.keyFor({ subject: subject.subject, action: '*', provider: '*' })) ?? [];
    return subjectOnly[subjectOnly.length - 1];
  }

  private keyFor(subject: PermissionSubject): string {
    return [subject.subject ?? '*', subject.action ?? '*', subject.provider ?? '*'].join('::');
  }
}
