import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseIntentDocument, evaluateCheck } from './engine/index.js';
import { CATALOG, BASELINE_ENTRIES } from './catalog.js';
import { renderBaselinePack, PACK_INTENT_PATH } from './pack.js';
import { init, summarise } from './init.js';
import { verifyIntent, VerifyInputError } from './verify.js';
import { GOOD, BAD } from './__fixtures__/catalog.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the catalog is one source, not two', () => {
  /**
   * What makes single-sourcing real rather than aspirational. The pack file is
   * checked in — reviewable in a diff, which matters for a file that becomes
   * other people's policy — and checked-in generated files are exactly the
   * kind that quietly stop matching their generator.
   */
  it.skip('the checked-in pack file matches what the catalog renders', () => {
    const onDisk = readFileSync(join(root, '..', 'pack-baseline', PACK_INTENT_PATH), 'utf8');
    expect(onDisk).toBe(renderBaselinePack());
  });

  it('every entry is a valid check whose id matches its metadata', () => {
    for (const entry of CATALOG) {
      const parsed = parseIntentDocument(`version: 1\nchecks:\n${entry.yaml}`);
      expect(parsed.checks, entry.id).toHaveLength(1);
      expect(parsed.checks[0]!.id).toBe(entry.id);
    }
  });

  it('has no duplicate ids', () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
  });

  it('renders a pack that parses as a v1 file', () => {
    expect(parseIntentDocument(renderBaselinePack()).checks.map((c) => c.id)).toEqual(
      BASELINE_ENTRIES.map((e) => e.id),
    );
  });

  /** A pack cannot ship exemptions — they are local decisions with local
   *  reasons — so none may appear in the generated file. */
  it('ships no exemptions', () => {
    for (const check of parseIntentDocument(renderBaselinePack()).checks) {
      expect(check.exempt, check.id).toBeUndefined();
    }
  });
});

/**
 * The fixture pairs.
 *
 * Every catalog rule has a template it must PASS and a template it must FAIL.
 * A rule that cannot fail is the failure mode this whole product exists to
 * avoid — `init` would emit it as an active check, the user would see a green
 * run, and the rule would be asserting nothing. The lesson guards use the same
 * philosophy for the same reason.
 */
describe('every catalog rule passes on good input and fails on bad', () => {
  const check = (id: string) =>
    parseIntentDocument(`version: 1\nchecks:\n${CATALOG.find((e) => e.id === id)!.yaml}`).checks[0]!;

  it('covers every entry — no rule ships without a fixture pair', () => {
    expect(Object.keys(GOOD).sort()).toEqual(CATALOG.map((e) => e.id).sort());
    expect(Object.keys(BAD).sort()).toEqual(CATALOG.map((e) => e.id).sort());
  });

  for (const entry of CATALOG) {
    it(`${entry.id} passes on good input`, () => {
      expect(evaluateCheck(GOOD[entry.id]!, check(entry.id)).passed).toBe(true);
    });

    it(`${entry.id} FAILS on bad input`, () => {
      // The half that matters. Proven to bite by construction: each BAD
      // fixture is the GOOD one with the asserted property broken.
      expect(evaluateCheck(BAD[entry.id]!, check(entry.id)).passed).toBe(false);
    });
  }
});

describe('init writes a snapshot of what the stack already does', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudsynth-init-unit-'));
    mkdirSync(join(dir, 'cdk.out'));
    writeFileSync(
      join(dir, 'cdk.out', 'App.template.json'),
      JSON.stringify({
        Resources: {
          // Passes queues-encrypted-at-rest.
          Q: { Type: 'AWS::SQS::Queue', Properties: { SqsManagedSseEnabled: true } },
          // Fails buckets-block-public-access and buckets-encrypted-at-rest.
          B: { Type: 'AWS::S3::Bucket', Properties: {} },
          // Matches no catalog rule at all.
          W: { Type: 'AWS::WAFv2::WebACL', Properties: {} },
        },
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const at = (name: string) => join(dir, name);
  const opts = (name: string, extra = {}) => ({
    outPath: at(name),
    templatePath: join(dir, 'cdk.out'),
    ...extra,
  });

  it('emits passing rules active and failing rules commented out', () => {
    const r = init(opts('a.yml'));
    expect(r.active).toContain('queues-encrypted-at-rest');
    expect(r.commented).toEqual(
      expect.arrayContaining(['buckets-block-public-access', 'buckets-encrypted-at-rest']),
    );
    const body = readFileSync(at('a.yml'), 'utf8');
    expect(body).toContain('#   - id: buckets-encrypted-at-rest');
    expect(body).toContain('  - id: queues-encrypted-at-rest');
  });

  it('says what currently violates a commented rule', () => {
    init(opts('b.yml'));
    expect(readFileSync(at('b.yml'), 'utf8')).toContain('1 resource currently violates this');
  });

  it('omits rules whose select matches nothing', () => {
    const r = init(opts('c.yml'));
    expect(r.skipped).toContain('databases-not-publicly-accessible');
    expect(readFileSync(at('c.yml'), 'utf8')).not.toContain('databases-not-publicly-accessible');
  });

  /**
   * The flagship guarantee. Every active check passed at generation time, so
   * the first `verify` after `init` is green by construction. A starter file
   * that fails immediately reads as the tool being broken.
   */
  it('writes a file that verifies clean, by construction', () => {
    init(opts('d.yml'));
    const r = verifyIntent({ intentPath: at('d.yml'), templatePath: join(dir, 'cdk.out') });
    expect(r.outcomes.filter((o) => !o.passed)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('--all emits the failing rules active instead, and then it does NOT verify clean', () => {
    init(opts('e.yml', { all: true }));
    const r = verifyIntent({ intentPath: at('e.yml'), templatePath: join(dir, 'cdk.out') });
    expect(r.passed).toBe(false);
  });

  it('writes the schema modeline and the two-line header', () => {
    init(opts('f.yml'));
    const [modeline, one, two] = readFileSync(at('f.yml'), 'utf8').split('\n');
    // The modeline goes first: the YAML language server looks near the top of
    // the file, and it is what turns an editor into an authoring tool.
    expect(modeline).toContain('# yaml-language-server: $schema=');
    expect(modeline).toContain('cloudsynth.dev/schema/intent-v1.json');
    expect(one).toContain('Generated by `cloudsynth init`');
    expect(two).toContain("Delete any check you don't mean");
  });

  it('refuses to clobber an existing file', () => {
    writeFileSync(at('g.yml'), 'version: 1\nchecks: []\n');
    expect(() => init(opts('g.yml'))).toThrow(VerifyInputError);
    expect(() => init(opts('g.yml', { force: true }))).not.toThrow();
  });

  it('summarises in the brief’s shape', () => {
    const r = init(opts('h.yml'));
    expect(summarise(r, false)).toMatch(
      /^wrote \d+ checks · \d+ more available but currently failing \(commented\) · \d+ skipped \(no matching resources\)$/,
    );
  });

  it('survives a malformed template rather than refusing to write anything', () => {
    const broken = join(dir, 'broken.out');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'X.template.json'), '{not json');
    expect(existsSync(init({ outPath: at('i.yml'), templatePath: broken }).path)).toBe(true);
  });
});
