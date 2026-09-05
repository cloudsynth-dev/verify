import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { IntentFileError, evaluateCheck } from './engine/index.js';
import type {
  TemplateJson,
  CheckFailure,
  AppliedExemption,
} from './engine/index.js';
import type { Coverage } from './contract/report.js';
import { computeCoverage } from './coverage.js';
import { resolveIntent, IntentResolutionError, type ResolvedIntent, type SourcedCheck } from './resolve.js';

/**
 * `cloudsynth verify` — the CI half of the intent contract.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: talk to CloudSynth. Everything happens
 * inside the caller's own runner, against templates their own `cdk synth`
 * produced. Their infrastructure code never leaves their repository, there is
 * no API key, and the tool works offline and unchanged if this company
 * disappears. Sending customer stacks to a server to be checked would be a
 * strictly worse product, and no amount of convenience would buy back the trust
 * it costs.
 *
 * It is also why this can exist at all: the evaluator was decoupled from
 * aws-cdk-lib and reads plain CloudFormation JSON, so the check that runs in a
 * customer's CI is the exact same function that runs in the playground.
 */

export interface VerifyOptions {
  /** Path to cloudsynth.intent.yml. */
  intentPath: string;
  /** A `cdk.out` directory, or a single *.template.json. */
  templatePath: string;
  /** The moment the run happens, for deciding whether an exemption has
   *  lapsed. Injectable because a test that depends on the wall clock is a
   *  test that fails on a date nobody chose. */
  now?: Date;
}

export interface CheckOutcome {
  check: SourcedCheck;
  /** The template whose result decided the outcome; `all` for a prohibition
   *  that had to hold everywhere and did. */
  templateName: string;
  passed: boolean;
  reason?: string;
  /** Every violation, across every template. */
  failures: Array<CheckFailure & { stack: string }>;
  /** Resources carved out by an exemption, deduplicated across templates. */
  exempted: AppliedExemption[];
  /**
   * How many resources or array elements this check examined, summed across
   * every template, after exemptions.
   *
   * Reported because a passing check proves nothing on its own: one written as
   * "every Lambda writes to a log group with explicit retention" but selecting
   * AWS::Logs::LogGroup examines the eight log groups that exist and says
   * nothing about the other 72 functions — and passes. Nothing in the schema
   * can catch that, because `description` is prose.
   */
  subjects: number;
}

/** An exemption whose glob matched nothing anywhere — stale, and worth saying
 *  so. Collected across templates, because matching nothing in ONE template of
 *  a multi-stack app is entirely normal. */
export interface StaleExemption {
  checkId: string;
  match: string;
}

/** An exemption that has lapsed: no longer applied, and the resource it used
 *  to cover is being judged again. */
export interface ExpiredExemption {
  checkId: string;
  match: string;
  until: string;
}

export interface VerifyReport {
  outcomes: CheckOutcome[];
  templatesChecked: string[];
  /** Per-template resource counts, for the report's `templates` array. */
  templateResourceCounts: { name: string; resourceCount: number }[];
  /** Every intent file that contributed a check, merge order, nearest last. */
  sources: string[];
  coverage: Coverage;
  /** Exemptions that matched nothing in any template. */
  staleExemptions: StaleExemption[];
  /** Override keys naming a check that does not exist after the merge. */
  unusedOverrides: string[];
  /** Exemptions past their `until` — no longer applied, so the resource is
   *  judged again. Reported so a reappearing failure is explained. */
  expiredExemptions: ExpiredExemption[];
  startedAt: Date;
  durationMs: number;
  /** False when any error-severity check failed, or a required coverage type
   *  has unexamined resources. */
  passed: boolean;
  errorCount: number;
  warningCount: number;
}

export class VerifyInputError extends Error {}

