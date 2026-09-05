import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveIntent, IntentResolutionError } from './resolve.js';
import { verifyIntent, VerifyInputError } from './verify.js';
import { buildReport, render } from './report.js';

/**
 * `extends` is what makes an intent file something an organisation can
 * standardise on rather than a per-repo artefact, and the interesting cases
 * are all about disagreement: what happens when the pack and the repo want
 * different things, and whether a reader can tell which is which.
 */
let dir: string;

const BASELINE = `version: 1
checks:
  - id: buckets-encrypted
    description: Buckets encrypt at rest
    select: AWS::S3::Bucket
    on-empty: pass
    assert:
      BucketEncryption: present

  - id: tables-encrypted
    description: Tables encrypt at rest
    select: AWS::DynamoDB::Table
    on-empty: pass
    assert:
      SSESpecification.SSEEnabled: true
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-ext-'));
  mkdirSync(join(dir, 'cdk.out'));
  writeFileSync(
    join(dir, 'cdk.out', 'App.template.json'),
    JSON.stringify({
      Resources: { Uploads: { Type: 'AWS::S3::Bucket', Properties: {} } },
    }),
  );
  // A pack is a package containing an intent file. Nothing else.
  mkdirSync(join(dir, 'node_modules', 'cloudsynth-pack-demo'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'cloudsynth-pack-demo', 'cloudsynth.intent.yml'), BASELINE);
  // A real pack has no entry point at all — no main, no exports — which is
  // exactly the shape node resolution cannot resolve a subpath through, and
  // why the walk-up fallback exists.
  writeFileSync(
    join(dir, 'node_modules', 'cloudsynth-pack-demo', 'package.json'),
    JSON.stringify({ name: 'cloudsynth-pack-demo', version: '2.1.0' }),
  );
  writeFileSync(join(dir, 'baseline.yml'), BASELINE);
  // Deep enough to prove resolution walks up, as it must in a monorepo.
  mkdirSync(join(dir, 'packages', 'app'), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function intent(body: string, at = dir): string {
  const p = join(at, `e${seq++}.intent.yml`);
  writeFileSync(p, body);
  return p;
}

describe('a pack is a package with a YAML file in it', () => {
  it('resolves by package name from node_modules', () => {
    const r = resolveIntent(intent('version: 1\nextends: [cloudsynth-pack-demo]\n'));
    expect(r.checks.map((c) => c.id)).toEqual(['buckets-encrypted', 'tables-encrypted']);
  });

  /** A monorepo puts node_modules at the root, not next to every file. */
  it('walks up to find node_modules', () => {
    const r = resolveIntent(
      intent('version: 1\nextends: [cloudsynth-pack-demo]\n', join(dir, 'packages', 'app')),
    );
    expect(r.checks).toHaveLength(2);
  });

  /** `<pack>@<version>` — the audit trail that answers "which version of the
   *  baseline was this repo judged against". */
  it('attributes inherited checks to the pack AND its version', () => {
    const r = resolveIntent(intent('version: 1\nextends: [cloudsynth-pack-demo]\n'));
    expect(r.checks.every((c) => c.source === 'cloudsynth-pack-demo@2.1.0')).toBe(true);
  });

  it('says how to fix a pack that is not installed', () => {
    expect(() => resolveIntent(intent('version: 1\nextends: [cloudsynth-pack-nope]\n'))).toThrow(
      /npm i -D cloudsynth-pack-nope/,
    );
  });

  it('treats a ./path as a path, never as a package', () => {
    const r = resolveIntent(intent('version: 1\nextends: ["./baseline.yml"]\n'));
    expect(r.checks).toHaveLength(2);
  });

  it('reports a missing path as a missing file, not a missing package', () => {
    expect(() => resolveIntent(intent('version: 1\nextends: ["./nope.yml"]\n'))).toThrow(
      /No intent file at/,
    );
  });
});

describe('nearest wins', () => {
  /**
   * The reason `extends` is worth having at all. A team that disagrees with
   * one rule must be able to say so without forking the pack — a fork never
   * receives an update again.
   */
  it('a local check replaces an inherited one with the same id', () => {
    const r = resolveIntent(
      intent(`version: 1
