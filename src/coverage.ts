import { selectedResourceIds } from './engine/index.js';
import type { IntentCheck, TemplateJson } from './engine/index.js';
import type { CoverageRequirement } from './contract/intent.js';
import type { Coverage } from './contract/report.js';

/**
 * The denominator that makes a green run mean something.
 *
 * `cloudsynth verify` reporting "6/6 checks passed" is true and nearly
 * meaningless on its own: measured against this repo's own infrastructure
 * those six checks examined 12 of 765 resources. Nothing in a pass/fail
 * summary hints at that, and a reader cannot tell a thorough intent file from
 * a decorative one.
 *
 * ── What counts as examined ──────────────────────────────────────────────────
 * A resource is examined when some check SELECTS it — by type and logical-id
 * glob. Three consequences, each deliberate:
 *
 *  - `items` still counts. A check descending into a security group's inline
 *    ingress rules has looked at the security group.
 *  - `where` still counts. "Every method except OPTIONS needs auth" is a
 *    decision ABOUT the OPTIONS methods, not an absence of one.
 *  - An EXEMPTED resource counts as examined. It was consciously considered
 *    and deliberately carved out, with a reason, which is the opposite of
 *    nobody having looked. Coverage measures attention, and a `coverage`
 *    number that punished a documented exemption would push people toward
 *    deleting the check instead — the outcome exemptions exist to prevent.
 */

export interface CoverageInput {
  templates: { name: string; template: TemplateJson }[];
  checks: IntentCheck[];
  /** Resource types the file requires be fully examined. */
  require?: CoverageRequirement;
}

export function computeCoverage(input: CoverageInput): Coverage {
  const byType: Record<string, { total: number; examined: number }> = {};
  // Keyed by type, so a violation can name the individual resources nothing
  // looked at rather than reporting a count nobody can act on.
  const unexaminedByType = new Map<string, string[]>();

  for (const { template } of input.templates) {
    // Union across checks: two checks selecting the same bucket examine one
    // bucket. Summing per check would let a file inflate coverage by
    // restating a check it already had.
    const examined = new Set<string>();
    for (const check of input.checks) {
      for (const id of selectedResourceIds(template, check)) examined.add(id);
    }

    for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
      const type = resource?.Type;
      if (!type) continue;
      byType[type] ??= { total: 0, examined: 0 };
      byType[type].total += 1;
      if (examined.has(logicalId)) {
        byType[type].examined += 1;
      } else {
        unexaminedByType.set(type, [...(unexaminedByType.get(type) ?? []), logicalId]);
      }
    }
  }

  const required = input.require ?? [];
  const violations = required
    .map((type) => ({ type, logicalIds: unexaminedByType.get(type) ?? [] }))
    .filter((v) => v.logicalIds.length > 0);

  const totals = Object.values(byType);
  return {
    totalResources: totals.reduce((n, t) => n + t.total, 0),
    examinedResources: totals.reduce((n, t) => n + t.examined, 0),
    byType,
    required: [...required],
    violations,
  };
}

/** Types present in the templates but examined by nothing — the "what to write
 *  next" list. Not part of the report contract; the text renderer uses it. */
export function unexaminedTypes(coverage: Coverage): { type: string; count: number }[] {
  return Object.entries(coverage.byType)
    .filter(([, t]) => t.examined === 0)
    .map(([type, t]) => ({ type, count: t.total }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
