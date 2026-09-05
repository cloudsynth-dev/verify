import type {
  IntentCheck,
  IntentExpectation,
  IntentPredicate,
  IntentSource,
} from '../contract/intent.js';

/**
 * The intent evaluator.
 *
 * Kept separate from the parser and from the compiler so the semantics can be
 * unit-tested against plain objects, with no YAML and no synthesized template
 * in the way. Every rule below is one a reviewer can apply by hand to a
 * CloudFormation template — that is the whole design constraint, and it is why
 * there is no expression language here.
 *
 * It operates on PLAIN CloudFormation JSON, deliberately, not on aws-cdk-lib's
 * Template. The only thing it ever needed was "resources of this type", which is
 * one Object.entries filter — and depending on aws-cdk-lib for that would drag
 * the whole CDK into any bundle that wants to evaluate a check. That matters
 * concretely: the web tier re-runs intent in the BROWSER when someone edits the
 * YAML, and shipping aws-cdk-lib to the browser is both enormous and a breach of
 * the rule that the web image never contains the synth engine.
 */

/** The subset of a CloudFormation document this module reads. */
export interface TemplateJson {
  Resources?: Record<string, { Type?: string; Properties?: unknown }>;
}

function resourcesOfType(
  template: TemplateJson,
  type: string,
): Array<[string, { Properties?: unknown }]> {
  return Object.entries(template.Resources ?? {}).filter(([, r]) => r?.Type === type);
}

/** One thing a check is asserted against: a resource, or an element of an
 *  array inside one (an ingress rule, a policy statement). */
export interface Subject {
  /** How it is named in a failure message — `Uploads` or `Policy.Statement[1]`. */
  label: string;
  /**
   * The RESOURCE this subject belongs to, always — `Uploads` for both of the
   * labels above.
   *
   * Carried separately because exemptions match on the resource, and a check
   * using `items` has subjects whose labels are array elements. Deriving the
   * resource by truncating the label at the first dot would be wrong the
   * moment a logical id contains one, which CDK ids routinely do.
   */
  logicalId: string;
  value: Record<string, unknown>;
}

/** Logical-id glob. `*` is the only metacharacter; everything else is escaped,
 *  so a resource id containing regex punctuation cannot become a wildcard. */
export function matchesGlob(logicalId: string, glob: string): boolean {
  const pattern = glob
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(logicalId);
}

/** Dot-path lookup. Returns undefined for any missing link in the chain, which
 *  is what makes `absent` work on a path whose PARENT is also absent — the
 *  common case for "this block was never configured at all". */
export function resolvePath(properties: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = properties;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function sourcesOf(check: IntentCheck): IntentSource[] {
  return typeof check.select === 'string'
    ? [{ type: check.select, match: check.match }]
    : check.select;
}

/**
 * The logical ids of the RESOURCES a check draws from, before `items` descends
 * into them and before `where` narrows them.
 *
 * This is the coverage question, and it is deliberately a different question
 * from `selectSubjects`. A check with `items: SecurityGroupIngress` examines
 * the security group even though its subjects are ingress rules, so counting
 * subjects would credit it with covering nothing. And a check that narrows
 * with `where` — "every method except OPTIONS needs auth" — has still
 * considered the OPTIONS methods and decided they are fine; that is a policy
 * decision about them, not an absence of one, so they count as examined.
 *
 * What does NOT count is a resource no check names at all. That is the number
 * worth reporting.
 */
export function selectedResourceIds(template: TemplateJson, check: IntentCheck): string[] {
  const ids = new Set<string>();
  for (const source of sourcesOf(check)) {
    for (const [logicalId] of resourcesOfType(template, source.type)) {
      if (source.match && !matchesGlob(logicalId, source.match)) continue;
      ids.add(logicalId);
    }
  }
  return [...ids];
}

/** Everything the check applies to, unioned across sources and flattened
 *  through `items`. */
export function selectSubjects(template: TemplateJson, check: IntentCheck): Subject[] {
  const subjects: Subject[] = [];

  for (const source of sourcesOf(check)) {
    for (const [logicalId, resource] of resourcesOfType(template, source.type)) {
      if (source.match && !matchesGlob(logicalId, source.match)) continue;
      const properties = (resource.Properties ?? {}) as Record<string, unknown>;

      if (!source.items) {
        subjects.push({ label: logicalId, logicalId, value: properties });
        continue;
      }

      // A missing or non-array items path contributes nothing rather than
      // erroring: a security group with no inline ingress rules genuinely has
      // no subjects, and that is not a malformed file.
      const nested = resolvePath(properties, source.items);
      if (!Array.isArray(nested)) continue;
      nested.forEach((element, i) => {
        if (element === null || typeof element !== 'object') return;
        subjects.push({
          label: `${logicalId}.${source.items}[${i}]`,
          logicalId,
          value: element as Record<string, unknown>,
        });
      });
    }
  }

  return subjects;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function satisfiesSingle(actual: unknown, expected: IntentExpectation): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('not' in expected) return !satisfiesSingle(actual, expected.not);
    // A threshold on a non-number is a failure, not an error: a password policy
    // that never set MinimumLength has not met "at least 8".
    if ('at-least' in expected) {
      return typeof actual === 'number' && actual >= expected['at-least'];
    }
    return typeof actual === 'number' && actual <= expected['at-most'];
  }

  if (expected === 'present') return actual !== undefined && actual !== null;
  if (expected === 'absent') return actual === undefined || actual === null;

  // Array at the path: order-independent INCLUDES, never an ordered
  // subsequence. This is deliberate — Match.arrayWith matches an ordered
  // subsequence and silently passes wrong orderings, a trap this codebase has
  // already been bitten by and fixed. Keeping the semantics on plain includes
  // makes reintroducing it impossible from the authoring side.
  if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected));
  return deepEqual(actual, expected);
}

