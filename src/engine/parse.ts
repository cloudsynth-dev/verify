import { parse as parseYaml } from 'yaml';
import { IntentFileSchema, type IntentCheck, type IntentFile } from '../contract/intent.js';
import { explainIssues, duplicateCheckIds } from './diagnose.js';

/**
 * Parsing `cloudsynth.intent.yml`.
 *
 * Two properties this has to hold, because the input is user-controlled the
 * moment the Intent tab becomes editable:
 *
 *  - It never throws anything untyped. Every malformed-input path — bad YAML,
 *    wrong version, unknown key, duplicate id — comes back as IntentFileError,
 *    so a caller can render it as a finding instead of a stack trace.
 *  - It never executes anything. `yaml`'s parse builds plain data; there are no
 *    custom tags, no code paths that construct objects by name. That matters
 *    because this same function runs inside the zero-permission synth Lambda,
 *    where the entire security argument is that nothing but the user's own CDK
 *    is ever evaluated.
 */

export class IntentFileError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'IntentFileError';
    this.issues = issues;
  }
}

/**
 * Aliases are the YAML billion-laughs vector: a small document can expand to
 * gigabytes through nested alias reuse.
 *
 * This was `maxAliasCount: 0` — aliases banned outright — on the reasoning
 * that an intent file has no legitimate reason to use them. That reasoning was
 * wrong, and a real one is easy to write: a file with a dozen checks sharing a
 * `select` block reuses it with an anchor, which is exactly what anchors are
 * for.
 *
 * A bounded count is the correct defense rather than a ban. The attack needs
 * EXPONENTIAL expansion — each alias referencing a node that itself contains
 * several aliases — and a cap of 100 makes the blow-up impossible while
 * leaving ordinary reuse alone. The cap is restated here rather than left to
 * the library default so an upstream change cannot silently widen it, which
 * was the good half of the original reasoning.
 *
 * `intent.test.ts` proves both halves: a normal anchor resolves, and a
 * billion-laughs document is still refused.
 */
const PARSE_OPTIONS = {
  maxAliasCount: 100,
  /**
   * Merge keys (`<<: *base`) are a separate YAML feature from aliases, off by
   * default in this parser. Enabled because it is the specific thing anchors
   * are wanted FOR here: a dozen checks sharing a `select` block. Without it
   * an anchor can only duplicate a whole node, and `<<` lands on `.strict()`
   * as an unknown field — a confusing error for valid YAML.
   */
  merge: true,
} as const;

/** Enough to fix the file, short enough to read in a findings card. */
const MAX_REPORTED_ISSUES = 3;

/**
 * The whole document, including the file-level settings that are not checks.
 *
 * `parseIntentFile` stays as it is and returns just the checks: three callers
 * — the playground, the fixtures, the lesson compiler — want exactly that and
 * nothing more, and widening their return type to make room for a field they
 * ignore would be churn for its own sake.
 */
export function parseIntentDocument(source: string): IntentFile {
  let raw: unknown;
  try {
    raw = parseYaml(source, PARSE_OPTIONS);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new IntentFileError(`not valid YAML: ${detail}`);
  }

  // An empty document parses to null rather than failing, which would otherwise
  // reach zod as a confusing "expected object, received null".
  if (raw === null || raw === undefined) {
    throw new IntentFileError('the file is empty.');
  }

  const result = IntentFileSchema.safeParse(raw);
  if (!result.success) {
    // Duplicate ids first: zod reports them as one whole-file refinement with
    // no location, and "check ids must be unique" without saying which two is
    // a search task rather than an error message.
    const duplicates = duplicateCheckIds(raw);
    // When the specific version has been said, drop zod's generic restatement
    // of the same rule — "check ids must be unique" adds nothing after
    // "check id `dup` is used 2 times — at #1 and #2".
    const explained = explainIssues(result.error.issues, raw).filter(
      (line) => !(duplicates.length > 0 && line.includes('check ids must be unique')),
    );
    const unique = [...new Set([...duplicates, ...explained])];
    // The issues go INTO the message, not just alongside it. A caller that
    // renders only `.message` — which is what a finding does — would otherwise
    // show "failed validation" and nothing about what to fix.
    const summary = unique.slice(0, MAX_REPORTED_ISSUES).join('\n        ');
    const rest = unique.length - MAX_REPORTED_ISSUES;
    const suffix = rest > 0 ? `\n        (and ${rest} more problem${rest === 1 ? '' : 's'})` : '';
    throw new IntentFileError(`${summary}${suffix}`, unique);
  }

  return result.data;
}

export function parseIntentFile(source: string): IntentCheck[] {
  return parseIntentDocument(source).checks;
}