extends: [cloudsynth-pack-demo]
checks:
  - id: buckets-encrypted
    description: Buckets encrypt with a customer-managed key
    select: AWS::S3::Bucket
    on-empty: pass
    assert:
      BucketEncryption.ServerSideEncryptionConfiguration: present
`),
    );
    expect(r.checks).toHaveLength(2);
    const overridden = r.checks.find((c) => c.id === 'buckets-encrypted')!;
    expect(overridden.description).toBe('Buckets encrypt with a customer-managed key');
    expect(overridden.source).not.toBe('cloudsynth-pack-demo');
  });

  it('a later entry in extends beats an earlier one', () => {
    writeFileSync(
      join(dir, 'stricter.yml'),
      `version: 1
checks:
  - id: buckets-encrypted
    description: From stricter
    select: AWS::S3::Bucket
    on-empty: pass
    assert:
      BucketEncryption: present
`,
    );
    const r = resolveIntent(
      intent('version: 1\nextends: ["./baseline.yml", "./stricter.yml"]\n'),
    );
    expect(r.checks.find((c) => c.id === 'buckets-encrypted')!.description).toBe('From stricter');
  });

  it('a local coverage requirement overrides an inherited one', () => {
    writeFileSync(
      join(dir, 'required.yml'),
      `version: 1
coverage:
  require:
    - AWS::Lambda::Function
checks:
${BASELINE.split('checks:\n')[1]}`,
    );
    const inherited = resolveIntent(intent('version: 1\nextends: ["./required.yml"]\n'));
    expect(inherited.require).toEqual(['AWS::Lambda::Function']);

    const overridden = resolveIntent(
      intent(
        'version: 1\nextends: ["./required.yml"]\ncoverage:\n  require:\n    - AWS::S3::Bucket\n',
      ),
    );
    expect(overridden.require).toEqual(['AWS::S3::Bucket']);
  });

  it('lists every contributing file in merge order, nearest last', () => {
    const p = intent('version: 1\nextends: [cloudsynth-pack-demo]\n');
    // `local` rather than a path: an org layer aggregating across repos cannot
    // tell one repo's ./cloudsynth.intent.yml from another's.
    expect(resolveIntent(p).sources).toEqual(['cloudsynth-pack-demo@2.1.0', 'local']);
  });
});

describe('disable removes an inherited rule without forking the pack', () => {
  it('drops the id after the merge', () => {
    const r = resolveIntent(
      intent('version: 1\nextends: [cloudsynth-pack-demo]\ndisable: [tables-encrypted]\n'),
    );
    expect(r.checks.map((c) => c.id)).toEqual(['buckets-encrypted']);
  });

  it('can disable a check the local file also redefines, and the removal wins', () => {
    const r = resolveIntent(
      intent(`version: 1
extends: [cloudsynth-pack-demo]
disable: [buckets-encrypted]
checks:
  - id: buckets-encrypted
    description: Locally redefined
    select: AWS::S3::Bucket
    on-empty: pass
    assert:
      BucketEncryption: present
`),
    );
    expect(r.checks.map((c) => c.id)).toEqual(['tables-encrypted']);
  });
});

describe('a pack cannot ship exemptions', () => {
  /**
   * An exemption is a local decision with a local reason. A pack carving holes
   * in every consumer's policy — for reasons true in none of their
   * repositories, in a file inside node_modules nobody reviews — is the one
   * way `extends` could make a repo less safe than not using it.
   */
  it('strips exemptions from an inherited check', () => {
    writeFileSync(
      join(dir, 'exempting.yml'),
      `version: 1
checks:
  - id: buckets-encrypted
    description: Buckets encrypt at rest
    select: AWS::S3::Bucket
    on-empty: pass
    exempt:
      - match: "*"
        reason: "the pack author decided this for you"
    assert:
      BucketEncryption: present
