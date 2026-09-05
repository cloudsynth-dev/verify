import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseIntentDocument, IntentFileError } from './engine/index.js';
import type { IntentCheck } from './engine/index.js';
import type { CoverageRequirement } from './contract/intent.js';
import { INTENT_FILE_NAME } from './contract/intent.js';

/**
 * Resolving `extends` — how a team adopts rules it did not write.
 *
 * This is the piece that turns an intent file from a per-repo artefact into
 * something an organisation can standardise on, and the design is shaped
 * almost entirely by what happens when the two disagree. A team adopts a
 * baseline, decides one of its rules is wrong for them, and needs a way to say
 * so that is not "fork the pack" — because a fork never receives an update
 * again, and the whole value of a shared baseline is that it moves.
 *
 * So: a check id defined nearer the root REPLACES an inherited one. Overriding
 * is a normal, reviewable, one-check edit that leaves the rest of the pack
 * live.
 *
 * ── Why a pack is a package with a YAML file in it ───────────────────────────
 * A pack is `node_modules/<name>/cloudsynth.intent.yml`, and nothing else. No
 * entry point, no index.js, nothing this tool ever executes. That is a
 * deliberate limit: the moment a pack can ship code, adopting somebody's
 * ruleset means running their code in your CI, and this tool's entire claim is
 * that it reads two kinds of file off disk and does nothing else. A pack that
 * cannot execute cannot betray that.
 *
 * ── Why resolution is here and not in the engine ─────────────────────────────
 * It needs the filesystem. The engine parses and evaluates in the browser too,
 * for the playground, and putting `node:fs` behind that import would end that.
 */

/** Depth is bounded so a pathological chain fails with a sentence rather than
 *  a stack overflow. Nothing legitimate is more than a couple deep. */
const MAX_DEPTH = 10;

export class IntentResolutionError extends Error {}

/** A check plus where it came from. */
export type SourcedCheck = IntentCheck & {
  source: string;
  /** Fields the consuming file adjusted on an inherited check. Carried into
   *  the report so the audit trail survives: a rule can be attributed to the
   *  pack that wrote it AND to the repo that demoted it. */
  overridden?: ('severity')[];
};

export interface ResolvedIntent {
  checks: SourcedCheck[];
  /** Override keys that matched no check after the merge — a rule that was
   *  renamed or removed upstream, silently doing nothing. Same visibility
   *  philosophy as a stale exemption. */
  unusedOverrides: string[];
  require?: CoverageRequirement;
  /** Every file that contributed, nearest last — the merge order, readable. */
  sources: string[];
}

/**
 * Where an `extends` entry points.
 *
 * A path is anything starting `.` or `/`; everything else is a package name.
 * Deliberately not "does this file exist" — a typo'd path should say the path
 * is missing, not go looking for a package by that name and report a much
 * more confusing error.
 */
function isPath(specifier: string): boolean {
  return specifier.startsWith('.') || isAbsolute(specifier);
}

/**
 * Resolve a pack specifier to a file on disk, and to a version for provenance.
 *
 * Node resolution first — `createRequire` from the intent file's own path, so
 * a pack resolves exactly the way any other dependency of that project would,
 * including in a pnpm store, a hoisted tree, or a workspace link. A pack whose
 * `main`/`exports` points at a `.yml` therefore works with no convention at
 * all.
 *
 * The `<pkg>/cloudsynth.intent.yml` fallback exists because the natural shape
 * of a pack is a package with no entry point whatsoever: no `main`, no
 * `exports`, nothing runnable. That package cannot be resolved through its
 * exports map — there is nothing to export — so the convention is what makes
 * the safest possible pack the easy one to publish.
 *
 * Nothing here fetches. `npm install` put the files there; this reads disk.
 */
