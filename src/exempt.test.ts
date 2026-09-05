import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyIntent, VerifyInputError } from './verify.js';
import { buildReport, render } from './report.js';

/**
 * Exemptions are the feature most likely to be quietly wrong, because every
 * failure mode looks like success: a carve-out that silently widens to the
 * whole check, a lapse nobody notices, a stale exemption naming a resource
 * that no longer exists. Each makes the tool report green while meaning less
 * than it did.
 */
let dir: string;

/** Two buckets. Only Legacy is unencrypted, so a carve-out for it must not
 *  also excuse Modern — the single most important property here. */
const TEMPLATE = {
  Resources: {
    LegacyAssets: { Type: 'AWS::S3::Bucket', Properties: {} },
    ModernAssets: { Type: 'AWS::S3::Bucket', Properties: { BucketEncryption: { on: true } } },
  },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-exempt-'));
  mkdirSync(join(dir, 'cdk.out'));
  writeFileSync(join(dir, 'cdk.out', 'AppStack.template.json'), JSON.stringify(TEMPLATE));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function intent(exempt: string): string {
  const p = join(dir, `i${seq++}.intent.yml`);
  writeFileSync(
    p,
    `version: 1
checks:
  - id: buckets-encrypted
    description: Buckets encrypt at rest
    select: AWS::S3::Bucket
    assert:
      BucketEncryption: present
${exempt}`,
  );
  return p;
}

const run = (intentPath: string, today = '2026-08-30') =>
  verifyIntent({
    intentPath,
    templatePath: join(dir, 'cdk.out'),
    now: new Date(`${today}T12:00:00Z`),
  });

const shown = (intentPath: string, today = '2026-08-30') => {
  const r = run(intentPath, today);
  return render(buildReport(r, { intentPath, toolVersion: '0.0.0-test' }), 'text', {
    intentPath,
    stale: r.staleExemptions,
    expired: r.expiredExemptions,
  });
};

const CARVE_OUT = `    exempt:
      - match: "LegacyAssets*"
        reason: "public by design — marketing site, migrating Q3"
`;

describe('an exemption excludes a resource, not the check', () => {
  /**
   * The property everything else depends on. Suppressing the whole check to
   * excuse one legacy bucket discards the protection for every other bucket,
   * which is how a single exception becomes an unguarded fleet.
   */
  it('excuses the named resource and keeps judging the rest', () => {
    const r = run(intent(CARVE_OUT));
    expect(r.passed).toBe(true);
    expect(r.outcomes[0]!.exempted).toEqual([
      { logicalId: 'LegacyAssets', reason: 'public by design — marketing site, migrating Q3' },
    ]);
    // ModernAssets was still examined and still had to hold.
    expect(r.outcomes[0]!.subjects).toBe(1);
  });

  it('still fails when a NON-exempted resource violates the check', () => {
    writeFileSync(
      join(dir, 'cdk.out', 'AppStack.template.json'),
      JSON.stringify({
        Resources: {
          LegacyAssets: { Type: 'AWS::S3::Bucket', Properties: {} },
          ModernAssets: { Type: 'AWS::S3::Bucket', Properties: {} },
        },
      }),
    );
    const r = run(intent(CARVE_OUT));
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.failures.map((f) => f.logicalId)).toEqual(['ModernAssets']);
    writeFileSync(join(dir, 'cdk.out', 'AppStack.template.json'), JSON.stringify(TEMPLATE));
  });

  /** A carve-out has to be visible in every run, not just to whoever reads the
   *  file — otherwise it is indistinguishable from the check being thorough. */
  it('reports the count on the PASS line', () => {
    expect(shown(intent(CARVE_OUT))).toContain('(1 resource, 1 exempted)');
  });

  it('carries the exemption and its reason into the machine-readable report', () => {
    const p = intent(CARVE_OUT);
    const json = buildReport(run(p), { intentPath: p, toolVersion: '0' });
    expect(json.checks[0]!.exempted).toEqual([
      { logicalId: 'LegacyAssets', reason: 'public by design — marketing site, migrating Q3' },
    ]);
  });

  /** "No security group allows SSH from anywhere, except this bastion" is the
   *  real-world case, and it needs the carve-out to work on a prohibition. */
  it('carves a resource out of a prohibition too', () => {
    const p = join(dir, `none${seq++}.yml`);
    writeFileSync(
      p,
      `version: 1
checks:
  - id: no-unencrypted-buckets
    description: No bucket is left unencrypted
    select: AWS::S3::Bucket
    quantifier: none
    exempt:
      - match: "LegacyAssets"
        reason: "migrating Q3"
    assert:
      BucketEncryption: absent
`,
    );
    expect(run(p).passed).toBe(true);
  });
});

describe('expiry bites', () => {
  const expiring = () =>
    intent(`    exempt:
      - match: "LegacyAssets*"
        reason: "migrating Q3"
        until: 2026-08-31
`);

  it('holds through the last day, inclusive', () => {
    expect(run(expiring(), '2026-08-31').passed).toBe(true);
  });

  /** Expiry that does not bite is decoration: past the date the resource is
   *  judged again and an unfixed violation fails the run. */
  it('is ignored the day after, and the unfixed violation fails', () => {
    const r = run(expiring(), '2026-09-01');
    expect(r.passed).toBe(false);
    expect(r.outcomes[0]!.exempted).toEqual([]);
    expect(r.outcomes[0]!.failures.map((f) => f.logicalId)).toContain('LegacyAssets');
  });

  it('names the expired exemption, so the reappearance is explained', () => {
    expect(shown(expiring(), '2026-09-01')).toContain(
      'the exemption LegacyAssets* on buckets-encrypted expired on 2026-08-31',
    );
  });
});

describe('a stale exemption is surfaced, not swallowed', () => {
  /** An exemption naming a resource that no longer exists is a lie the file is
   *  telling, and a run that mentions it is the only moment anyone notices. */
  it('warns when a match exempts nothing', () => {
    const p = intent(`    exempt:
      - match: "DeletedYearsAgo*"
        reason: "was migrating Q3"
`);
    expect(run(p).staleExemptions).toEqual([
      { checkId: 'buckets-encrypted', match: 'DeletedYearsAgo*' },
    ]);
    expect(shown(p)).toContain('exempts nothing — remove it');
  });

  it('does not call an exemption stale just because one template lacks it', () => {
    writeFileSync(join(dir, 'cdk.out', 'Other.template.json'), JSON.stringify({ Resources: {} }));
    expect(run(intent(CARVE_OUT)).staleExemptions).toEqual([]);
    rmSync(join(dir, 'cdk.out', 'Other.template.json'));
  });
});

describe('the file has to say why', () => {
  it('rejects an exemption with no reason', () => {
    expect(() =>
      run(intent('    exempt:\n      - match: "LegacyAssets*"\n')),
    ).toThrow(VerifyInputError);
  });

  it('rejects an empty reason rather than accepting a placeholder', () => {
    expect(() =>
      run(intent('    exempt:\n      - match: "L*"\n        reason: "   "\n')),
    ).toThrow(/why/i);
  });

  it('rejects an exemption with no match', () => {
    expect(() => run(intent('    exempt:\n      - reason: "because"\n'))).toThrow(VerifyInputError);
  });

  it('rejects a date that is not a real calendar date', () => {
    expect(() =>
      run(intent('    exempt:\n      - match: "L*"\n        reason: x\n        until: 2026-13-45\n')),
    ).toThrow(/until/i);
  });
});