export function satisfies(actual: unknown, expected: IntentExpectation): boolean {
  // A list of expectations is a conjunction: `[present, { not: OFF }]`.
  if (Array.isArray(expected)) return expected.every((e) => satisfiesSingle(actual, e));
  return satisfiesSingle(actual, expected);
}

/** The path whose expectation failed, or undefined if the predicate holds. */
function failingPath(subject: Subject, predicate: IntentPredicate): string | undefined {
  for (const [path, expected] of Object.entries(predicate)) {
    if (!satisfies(resolvePath(subject.value, path), expected)) return path;
  }
  return undefined;
}

function holds(subject: Subject, check: IntentCheck): boolean {
  const alternatives = check['any-of'];
  if (alternatives) return alternatives.some((p) => failingPath(subject, p) === undefined);
  return failingPath(subject, check.assert!) === undefined;
}

/** One concrete violation, in parts rather than as a sentence. The renderers
 *  compose the sentence; a consumer grouping by resource or property needs the
 *  parts, and parsing them back out of English is how two consumers disagree. */
export interface CheckFailure {
  logicalId: string;
  /** For an `any-of` check: the allowed shapes that were tried, rendered.
   *  Nothing else to show a reader — there is no single failing path when the
   *  subject matched none of several permitted forms. */
  alternatives?: string[];
  /** Dot-path to the property that did not hold, where there is one. Absent
   *  for whole-subject failures — `any-of`, or a prohibition being violated. */
  path?: string;
  expected?: unknown;
  found?: unknown;
}

/** A resource this check deliberately did not judge. */
export interface AppliedExemption {
  logicalId: string;
  reason: string;
  until?: string;
}

export interface CheckEvaluation {
  passed: boolean;
  /** Present only on failure. The distinct empty-selection case reads
   *  differently from a property failure on purpose: silence about missing
   *  infrastructure would make an empty stack look like passing intent. */
  reason?: string;
  /** Structured detail behind `reason`. Empty when the failure is the absence
   *  of anything to judge, which names no resource. */
  failures: CheckFailure[];
  /** Subjects excluded by an exemption, deduplicated by resource. */
  exempted: AppliedExemption[];
  /** Exemption globs that matched nothing here — a stale carve-out naming a
   *  resource that no longer exists. Surfaced rather than swallowed. */
  unusedExemptions: string[];
  /** Resources examined, after exemptions. */
  subjectCount: number;
}

export interface EvaluateOptions {
  /** The run date, for deciding whether an exemption has lapsed. Injectable
   *  because a test that reads the wall clock fails on a date nobody chose. */
  now?: Date;
}

/** Inclusive: an exemption dated today still holds today. */
function isLive(exemption: { until?: string }, now: Date): boolean {
  return exemption.until === undefined || now.toISOString().slice(0, 10) <= exemption.until;
}

function describeSelection(check: IntentCheck): string {
  const sources = sourcesOf(check);
  const scoped = sources.map((s) => (s.match ? `${s.type} matching "${s.match}"` : s.type));
  return scoped.join(' or ');
}

