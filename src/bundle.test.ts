import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The bundle has to work where nothing else does.
 *
 * A GitHub Action runs in a checkout of somebody else's repository: no
 * node_modules for our packages, no pnpm workspace, no way to resolve
 * src/engine. Everything the CLI needs is therefore inlined into
 * one file — and whether that file actually RUNS cannot be established from
 * inside the monorepo, where the missing pieces are all resolvable anyway.
 *
 * This test exists because the first bundle did not run. `yaml` ships a CJS
 * build that calls require('process'); ESM output has no require, so it died
 * on its first parse with "Dynamic require of 'process' is not supported" —
 * invisible in every in-repo test, fatal in the one place it would have
 * shipped to.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'cloudsynth.mjs');

let dir: string;

beforeAll(() => {
  if (!existsSync(bundle)) {
    execFileSync('node', [join(root, 'scripts', 'bundle.mjs')], { cwd: root });
  }
  // Deliberately outside the repo: a temp dir with no node_modules, no
  // package.json, and no path back to the workspace.
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-standalone-'));
  mkdirSync(join(dir, 'cdk.out'));
  writeFileSync(
    join(dir, 'cloudsynth.intent.yml'),
    `version: 1
checks:
  - id: bucket-blocks-public-access
    description: Bucket blocks all public access
    select: AWS::S3::Bucket
    assert:
      PublicAccessBlockConfiguration.BlockPublicAcls: true
`,
  );
});

function runIn(template: object): { status: number; output: string } {
  writeFileSync(join(dir, 'cdk.out', 'MyStack.template.json'), JSON.stringify(template));
  try {
    const output = execFileSync('node', [bundle, 'verify', '--format', 'text'], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const BUCKET = (props: object) => ({
  Resources: { Uploads: { Type: 'AWS::S3::Bucket', Properties: props } },
});

describe('the distributable bundle', () => {
  it('runs with no node_modules and no workspace, and fails a bad stack', () => {
    const r = runIn(BUCKET({}));
    expect(r.output).not.toContain('Dynamic require');
    expect(r.output).toContain('Bucket blocks all public access');
    expect(r.status).toBe(1);
  });

  it('exits 0 on a compliant stack', () => {
    expect(
      runIn(BUCKET({ PublicAccessBlockConfiguration: { BlockPublicAcls: true } })).status,
    ).toBe(0);
  });

  // The whole reason a customer can run this as one small file. If the CDK
  // creeps back into the intent path the bundle becomes tens of megabytes and
  // the Action stops being something anyone wants in their pipeline.
  /**
   * Every entry point, not just `verify`. The bundle's failure mode is a
   * module that only resolves inside the workspace, and that is per-code-path:
   * `init` reaches the catalog and the intent-file constants, which `verify`
   * does not, so a `verify`-only test would have said nothing about it.
   */
  it('runs `init` standalone, and the file it writes verifies', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'cloudsynth-init-'));
    mkdirSync(join(fresh, 'cdk.out'));
    // Genuinely compliant with everything the catalog proposes for a bucket,
    // so `verify` exits 0 and the assertion is about the round trip rather
    // than about this fixture's shortcomings.
    writeFileSync(
      join(fresh, 'cdk.out', 'MyStack.template.json'),
      JSON.stringify(
        BUCKET({
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          BucketEncryption: { ServerSideEncryptionConfiguration: [] },
        }),
      ),
    );

    const written = execFileSync('node', [bundle, 'init'], { cwd: fresh, encoding: 'utf8' });
    expect(written).toContain('wrote ');
    expect(existsSync(join(fresh, 'cloudsynth.intent.yml'))).toBe(true);

    // The starter file has to be a file this tool accepts. A `cloudsynth init`
    // whose output `cloudsynth verify` rejects is the worst possible first
    // five minutes, and only running both in sequence catches it.
    const verified = execFileSync('node', [bundle, 'verify', '--format', 'text'], {
      cwd: fresh,
      encoding: 'utf8',
    });
    expect(verified).toContain('coverage:');
    rmSync(fresh, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing intent file unless told to', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'cloudsynth-init-force-'));
    writeFileSync(join(fresh, 'cloudsynth.intent.yml'), 'version: 1\nchecks: []\n');
    let status = 0;
    try {
      execFileSync('node', [bundle, 'init'], { cwd: fresh, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      status = (err as { status?: number }).status ?? 1;
    }
    // 2, not 1: refusing to clobber a file is an input error, not a failing
    // check. Conflating the two is what makes a gating tool untrustworthy.
    expect(status).toBe(2);
    expect(readFileSync(join(fresh, 'cloudsynth.intent.yml'), 'utf8')).toContain('checks: []');

    execFileSync('node', [bundle, 'init', '--force'], { cwd: fresh, encoding: 'utf8' });
    expect(readFileSync(join(fresh, 'cloudsynth.intent.yml'), 'utf8')).toContain(
      'Generated by `cloudsynth init`',
    );
    rmSync(fresh, { recursive: true, force: true });
  });

  /**
   * The invariant the whole product rests on, asserted against the artefact
   * rather than the source. Grep-provable, and it must stay that way: there is
   * no code path in this tool that opens a socket.
   */
  it('contains no networking of any kind', () => {
    const source = readFileSync(bundle, 'utf8');
    for (const forbidden of [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dgram',
      'node:dns',
    ]) {
      expect(source.includes(forbidden), `${forbidden} reached the bundle`).toBe(false);
    }
    // `fetch` is a global, so an import is not the only way in.
    expect(/\bfetch\s*\(/.test(source), 'a fetch( call reached the bundle').toBe(false);
    expect(/XMLHttpRequest|WebSocket/.test(source)).toBe(false);
  });

  it('contains no CDK, no cdk-nag and no AWS SDK', () => {
    const source = readFileSync(bundle, 'utf8');
    for (const forbidden of ['aws-cdk-lib', 'cdk-nag', '@aws-sdk']) {
      expect(source.includes(forbidden), `${forbidden} leaked into the bundle`).toBe(false);
    }
    expect(source.length).toBeLessThan(2_000_000);
  });
});
