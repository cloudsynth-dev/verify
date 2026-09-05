import type { ZodIssue } from 'zod';
import { INTENT_CHECK_FIELDS, INTENT_FILE_FIELDS } from '../contract/intent.js';

/**
 * Turning a zod failure into something worth reading.
 *
 * A tool that blocks a deploy owes the person it blocked a next action, and
 * `checks.0: Unrecognized key(s) in object: 'quantifer'` is not one. It names
 * neither the file, nor the check, nor what the right key would have been —
 * and the reader is looking at a red pipeline trying to work out whether their
 * stack is wrong or their spelling is.
 *
 * The bar every message here is written against: **what is wrong, where, and
 * what to do next.**
 */

/** Levenshtein, bounded — only used to rank a handful of short field names. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * The closest valid field, when one is close enough to be worth suggesting.
 *
 * The threshold matters more than the algorithm. A confidently wrong
 * suggestion ("did you mean `severity`?" for `slect`) sends someone down the
 * wrong path and is worse than no suggestion at all, so anything beyond a
 * third of the word's length is treated as "no idea" and simply lists what is
 * valid instead.
 */
export function nearestField(unknown: string, valid: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of valid) {
    const score = distance(unknown.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= Math.max(1, Math.ceil(unknown.length / 3)) ? best : undefined;
}

/** The complete set of things an expectation may be, quoted in errors so the
 *  reader does not have to find the docs while their build is red. */
const EXPECTATION_FORMS = [
  'a literal value (string, number or boolean)',
  '`present` or `absent`',
  '`{ not: <value> }`',
  '`{ at-least: <number> }` or `{ at-most: <number> }`',
  'a list of any of the above, all of which must hold',
];

/** `checks.2.assert.Foo` -> "check #3, assert.Foo" — a location a human can
 *  find, rather than a path only the parser understands. */
function locate(path: (string | number)[], checkIds: (string | undefined)[]): string {
  if (path[0] !== 'checks' || typeof path[1] !== 'number') {
    return path.length > 0 ? `\`${path.join('.')}\`` : 'the file';
  }
  const index = path[1];
  const id = checkIds[index];
  const rest = path.slice(2).join('.');
  const where = id ? `check \`${id}\`` : `check #${index + 1}`;
  return rest ? `${where}, at \`${rest}\`` : where;
}

/**
 * One readable line per problem.
 *
 * `raw` is the parsed YAML, used only to recover check ids so a message can say
 * "check `bucket-encrypted`" instead of "checks.2" — the id is what the reader
 * searches the file for.
 */
export function explainIssues(issues: ZodIssue[], raw: unknown): string[] {
  /**
   * Whole-file refinements are consequences, not causes.
   *
   * Misspelling `checks` produces both "`cheks` is not a field" and "a file
   * must define `checks` or `extends` something that does" — the second is
   * true, useless, and actively misleading: it points at a rule the author did
   * not break. Zod cannot know one caused the other; here it is obvious,
   * because a file-level refinement carries an empty path and anything with a
   * path is more specific.
   */
  const concrete = issues.filter((i) => i.code !== 'custom');
  return explain(concrete.length > 0 ? concrete : issues, raw);
}

function explain(issues: ZodIssue[], raw: unknown): string[] {
  const checkIds: (string | undefined)[] = Array.isArray((raw as { checks?: unknown[] })?.checks)
    ? (raw as { checks: { id?: string }[] }).checks.map((c) =>
        typeof c?.id === 'string' ? c.id : undefined,
      )
    : [];

  return issues.map((issue) => {
    const where = locate(issue.path, checkIds);

    if (issue.code === 'unrecognized_keys') {
      const inCheck = issue.path[0] === 'checks';
      const valid = inCheck ? INTENT_CHECK_FIELDS : INTENT_FILE_FIELDS;
      return issue.keys
        .map((key: string) => {
          const near = nearestField(key, valid);
          return near
            ? `\`${key}\` is not a field — did you mean \`${near}\`? (${where})`
            : `\`${key}\` is not a field (${where}). Valid fields: ${valid.join(', ')}.`;
        })
        .join('; ');
    }

    // An expectation that is none of the allowed shapes surfaces as a union
    // failure, whose default rendering is a wall of every branch it tried.
    if (issue.code === 'invalid_union' && issue.path.includes('assert')) {
      return `${where}: not a valid expectation. An expectation is one of:\n` +
        EXPECTATION_FORMS.map((f) => `          - ${f}`).join('\n');
    }

    if (issue.code === 'invalid_literal' && issue.path[0] === 'version') {
      return `\`version\` must be 1 (found ${JSON.stringify(issue.received)}). ` +
        'The file format is v1 and grows additively; there is no v2.';
    }

    if (issue.message.includes('until must be')) {
      return `${where}: ${issue.message}. Write it as YYYY-MM-DD, for example 2026-12-31.`;
    }

    // Refinements carry a hand-written message already; the value here is the
    // location, which zod does not attach to a whole-object refinement.
    return `${where}: ${issue.message}`;
  });
}

/** Where the same id appears more than once — both locations, because "check
 *  ids must be unique" without saying which two is a search task. */
export function duplicateCheckIds(raw: unknown): string[] {
  const checks = (raw as { checks?: { id?: unknown }[] })?.checks;
  if (!Array.isArray(checks)) return [];
  const seen = new Map<string, number[]>();
  checks.forEach((c, i) => {
    if (typeof c?.id !== 'string') return;
    seen.set(c.id, [...(seen.get(c.id) ?? []), i + 1]);
  });
  return [...seen.entries()]
    .filter(([, positions]) => positions.length > 1)
    .map(([id, positions]) => `check id \`${id}\` is used ${positions.length} times — at #${positions.join(' and #')}`);
}
