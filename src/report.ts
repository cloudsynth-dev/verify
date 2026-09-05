import type { Report, ReportCheck } from './contract/report.js';
import { REPORT_VERSION } from './contract/report.js';
import type { VerifyReport } from './verify.js';
import { unexaminedTypes } from './coverage.js';
import { TOOL_VERSION } from './version.js';

/**
 * How a run is reported.
 *
 * Three formats because three readers: a person at a terminal wants the
 * failures first and the passes summarised; GitHub wants `::error::` workflow
 * commands, which it renders as annotations on the pull request rather than
 * burying in a log nobody expands; and a machine wants JSON.
 *
 * All three render from a `Report` and from nothing else — one evaluation
 * result, three presentations. Previously `--format json` built its own object
 * inline here, which made the machine-readable output a side effect of how a
 * terminal line is formatted: a field could appear in `text` and never in
 * `json`, and nothing would notice.
 */
export type ReportFormat = 'text' | 'github' | 'json';

/** GitHub's own env var, set on every runner. Detecting it means the annotated
 *  output is the default where it helps and never leaks into a local terminal. */
export function defaultFormat(env: NodeJS.ProcessEnv = process.env): ReportFormat {
  return env['GITHUB_ACTIONS'] === 'true' ? 'github' : 'text';
}

export interface BuildReportOptions {
  /** The intent file this run was judged against, as the user gave it. */
  intentPath: string;
  /** Overridable so a test can pin the contract without pinning the build. */
  toolVersion?: string;
}

/**
 * Presentation-only context the renderers need and the contract does not carry.
 *
 * ReportV1 describes the RUN; the intent file's path is an input to it, and
 * stale/expired exemptions are complaints about the file rather than findings
 * about the stack. Putting them in the report would mean a consumer had to
 * ignore fields that are not about their infrastructure.
 */
export interface RenderContext {
  intentPath: string;
  stale: VerifyReport['staleExemptions'];
  expired: VerifyReport['expiredExemptions'];
  unusedOverrides?: string[];
  /** Failures and the summary only — for a pipeline whose log is read when
   *  something breaks and never otherwise. */
  quiet?: boolean;
}

export function buildReport(report: VerifyReport, options: BuildReportOptions): Report {
  const checks = report.outcomes.map<ReportCheck>((o) => ({
    id: o.check.id,
    description: o.check.description,
    severity: o.check.severity,
    // A failing check at warning severity is `warn`, not `fail`: kept distinct
    // so an aggregate can count the two apart without re-deriving it.
    outcome: o.passed ? 'pass' : o.check.severity === 'warning' ? 'warn' : 'fail',
    subjects: o.subjects,
    exempted: o.exempted,
    source: o.check.source,
    ...(o.check.overridden?.length ? { overridden: o.check.overridden } : {}),
    failures: o.failures.map((f) => ({
      stack: f.stack,
      logicalId: f.logicalId,
      ...(f.path !== undefined ? { path: f.path } : {}),
      ...(f.expected !== undefined ? { expected: f.expected } : {}),
      ...(f.found !== undefined ? { found: f.found } : {}),
      ...(f.alternatives ? { alternatives: f.alternatives } : {}),
      ...(o.check.hint ? { hint: o.check.hint } : {}),
    })),
  }));

  return {
    reportVersion: REPORT_VERSION,
    tool: { name: 'cloudsynth', version: options.toolVersion ?? TOOL_VERSION },
    startedAt: report.startedAt.toISOString(),
    durationMs: report.durationMs,
    templates: report.templateResourceCounts.map((t) => ({
      path: t.name,
      resourceCount: t.resourceCount,
    })),
    checks,
    coverage: report.coverage,
    summary: {
      passed: checks.filter((c) => c.outcome === 'pass').length,
      failed: checks.filter((c) => c.outcome === 'fail').length,
      warnings: checks.filter((c) => c.outcome === 'warn').length,
      exitCode: report.passed ? 0 : 1,
    },
  };
}

export function render(report: Report, format: ReportFormat, context?: RenderContext): string {
  if (format === 'json') return JSON.stringify(report, null, 2);
  return format === 'github' ? renderGithub(report, context) : renderText(report, context);
}

/** Enough to act on without turning the summary into a second report. */
const UNEXAMINED_SHOWN = 5;

/** A coverage violation on a numerous type can name hundreds of resources.
 *  Ten plus a count is a list someone reads; the full set is in the JSON. */
const VIOLATION_IDS_SHOWN = 10;

/** Never emit ANSI. There is no colour anywhere in this output, so NO_COLOR
 *  and a non-TTY are satisfied by construction rather than by branching — the
 *  branch is what usually rots. `bundle.test.ts` asserts the built artifact
 *  contains no escape sequences at all. */

function subjectNote(c: ReportCheck): string {
  const n = c.subjects;
  const base = `${n} ${n === 1 ? 'resource' : 'resources'}`;
  // An exemption is visible in EVERY run, not just to whoever reads the file.
  return c.exempted.length > 0
    ? `  (${base}, ${c.exempted.length} exempted)`
    : `  (${base})`;
}