/** Every `*.template.json` under a cdk.out, or the single file given. */
export function collectTemplates(templatePath: string): { name: string; template: TemplateJson }[] {
  if (!existsSync(templatePath)) {
    throw new VerifyInputError(
      `No synthesized templates found at ${templatePath} — run \`cdk synth\` first, ` +
        'or point at templates with --template.',
    );
  }

  const isDir = statSync(templatePath).isDirectory();
  const entries = isDir ? readdirSync(templatePath) : [];
  const paths = isDir
    ? entries
        .filter((f) => f.endsWith('.template.json'))
        .sort()
        .map((f) => join(templatePath, f))
    : [templatePath];

  // Three different reasons a directory yields no templates, and they need
  // three different next actions. "No templates found" for all of them sends
  // someone to re-run `cdk synth` when the real problem is that they pointed
  // at the wrong folder.
  if (paths.length === 0) {
    if (entries.length === 0) {
      throw new VerifyInputError(
        `${templatePath} is empty — no synthesized templates found. ` +
          'Run `cdk synth` first, or point at templates with --template.',
      );
    }
    const json = entries.filter((f) => f.endsWith('.json'));
    if (json.length > 0) {
      throw new VerifyInputError(
        `${templatePath} contains JSON files but none named *.template.json ` +
          `(found ${json.slice(0, 3).join(', ')}${json.length > 3 ? ', …' : ''}). ` +
          'CloudFormation templates from `cdk synth` end in .template.json; ' +
          'pass a single file with --template if yours is named differently.',
      );
    }
    throw new VerifyInputError(
      `No synthesized templates found in ${templatePath} ` +
        `(${entries.length} file(s), none matching *.template.json). ` +
        'Run `cdk synth` first, or point at templates with --template.',
    );
  }

  return paths.map((p) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      throw new VerifyInputError(
        `${p} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
          'If `cdk synth` was interrupted, delete the directory and re-run it.',
      );
    }
    // basename, so a template is `AppStack` on every platform — a report
    // carrying `cdk.out\\AppStack` on Windows and `cdk.out/AppStack` elsewhere
    // would make snapshots and any aggregate keyed on template name
    // platform-dependent.
    return { name: basename(p, '.template.json'), template: parsed as TemplateJson };
  });
}

/** The file, plus everything it extends, merged nearest-wins. */
export function loadIntent(intentPath: string): ResolvedIntent {
  if (!existsSync(intentPath)) {
    throw new VerifyInputError(
      `No intent file at ${intentPath}. Run \`cloudsynth init\` to write one from ` +
        'your synthesized templates, or pass --intent <path>.',
    );
  }
  try {
    return resolveIntent(intentPath);
  } catch (err) {
    // Both are the user's to fix — a bad path, a cycle, a schema error — so
    // both render as a message rather than a stack trace.
    if (err instanceof IntentFileError || err instanceof IntentResolutionError) {
      throw new VerifyInputError(err.message);
    }
    throw err;
  }
}

/**
 * How a check combines across a multi-stack app — and it depends on the
 * quantifier, which is not a detail.
 *
 * `any` is EXISTENTIAL: "some queue in this app has a dead-letter queue". One
 * template satisfying it satisfies the app.
 *
 * `every` is UNIVERSAL, but only over the templates that HAVE the resource. A
 * template containing no buckets abstains — it neither passes nor fails "every
 * bucket is encrypted", and failing it there would break every multi-stack app
 * on its first run, since an app puts its buckets in one stack and not all of
 * them. But a template that HAS buckets must hold.
 *
 * Combining `every` existentially — passing as soon as ANY template passed —
 * is a silent false pass, and it shipped in 0.2.0. Two stacks, one with an
 * encrypted bucket and one without: the compliant stack satisfied the check
 * and the unencrypted bucket was never reported. This is the same class of bug
 * as the prohibition one below, in the DEFAULT quantifier, and the reasoning
 * that produced it conflated "a stack with none of the resource should not
 * fail" (true) with "one passing stack is enough" (false).
 *
 * `none` is a PROHIBITION: "no security group anywhere opens SSH". That must
 * hold in EVERY template. Combining it existentially is not a subtle
 * difference — it silently passes, because in a real app most stacks contain
 * none of the resource in question and each of them satisfies the prohibition
 * on its own. Caught by pointing a deliberately-false check ("this app defines
 * no Lambda functions") at an app with 58 of them and watching it pass.
 */
/** One template's verdict, as the combination rule sees it. */
export interface TemplateVerdict {
  name: string;
  passed: boolean;
  subjectCount: number;
  reason?: string;
}

/**
 * Whether a check holds across a multi-template app.
 *
 * THE most dangerous function in this package, and the only copy of this rule.
 * It has been wrong twice in shipped releases — `none` combined existentially
 * in 0.1.0, `every` combined existentially in 0.2.0 — and a third instance was
 * found in `init`, which had quietly reimplemented it and so disagreed with
 * `verify` about the file it had just written. That is why it lives here alone
 * and why quantifier-matrix.test.ts enumerates all 45 cells against it.
 *
 *   any    EXISTENTIAL — one satisfying template satisfies the app.
 *   every  UNIVERSAL over templates that HAVE the resource; one with none of
 *          it abstains, since requiring it there would fail every multi-stack
 *          app on its first run.
 *   none   must hold in EVERY template, or a prohibition passes on the
 *          strength of the stacks that contain none of the resource.
 */