function resolvePack(
  specifier: string,
  fromFile: string,
): { path: string; version?: string } {
  const require = createRequire(fromFile);

  const attempts = [
    // A package that deliberately points at its intent file.
    () => require.resolve(specifier),
    // The convention, for a pack with no entry point at all.
    () => require.resolve(`${specifier}/${INTENT_FILE_NAME}`),
  ];

  let resolved: string | undefined;
  for (const attempt of attempts) {
    try {
      const candidate = attempt();
      if (candidate.endsWith('.yml') || candidate.endsWith('.yaml')) {
        resolved = candidate;
        break;
      }
    } catch {
      // Try the next strategy. A specifier that resolves to nothing at all is
      // reported below, with the install command that would fix it.
    }
  }

  // Last resort: walk for node_modules/<name>/cloudsynth.intent.yml directly.
  // Node resolution refuses a subpath a package does not declare in `exports`,
  // and a YAML-only pack published without an `exports` map is exactly that
  // case — the shape most worth supporting.
  if (!resolved) {
    let dir = dirname(resolve(fromFile));
    for (;;) {
      const candidate = join(dir, 'node_modules', specifier, INTENT_FILE_NAME);
      if (existsSync(candidate)) {
        resolved = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  if (!resolved) {
    throw new IntentResolutionError(
      `Cannot find the pack "${specifier}". Install it (npm i -D ${specifier}), or use a path ` +
        `starting with ./ if you meant a file. Looked for it through Node resolution and for ` +
        `node_modules${sep}${specifier}${sep}${INTENT_FILE_NAME} upwards from ${dirname(fromFile)}.`,
    );
  }

  return { path: resolved, ...(packVersion(specifier, fromFile) ?? {}) };
}

/** The pack's published version, for the audit trail. Absent rather than
 *  guessed when the manifest cannot be read — a wrong version in a provenance
 *  record is worse than no version. */
function packVersion(specifier: string, fromFile: string): { version: string } | undefined {
  try {
    const manifest = createRequire(fromFile).resolve(`${specifier}/package.json`);
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
    return typeof version === 'string' ? { version } : undefined;
  } catch {
    let dir = dirname(resolve(fromFile));
    for (;;) {
      const candidate = join(dir, 'node_modules', specifier, 'package.json');
      if (existsSync(candidate)) {
        try {
          const version = JSON.parse(readFileSync(candidate, 'utf8')).version;
          return typeof version === 'string' ? { version } : undefined;
        } catch {
          return undefined;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

/**
 * Load an intent file and everything it extends, nearest-wins.
 *
 * Depth-first and in order, so within one `extends` list a later entry beats an
 * earlier one, and the file's own checks beat everything it extends. That
 * matches how a reader scans the file: the things nearest the bottom, and
 * nearest to you, are the ones in force.
 */
function stripExemptions(check: SourcedCheck): SourcedCheck {
  const { exempt: _dropped, ...rest } = check;
  return rest as SourcedCheck;
}

export function resolveIntent(
  intentPath: string,
  seen: string[] = [],
  depth = 0,
): ResolvedIntent {
  const absolute = resolve(intentPath);

  // A cycle is a mistake with a confusing symptom — without this it is a hang
  // or a stack overflow, and the file that closed the loop is never named.
  if (seen.includes(absolute)) {
    throw new IntentResolutionError(
      `Circular extends: ${[...seen, absolute].join(' -> ')}`,
    );
  }
  if (depth > MAX_DEPTH) {
    throw new IntentResolutionError(`extends nested more than ${MAX_DEPTH} deep, starting at ${intentPath}`);
  }
  if (!existsSync(absolute)) {
    throw new IntentResolutionError(`No intent file at ${intentPath}.`);
  }

  let document;
  try {
    document = parseIntentDocument(readFileSync(absolute, 'utf8'));
  } catch (err) {
    if (err instanceof IntentFileError) {
      // Name the file. With extends in play, "cloudsynth.intent.yml is
      // invalid" is ambiguous the moment more than one is involved.
      // The file first, then the problems, each on its own line. With
      // `extends` in play more than one file can be at fault, and a reader
      // needs to know which one before anything else.
      throw new IntentResolutionError(`${intentPath} is invalid:\n        ${err.message}`);
    }
    throw err;
  }

  const merged = new Map<string, SourcedCheck>();
  const sources: string[] = [];
  const unusedOverrides: string[] = [];
  let require: CoverageRequirement | undefined;

  for (const specifier of document.extends ?? []) {
    let childPath: string;
    let label: string;
    if (isPath(specifier)) {
      childPath = resolve(dirname(absolute), specifier);
      label = specifier;
    } else {
      const pack = resolvePack(specifier, absolute);
      childPath = pack.path;
      // `<pack>@<version>` — the audit trail an org layer needs to answer
      // "which version of the baseline was this repo judged against".
      label = pack.version ? `${specifier}@${pack.version}` : specifier;
    }

    const child = resolveIntent(childPath, [...seen, absolute], depth + 1);
    for (const inherited of child.checks) {
      /**
       * An inherited check arrives WITHOUT its exemptions.
       *
       * An exemption is a local decision with a local reason — "this bucket is
       * public by design, migrating Q3" is a sentence about one team's
       * infrastructure. A pack shipping pre-exempted checks would carve holes
       * in every consumer's policy for reasons that are true in none of their
       * repositories, and the consumer would never see it: the exemption is in
       * a file inside node_modules that nobody reviews.
       *
       * A repo that wants the carve-out redefines the check locally, which is
       * the same override mechanism as any other disagreement, and leaves the
       * reason in its own file where review can see it.
       */
      const check = inherited.exempt ? stripExemptions(inherited) : inherited;
      // A pack's name and version is more useful provenance than the path its
      // file happened to be unpacked to. Checks inherited THROUGH this pack
      // from another keep their own attribution.
      merged.set(check.id, check.source === 'local' ? { ...check, source: label } : check);
    }
    for (const s of child.sources) sources.push(s === 'local' ? label : s);
    for (const u of child.unusedOverrides) unusedOverrides.push(u);
    if (child.require) require = child.require;
  }

  for (const check of document.checks) {
    // `local` rather than the path. The report is an audit trail an org layer
    // aggregates across repositories, where one repo's "./cloudsynth.intent.yml"
    // is not distinguishable from another's — what matters is that the rule was
    // the team's own and not inherited.
    merged.set(check.id, { ...check, source: 'local' });
  }
  sources.push('local');
  if (document.coverage?.require) require = document.coverage.require;

  // Applied AFTER the merge, so it can name a check from any depth — that is
  // the whole point: dropping an inherited rule you cannot edit.
  for (const id of document.disable ?? []) merged.delete(id);

  // Overrides come after `disable`: disabling a check and then overriding it
  // would be contradictory, and the removal is the stronger statement.
  for (const [id, patch] of Object.entries(document.overrides ?? {})) {
    const target = merged.get(id);
    if (!target) {
      unusedOverrides.push(id);
      continue;
    }
    merged.set(id, {
      ...target,
      severity: patch.severity,
      overridden: [...new Set([...(target.overridden ?? []), 'severity' as const])],
    });
  }

  // A diamond — two files extending the same pack — is legal and resolves it
  // twice; listing it twice would just be noise.
  return {
    checks: [...merged.values()],
    unusedOverrides,
    ...(require ? { require } : {}),
    sources: [...new Set(sources)],
  };
}