`,
    );
    const r = resolveIntent(intent('version: 1\nextends: ["./exempting.yml"]\n'));
    expect(r.checks[0]!.exempt).toBeUndefined();
  });

  it('keeps an exemption the consuming file declares itself', () => {
    const r = resolveIntent(
      intent(`version: 1
extends: ["./exempting.yml"]
checks:
  - id: buckets-encrypted
    description: Buckets encrypt at rest
    select: AWS::S3::Bucket
    on-empty: pass
    exempt:
      - match: "LegacyAssets"
        reason: "our decision, in our file"
    assert:
      BucketEncryption: present
`),
    );
    expect(r.checks[0]!.exempt).toHaveLength(1);
  });
});

describe('a file that only extends is a legitimate shape', () => {
  it('needs no checks of its own', () => {
    const r = verifyIntent({
      intentPath: intent('version: 1\nextends: [cloudsynth-pack-demo]\n'),
      templatePath: join(dir, 'cdk.out'),
      now: new Date('2026-08-30T12:00:00Z'),
    });
    expect(r.outcomes).toHaveLength(2);
  });

  it('still rejects a file that defines nothing at all', () => {
    expect(() =>
      verifyIntent({
        intentPath: intent('version: 1\n'),
        templatePath: join(dir, 'cdk.out'),
      }),
    ).toThrow(VerifyInputError);
  });
});

describe('failures that cannot be diagnosed are refused', () => {
  it('names the loop rather than hanging or overflowing the stack', () => {
    const a = join(dir, 'cycle-a.yml');
    const b = join(dir, 'cycle-b.yml');
    writeFileSync(a, 'version: 1\nextends: ["./cycle-b.yml"]\n');
    writeFileSync(b, 'version: 1\nextends: ["./cycle-a.yml"]\n');
    expect(() => resolveIntent(a)).toThrow(IntentResolutionError);
    expect(() => resolveIntent(a)).toThrow(/Circular extends/);
  });

  /** With more than one file in play, "cloudsynth.intent.yml is invalid" no
   *  longer identifies anything. */
  it('names which file failed to parse', () => {
    writeFileSync(join(dir, 'broken.yml'), 'version: 9\nchecks: []\n');
    expect(() => resolveIntent(intent('version: 1\nextends: ["./broken.yml"]\n'))).toThrow(
      /broken\.yml/,
    );
  });
});

describe('provenance reaches the reader', () => {
  const failing = () =>
    verifyIntent({
      intentPath: intent('version: 1\nextends: [cloudsynth-pack-demo]\n'),
      templatePath: join(dir, 'cdk.out'),
      now: new Date('2026-08-30T12:00:00Z'),
    });

  it('names the pack on an inherited failure', () => {
    const r = failing();
    const text = render(buildReport(r, { intentPath: 'x.yml', toolVersion: '0' }), 'text');
    expect(text).toContain('(from cloudsynth-pack-demo@2.1.0)');
  });

  it('carries the source into the machine-readable report', () => {
    const json = buildReport(failing(), { intentPath: 'x.yml', toolVersion: '0' });
    expect(json.checks[0]!.source).toBe('cloudsynth-pack-demo@2.1.0');
  });

  it('stays quiet about origin when there is only one file', () => {
    const p = intent(`version: 1
checks:
  - id: buckets-encrypted
    description: Buckets encrypt at rest
    select: AWS::S3::Bucket
    assert:
      BucketEncryption: present
`);
    const r = verifyIntent({ intentPath: p, templatePath: join(dir, 'cdk.out') });
    expect(render(buildReport(r, { intentPath: p, toolVersion: '0' }), 'text')).not.toContain(
      '(from ',
    );
  });
});

describe('severity overrides on an inherited check', () => {
  /**
   * The friction this removes. A team wanting a pack's rule as a warning had
   * two options and both were bad: redefine it locally and forfeit every
   * future update to it — defeating `extends` — or `disable` it and lose the
   * rule entirely.
   */
  it('demotes a pack check to a warning without copying it', () => {
    const p = intent(`version: 1