export function evaluateCheck(
  template: TemplateJson,
  check: IntentCheck,
  options: EvaluateOptions = {},
): CheckEvaluation {
  const now = options.now ?? new Date();
  const quantifier = check.quantifier;
  const selected = selectSubjects(template, check);
  const narrowed = check.where
    ? selected.filter((s) => failingPath(s, check.where!) === undefined)
    : selected;

  /**
   * Exemptions apply HERE — after `where`, before the quantifier.
   *
   * Order matters and this is the only correct place. Excluding after
   * evaluation would mean a prohibition still failed on an exempted resource;
   * excluding before `where` would let an exemption resurrect a resource the
   * check had already scoped itself out of.
   *
   * A lapsed exemption is not applied at all, so the resource is judged again
   * and an unfixed violation fails the run. That is the whole point of `until`.
   */
  const live = (check.exempt ?? []).filter((e) => isLive(e, now));
  const exempted: AppliedExemption[] = [];
  const used = new Set<string>();
  const subjects = narrowed.filter((subject) => {
    const hit = live.find((e) => matchesGlob(subject.logicalId, e.match));
    if (!hit) return true;
    used.add(hit.match);
    // Deduplicated by resource: a check using `items` has many subjects per
    // resource, and one carve-out should be reported once, not per element.
    if (!exempted.some((x) => x.logicalId === subject.logicalId)) {
      exempted.push({
        logicalId: subject.logicalId,
        reason: hit.reason,
        ...(hit.until ? { until: hit.until } : {}),
      });
    }
    return false;
  });

  // Every declared exemption, live or lapsed, that matched nothing in this
  // template. The caller decides what to say — across a multi-stack app an
  // exemption legitimately matches nothing in most templates.
  const unusedExemptions = (check.exempt ?? [])
    .filter((e) => !used.has(e.match))
    .map((e) => e.match);

  const base = { exempted, unusedExemptions, subjectCount: subjects.length };

  if (subjects.length === 0) {
    // A prohibition over nothing is satisfied. The other two quantifiers make a
    // claim ABOUT something, so nothing to claim it about is a failure —
    // unless the check says it is conditional, which is what a portable pack
    // needs in order to say "IF this stack has queues, they must be encrypted".
    if (quantifier === 'none' || check['on-empty'] === 'pass') {
      return { passed: true, failures: [], ...base };
    }
    return {
      passed: false,
      reason: `No ${describeSelection(check)} in this stack.`,
      failures: [],
      ...base,
    };
  }

  if (quantifier === 'any') {
    if (subjects.some((s) => holds(s, check))) return { passed: true, failures: [], ...base };
    return {
      passed: false,
      reason: `No ${describeSelection(check)} satisfies this — checked ${subjects.length}.`,
      failures: subjects.map((s) => ({ logicalId: s.logicalId })),
      ...base,
    };
  }

  if (quantifier === 'none') {
    const offenders = subjects.filter((s) => holds(s, check));
    if (offenders.length === 0) return { passed: true, failures: [], ...base };
    return {
      passed: false,
      reason: `${offenders[0]!.label} does what this forbids.`,
      failures: offenders.map((s) => ({ logicalId: s.logicalId })),
      ...base,
    };
  }

  const failures: CheckFailure[] = [];
  let reason: string | undefined;
  for (const subject of subjects) {
    if (holds(subject, check)) continue;
    if (check['any-of']) {
      const alternatives = check['any-of'].map(describePredicate);
      failures.push({ logicalId: subject.logicalId, alternatives });
      reason ??= `${subject.label} satisfies none of the allowed shapes.`;
      continue;
    }
    const path = failingPath(subject, check.assert!)!;
    const expected = check.assert![path];
    const found = resolvePath(subject.value, path);
    failures.push({ logicalId: subject.logicalId, path, expected, found });
    reason ??= `${subject.label}: expected ${path} to be ${describe(expected)}, found ${describe(found)}.`;
  }

  // Every failing subject is collected, not just the first. The message still
  // names one — a build log wants a sentence — but an org view grouping by
  // resource needs them all, and re-running to find the second is not a thing
  // anyone should have to do.
  if (failures.length > 0) return { passed: false, reason, failures, ...base };
  return { passed: true, failures: [], ...base };
}


/** One allowed shape, as a line a reader can compare their resource against —
 *  "KmsMasterKeyId is present" rather than a JSON blob of the predicate. */
function describePredicate(predicate: IntentPredicate): string {
  return Object.entries(predicate)
    .map(([path, expectation]) => `${path} is ${describe(expectation)}`)
    .join(' and ');
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(describe).join(' and ');
  if (typeof value === 'object') {
    const [op, operand] = Object.entries(value as Record<string, unknown>)[0];
    if (op === 'not') return `not ${describe(operand)}`;
    if (op === 'at-least') return `at least ${String(operand)}`;
    if (op === 'at-most') return `at most ${String(operand)}`;
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return value === 'present' || value === 'absent' ? value : `"${value}"`;
  }
  return String(value);
}
