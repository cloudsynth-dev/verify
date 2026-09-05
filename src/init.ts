import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { evaluateCheck, parseIntentDocument } from './engine/index.js';
import type { TemplateJson } from './engine/index.js';
import { CATALOG, type CatalogEntry } from './catalog.js';
import { VerifyInputError, holdsAcrossTemplates } from './verify.js';

/**
 * `cloudsynth init` — the cold start.
 *
 * Without it a new user must hand-author intent before the tool does anything,
 * which is the hand-written-intent problem simply relocated: they open an empty
 * document in a format they have never seen, write one check about a bucket,
 * and never come back. `init` turns that into "delete what you don't mean".
 *
 * ── It writes a semantic snapshot, not a wish list ───────────────────────────
 * Every catalog rule is EVALUATED against the templates first:
 *
 *   passes  → emitted active. The file asserts what is currently true, so the
 *             very first `cloudsynth verify` after `init` is green by
 *             construction. That matters more than it sounds: a starter file
 *             that fails immediately reads as the tool being broken, and the
 *             user has no way to tell a real finding from a bad default.
 *   fails   → emitted COMMENTED OUT, with what currently violates it. The
 *             backlog is in the file, in the user's own terms, ready to be
 *             uncommented one at a time. `--all` emits them active for someone
 *             who wants the gate on from day one.
 *   matches
 *   nothing → omitted entirely. A check about RDS in a repo with no database
 *             is noise that teaches the reader to skim.
 *
 * ── It does not synthesize ───────────────────────────────────────────────────
 * `init` reads templates the caller already produced, exactly as `verify` does.
 * A subcommand that shelled out to the CDK would be the first exception to
 * "reads files off disk and does nothing else", in the one command a new user
 * runs first.
 */

/** Where the published JSON Schema lives. Served by the web app; see
 *  apps/web/app/schema/intent-v1.json/route.ts. */
export const SCHEMA_URL = 'https://www.cloudsynth.dev/schema/intent-v1.json';

export interface InitOptions {
  /** Where to write. Refused if it exists, unless `force`. */
  outPath: string;
  /** A cdk.out directory, or a single *.template.json. */
  templatePath: string;
  /** Emit currently-failing rules active rather than commented out. */
  all?: boolean;
  force?: boolean;
}

export interface InitResult {
  path: string;
  /** Rules that hold today, written active. */
  active: string[];
  /** Rules that do not hold, written commented out (or active under --all). */
  commented: string[];
  /** Rules whose `select` matched nothing, omitted. */
  skipped: string[];
}

interface Verdict {
  entry: CatalogEntry;
  outcome: 'passes' | 'fails' | 'no-subjects';
  /** What currently violates it — one line, for the comment. */
  note?: string;
}

/** Every template under a cdk.out, or the single file given. Tolerant by
 *  design: a malformed template is `verify`'s problem to report properly, and
 *  failing to make a suggestion beats refusing to write anything. */
export function readTemplates(templatePath: string): { name: string; template: TemplateJson }[] {
  if (!existsSync(templatePath)) return [];
  const files = statSync(templatePath).isDirectory()
    ? readdirSync(templatePath)
        .filter((f) => f.endsWith('.template.json'))
        .sort()
        .map((f) => join(templatePath, f))
    : [templatePath];

  const out: { name: string; template: TemplateJson }[] = [];
  for (const file of files) {
    try {
      out.push({
        name: basename(file, '.template.json'),
        template: JSON.parse(readFileSync(file, 'utf8')) as TemplateJson,
      });
    } catch {
      continue;
    }
  }
  return out;
}

/** Resource types present anywhere in the synthesized templates. */
function typesPresent(templates: { name: string; template: TemplateJson }[]): Set<string> {
  const types = new Set<string>();
  for (const { template } of templates) {
    for (const r of Object.values(template.Resources ?? {})) if (r?.Type) types.add(r.Type);
  }
  return types;
}