extends: [cloudsynth-pack-demo]
overrides:
  buckets-encrypted:
    severity: warning
`);
    const r = resolveIntent(p);
    const check = r.checks.find((c) => c.id === 'buckets-encrypted')!;
    expect(check.severity).toBe('warning');
    // Still the pack's check — the whole point is that it keeps updating.
    expect(check.source).toBe('cloudsynth-pack-demo@2.1.0');
    expect(check.overridden).toEqual(['severity']);
  });

  it('a demoted failure no longer fails the build', () => {
    const p = intent(`version: 1
extends: [cloudsynth-pack-demo]
overrides:
  buckets-encrypted:
    severity: warning
`);
    const r = verifyIntent({
      intentPath: p,
      templatePath: join(dir, 'cdk.out'),
      now: new Date('2026-08-30T12:00:00Z'),
    });
    // The Uploads bucket has no encryption, so the check genuinely fails —
    // and the run still passes, because the file said it was a warning.
    expect(r.outcomes.find((o) => o.check.id === 'buckets-encrypted')!.passed).toBe(false);
    expect(r.passed).toBe(true);
    expect(r.warningCount).toBe(1);
  });

  /** A rule the pack renamed or dropped, silently doing nothing. Same
   *  visibility philosophy as a stale exemption. */
  it('warns when an override names no check', () => {
    const r = resolveIntent(
      intent('version: 1\nextends: [cloudsynth-pack-demo]\noverrides:\n  no-such-check:\n    severity: warning\n'),
    );
    expect(r.unusedOverrides).toEqual(['no-such-check']);
  });

  it('says so in the output', () => {
    const p = intent(
      'version: 1\nextends: [cloudsynth-pack-demo]\noverrides:\n  no-such-check:\n    severity: warning\n',
    );
    const r = verifyIntent({ intentPath: p, templatePath: join(dir, 'cdk.out') });
    const text = render(buildReport(r, { intentPath: p, toolVersion: '0' }), 'text', {
      intentPath: p,
      stale: r.staleExemptions,
      expired: r.expiredExemptions,
      unusedOverrides: r.unusedOverrides,
    });
    expect(text).toContain('the override for no-such-check overrides nothing');
  });

  /** `disable` is the stronger statement; overriding a removed check would be
   *  contradictory, so the removal wins and the override is reported unused. */
  it('disable beats override', () => {
    const r = resolveIntent(
      intent(`version: 1
extends: [cloudsynth-pack-demo]
disable: [buckets-encrypted]
overrides:
  buckets-encrypted:
    severity: warning
`),
    );
    expect(r.checks.map((c) => c.id)).toEqual(['tables-encrypted']);
    expect(r.unusedOverrides).toEqual(['buckets-encrypted']);
  });

  /** Severity is the ONLY overridable field. Anything else changes what a
   *  check MEANS, for which local redefinition is the honest mechanism. */
  it('refuses to override any other field', () => {
    expect(() =>
      resolveIntent(
        intent('version: 1\nextends: [cloudsynth-pack-demo]\noverrides:\n  buckets-encrypted:\n    description: Something else\n'),
      ),
    ).toThrow(IntentResolutionError);
  });

  it('carries the override into the machine-readable report', () => {
    const p = intent(
      'version: 1\nextends: [cloudsynth-pack-demo]\noverrides:\n  buckets-encrypted:\n    severity: warning\n',
    );
    const r = verifyIntent({ intentPath: p, templatePath: join(dir, 'cdk.out') });
    const json = buildReport(r, { intentPath: p, toolVersion: '0' });
    const c = json.checks.find((x) => x.id === 'buckets-encrypted')!;
    expect(c.source).toBe('cloudsynth-pack-demo@2.1.0');
    expect(c.overridden).toEqual(['severity']);
    expect(c.outcome).toBe('warn');
  });
});