function renderText(report: Report, context?: RenderContext): string {
  const lines: string[] = [];

  // Failures first. A list that opens with twelve passes buries the one thing
  // the reader came for.
  for (const c of report.checks) {
    if (c.outcome === 'pass') continue;
    lines.push(`  ${c.outcome === 'fail' ? 'FAIL' : 'WARN'}  ${c.description}`);
    // Name the origin only when it is not this file; on the common
    // single-file run that would be the same string on every line.
    const origin = c.source === 'local' ? '' : `  (from ${c.source})`;
    const demoted = c.overridden?.includes('severity') ? ', severity overridden locally' : '';
    lines.push(`        ${c.id}${origin}${demoted}`);
    const first = c.failures[0];
    if (first) {
      lines.push(
        `        ${first.stack}: ${first.logicalId}` +
          (first.path ? `: ${first.path}` : '') +
          (first.expected !== undefined
            ? ` — expected ${describe(first.expected)}, found ${describe(first.found)}`
            : '') +
          (c.failures.length > 1 ? `  (+${c.failures.length - 1} more)` : ''),
      );
      // An `any-of` failure carries no single path — the subject satisfied
      // none of several allowed shapes — so without listing them the reader is
      // told a resource is wrong and given nothing to compare it against. This
      // is the hardest failure in the tool to act on, and the alternatives are
      // the whole answer.
      if (first.alternatives?.length) {
        lines.push(`        none of the allowed shapes matched:`);
        for (const alt of first.alternatives) lines.push(`          - ${alt}`);
      }
      if (first.hint) lines.push(`        ${first.hint}`);
    }
    lines.push('');
  }

  if (!context?.quiet) {
    for (const c of report.checks) {
      if (c.outcome === 'pass') lines.push(`  PASS  ${c.description}${subjectNote(c)}`);
    }
  }

  const total = report.checks.length;
  lines.push('');
  lines.push(
    `  ${report.summary.passed}/${total} checks passed against ` +
      `${report.templates.length} template(s): ${report.templates.map((t) => t.path).join(', ')}`,
  );
  if (report.summary.warnings > 0) {
    lines.push(`  ${report.summary.warnings} warning(s) — reported, not failing the build.`);
  }

  // Printed on every run. "6/6 checks passed" is true of a file that examines
  // 12 of 765 resources, and the only way a reader learns which kind of file
  // they have is if the number is always there.
  const { coverage } = report;
  const types = Object.keys(coverage.byType).length;
  lines.push(
    `  coverage: ${coverage.examinedResources}/${coverage.totalResources} resources ` +
      `examined across ${types} type(s)`,
  );
  const unexamined = unexaminedTypes(coverage);
  if (unexamined.length > 0) {
    const top = unexamined.slice(0, UNEXAMINED_SHOWN);
    const rest = unexamined.length - top.length;
    lines.push(
      `  nothing checks: ${top.map((u) => `${u.type} (${u.count})`).join(', ')}` +
        (rest > 0 ? `, and ${rest} more type(s)` : ''),
    );
  }
  for (const v of coverage.violations) {
    // Named individually. A percentage tells nobody which resource to look at.
    const shown = v.logicalIds.slice(0, VIOLATION_IDS_SHOWN);
    const rest = v.logicalIds.length - shown.length;
    lines.push(`  FAIL  coverage: ${v.type} requires every resource be examined —`);
    lines.push(
      `        ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''} ` +
        `${v.logicalIds.length === 1 ? 'is' : 'are'} untouched.`,
    );
  }

  for (const e of context?.expired ?? []) {
    lines.push(`  the exemption ${e.match} on ${e.checkId} expired on ${e.until} — now enforced.`);
  }
  for (const s of context?.stale ?? []) {
    lines.push(`  the exemption ${s.match} on ${s.checkId} exempts nothing — remove it.`);
  }
  // An override naming a check that no longer exists is a rule the pack
  // renamed or dropped, silently doing nothing. Same reason stale exemptions
  // are surfaced: the file is asserting something untrue about itself.
  for (const id of context?.unusedOverrides ?? []) {
    lines.push(`  the override for ${id} overrides nothing — no check with that id.`);
  }
  return lines.join('\n');
}

/** One workflow command per failure, so each lands as an annotation. Newlines
 *  must be escaped or GitHub truncates the message at the first one. */
function renderGithub(report: Report, context?: RenderContext): string {
  const lines: string[] = [];
  const file = context?.intentPath ?? 'cloudsynth.intent.yml';

  for (const c of report.checks) {
    if (c.outcome === 'pass') continue;
    const level = c.outcome === 'fail' ? 'error' : 'warning';
    const first = c.failures[0];
    const detail = first
      ? `${first.stack}: ${first.logicalId}${first.path ? `: ${first.path}` : ''}.${first.hint ? ` ${first.hint}` : ''}`
      : '';
    lines.push(
      `::${level} file=${file},title=cloudsynth: ${c.id}::` +
        escape(`${c.description}${detail ? ` — ${detail}` : ''}`),
    );
  }
  for (const v of report.coverage.violations) {
    lines.push(
      `::error file=${file},title=cloudsynth: coverage::` +
        escape(`${v.type} requires every resource be examined — ${v.logicalIds.join(', ')} untouched.`),
    );
  }
  for (const s of context?.stale ?? []) {
    lines.push(
      `::warning file=${file},title=cloudsynth: ${s.checkId}::` +
        escape(`The exemption ${s.match} exempts nothing — remove it.`),
    );
  }
  lines.push(renderText(report, context));
  return lines.join('\n');
}

/** Values in a message, rendered the way a reader expects rather than the way
 *  JSON.stringify does — `present` unquoted, a string quoted, nothing for an
 *  absent value. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

function escape(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