export function holdsAcrossTemplates<T extends TemplateVerdict>(
  quantifier: 'every' | 'any' | 'none',
  results: T[],
): { passed: boolean; deciding?: T; dissenting: T[] } {
  if (quantifier === 'none') {
    const violations = results.filter((r) => !r.passed);
    return violations.length === 0
      ? { passed: true, dissenting: [] }
      : { passed: false, deciding: violations[0], dissenting: violations };
  }

  if (quantifier === 'any') {
    const satisfied = results.find((r) => r.passed);
    return satisfied
      ? { passed: true, deciding: satisfied, dissenting: [] }
      : { passed: false, deciding: results[0], dissenting: results };
  }

  const voting = results.filter((r) => r.subjectCount > 0);
  if (voting.length > 0) {
    const dissenting = voting.filter((r) => !r.passed);
    return dissenting.length === 0
      ? { passed: true, deciding: voting[0], dissenting: [] }
      : { passed: false, deciding: dissenting[0], dissenting };
  }

  // No template had subjects; every result is the empty-selection verdict,
  // which `on-empty` already decided per template.
  const satisfied = results.find((r) => r.passed);
  return satisfied
    ? { passed: true, deciding: satisfied, dissenting: [] }
    : { passed: false, deciding: results[0], dissenting: results };
}

export function verifyIntent(options: VerifyOptions): VerifyReport {
  const startedAt = options.now ?? new Date();
  const began = Date.now();
  const document = loadIntent(options.intentPath);
  const checks = document.checks;
  const templates = collectTemplates(options.templatePath);

  const staleExemptions: StaleExemption[] = [];
  const expiredExemptions: ExpiredExemption[] = [];

  const outcomes = checks.map<CheckOutcome>((check) => {
    const results = templates.map(({ name, template }) => ({
      name,
      ...evaluateCheck(template, check, { now: startedAt }),
    }));

    // Exemptions and subjects are properties of the RUN, not of whichever
    // template happened to decide the outcome, so they are gathered across all
    // of them before the combination rule below picks a winner.
    const subjects = results.reduce((n, r) => n + r.subjectCount, 0);
    const exempted: AppliedExemption[] = [];
    for (const r of results) {
      for (const e of r.exempted) {
        if (!exempted.some((x) => x.logicalId === e.logicalId)) exempted.push(e);
      }
    }

    // Stale only if it matched nothing ANYWHERE. Matching nothing in one
    // template of a multi-stack app is the normal case, not a problem.
    const matchedSomewhere = new Set(
      results.flatMap((r) => (check.exempt ?? []).map((e) => e.match)).filter((m) =>
        results.some((r) => !r.unusedExemptions.includes(m)),
      ),
    );
    for (const e of check.exempt ?? []) {
      if (!matchedSomewhere.has(e.match)) {
        staleExemptions.push({ checkId: check.id, match: e.match });
      }
      if (e.until && startedAt.toISOString().slice(0, 10) > e.until) {
        expiredExemptions.push({ checkId: check.id, match: e.match, until: e.until });
      }
    }

    const failuresOf = (r: (typeof results)[number]) =>
      r.failures.map((f) => ({ ...f, stack: r.name }));
    const base = { check, subjects, exempted };

    const verdict = holdsAcrossTemplates(check.quantifier, results);
    if (verdict.passed) {
      return {
        ...base,
        templateName: check.quantifier === 'none' ? 'all' : (verdict.deciding?.name ?? 'all'),
        passed: true,
        failures: [],
      };
    }

    // Report the most INFORMATIVE failure, not the first alphabetically. "No
    // AWS::DynamoDB::Table in this stack" is true of most stacks and is nearly
    // never why the check failed; a property mismatch names the stack that has
    // the resource and got it wrong.
    const substantive = verdict.dissenting.find((r) => !r.reason?.startsWith('No '));
    const chosen = substantive ?? verdict.deciding ?? verdict.dissenting[0];
    return {
      ...base,
      templateName: chosen?.name ?? '(none)',
      passed: false,
      failures: verdict.dissenting.flatMap(failuresOf),
      ...(chosen?.reason ? { reason: `${chosen.name}: ${chosen.reason}` } : {}),
    };
  });

  const coverage = computeCoverage({
    templates,
    // Exempted resources count as examined, so every check contributes —
    // including one whose subjects were entirely carved out. A carve-out with
    // a stated reason is attention, not absence.
    checks: outcomes.map((o) => o.check),
    ...(document.require ? { require: document.require } : {}),
  });

  const failed = outcomes.filter((o) => !o.passed);
  return {
    outcomes,
    templatesChecked: templates.map((t) => t.name),
    templateResourceCounts: templates.map((t) => ({
      name: t.name,
      resourceCount: Object.keys(t.template.Resources ?? {}).length,
    })),
    sources: document.sources,
    unusedOverrides: document.unusedOverrides,
    coverage,
    staleExemptions,
    expiredExemptions,
    startedAt,
    durationMs: Date.now() - began,
    // Warnings are reported and do not fail the build. A coverage violation
    // DOES fail it: the file asked for that type to be covered, which is a
    // different thing from a check noticing a problem.
    passed: failed.every((o) => o.check.severity === 'warning') && coverage.violations.length === 0,
    errorCount: failed.filter((o) => o.check.severity === 'error').length,
    warningCount: failed.filter((o) => o.check.severity === 'warning').length,
  };
}