function judge(
  entry: CatalogEntry,
  templates: { name: string; template: TemplateJson }[],
  present: Set<string>,
): Verdict {
  const check = parseIntentDocument(`version: 1\nchecks:\n${entry.yaml}`).checks[0]!;
  const results = templates.map(({ name, template }) => ({
    name,
    ...evaluateCheck(template, check),
  }));

  const subjects = results.reduce((n, r) => n + r.subjectCount, 0);
  if (subjects === 0) {
    /**
     * Nothing selected — but that means two different things.
     *
     * If NONE of the types this rule is about exist, the rule is irrelevant to
     * this stack and gets omitted: a check about RDS in a repo with no
     * database is noise that teaches the reader to skim.
     *
     * If the types DO exist and the rule still selected nothing, the missing
     * thing is the finding. "The app records VPC flow logs" selects
     * AWS::EC2::FlowLog; a repo with a VPC and no flow log selects nothing,
     * and that is exactly the gap worth writing down — commented out, like any
     * other rule that does not hold yet.
     */
    const relevant = entry.types.some((t) => present.has(t));
    if (!relevant) return { entry, outcome: 'no-subjects' };
    return {
      entry,
      outcome: 'fails',
      note: 'nothing in this stack satisfies it yet — uncomment to enforce',
    };
  }

  // THE SAME function `verify` uses, not a second implementation of the same
  // idea. init had its own copy and it was the pre-0.3.0 existential rule, so
  // init wrote checks it called passing that `verify` then failed — the file
  // it generated did not verify clean, which is the one guarantee init makes.
  const { passed } = holdsAcrossTemplates(check.quantifier, results);
  if (passed) return { entry, outcome: 'passes' };

  const offenders = results.flatMap((r) => r.failures);
  const resources = new Set(offenders.map((f) => f.logicalId));
  const n = resources.size;
  return {
    entry,
    outcome: 'fails',
    note: `${n} ${n === 1 ? 'resource' : 'resources'} currently ${n === 1 ? 'violates' : 'violate'} this — uncomment to enforce`,
  };
}

export function init(options: InitOptions): InitResult {
  if (existsSync(options.outPath) && !options.force) {
    throw new VerifyInputError(
      `${options.outPath} already exists. Delete it, or pass --force to overwrite it.`,
    );
  }

  const templates = readTemplates(options.templatePath);
  const present = typesPresent(templates);
  const verdicts = CATALOG.map((entry) => judge(entry, templates, present));

  const active = verdicts.filter((v) => v.outcome === 'passes');
  const failing = verdicts.filter((v) => v.outcome === 'fails');
  const skipped = verdicts.filter((v) => v.outcome === 'no-subjects');

  writeFileSync(options.outPath, render(active, failing, options.all === true), 'utf8');

  return {
    path: options.outPath,
    active: [...active, ...(options.all ? failing : [])].map((v) => v.entry.id),
    commented: failing.map((v) => v.entry.id),
    skipped: skipped.map((v) => v.entry.id),
  };
}

/** Commented out with its note, indentation preserved so uncommenting is a
 *  block edit rather than a reformat. */
function commentOut(verdict: Verdict): string {
  const body = verdict.entry.yaml
    .split('\n')
    .map((line) => (line.length > 0 ? `# ${line}` : '#'))
    .join('\n');
  // Flush left, matching the commented body below it — an indented note above
  // an unindented block reads as two unrelated things.
  return `# ${verdict.note}\n${body}`;
}

function render(active: Verdict[], failing: Verdict[], all: boolean): string {
  // The modeline first, because it has to be near the top of the file for the
  // YAML language server to find it — one line that turns a text editor into
  // an authoring tool with completion and inline docs.
  //
  // Then the two-line header. Unlike the playground download — which is
  // exact-bytes, so what you see in the editor is what lands in your repo —
  // this file is generated FOR someone, and saying so is the product's voice
  // in the artefact.
  const header = `# yaml-language-server: $schema=${SCHEMA_URL}
# Generated by \`cloudsynth init\` — a snapshot of what this stack already does.
# Delete any check you don't mean; uncomment the ones you want to grow into.
version: 1
checks:
`;

  const blocks = [
    ...active.map((v) => v.entry.yaml),
    ...failing.map((v) => (all ? v.entry.yaml : commentOut(v))),
  ];
  return header + blocks.join('\n');
}

/** The one-line summary the command prints. */
export function summarise(result: InitResult, all: boolean): string {
  const parts = [`wrote ${result.active.length} checks`];
  if (!all && result.commented.length > 0) {
    parts.push(`${result.commented.length} more available but currently failing (commented)`);
  }
  if (result.skipped.length > 0) {
    parts.push(`${result.skipped.length} skipped (no matching resources)`);
  }
  return parts.join(' · ');
}
