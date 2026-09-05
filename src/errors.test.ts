import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyIntent, VerifyInputError } from './verify.js';
import { buildReport, render } from './report.js';
import { run, nodeVersionProblem } from './index.js';

/**
 * The gating-tool bar: a tool that blocks a deploy owes the person it blocked
 * a next action. Every message below is asserted on its actual text, because
 * "it throws" is not the property that matters — what it says is.
 */
let dir: string;

const TEMPLATE = { Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: {} } } };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudsynth-errors-'));
  mkdirSync(join(dir, 'cdk.out'));
  mkdirSync(join(dir, 'empty'));
  mkdirSync(join(dir, 'jsonly'));
  writeFileSync(join(dir, 'cdk.out', 'App.template.json'), JSON.stringify(TEMPLATE));
  writeFileSync(join(dir, 'jsonly', 'parameters.json'), '{}');
  // One failing check and one passing one, so --quiet has something to drop.
  writeFileSync(join(dir, 'ok.intent.yml'), `version: 1
checks:
  - id: queues-encrypted
    description: Queues encrypt at rest
    select: AWS::SQS::Queue
    assert:
      SqsManagedSseEnabled: true
  - id: queues-exist
    description: The app defines a queue
    select: AWS::SQS::Queue
    quantifier: any
    assert:
      Properties: absent
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const write = (text: string) => {
  const p = join(dir, `e${seq++}.intent.yml`);
  writeFileSync(p, text);
  return p;
};
const check = (intentPath: string, templatePath = join(dir, 'cdk.out')) =>
  verifyIntent({ intentPath, templatePath });

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a failure, got none');
}

const OK = () => join(dir, 'ok.intent.yml');

describe('schema errors name what, where, and what to do', () => {
  it('suggests the nearest field for a misspelling', () => {
    const m = message(() =>
      check(write('version: 1\nchecks:\n  - id: x\n    description: X\n    select: AWS::S3::Bucket\n    quantifer: none\n    assert: {A: present}\n')),
    );
    expect(m).toContain('`quantifer` is not a field — did you mean `quantifier`?');
    expect(m).toContain('check `x`');
  });

  it('lists valid fields when nothing is close enough to suggest', () => {
    const m = message(() =>
      check(write('version: 1\nchecks:\n  - id: x\n    description: X\n    select: AWS::S3::Bucket\n    zzzzzzzzzz: 1\n    assert: {A: present}\n')),
    );
    expect(m).not.toContain('did you mean');
    expect(m).toContain('Valid fields:');
    expect(m).toContain('quantifier');
  });

  it('names both locations of a duplicate id, and says it once', () => {
    const m = message(() =>
      check(write(`version: 1
checks:
  - id: dup
    description: A
    select: AWS::S3::Bucket
    assert: {A: present}
  - id: dup
    description: B
    select: AWS::S3::Bucket
    assert: {B: present}
`)),
    );
    expect(m).toContain('check id `dup` is used 2 times — at #1 and #2');
    expect(m).not.toContain('check ids must be unique');
  });

  it('lists the allowed expectation forms rather than dumping a union error', () => {
    const m = message(() =>
      check(write('version: 1\nchecks:\n  - id: x\n    description: X\n    select: AWS::S3::Bucket\n    assert:\n      A: {bogus: 1}\n')),
    );
    expect(m).toContain('not a valid expectation');
    expect(m).toContain('`present` or `absent`');
    expect(m).toContain('`{ at-least: <number> }`');
  });

  it('says the expected date format for a bad `until`', () => {
    const m = message(() =>
      check(write(`version: 1
checks:
  - id: x
    description: X
    select: AWS::S3::Bucket
    exempt:
      - match: "*"
        reason: because
        until: 31-12-2026
    assert: {A: present}
`)),
    );
    expect(m).toContain('YYYY-MM-DD');
  });

  it('drops the consequence when a concrete cause explains it', () => {
    const m = message(() => check(write('version: 1\ncheks:\n  - id: x\n')));
    expect(m).toContain('did you mean `checks`?');
    expect(m).not.toContain('must define `checks` or `extends`');
  });

  it('still reports a refinement when it is the only thing wrong', () => {
    const m = message(() => check(write('version: 1\nchecks: []\n')));
    expect(m).toContain('must define `checks` or `extends`');
  });

  it('names the file, which matters as soon as `extends` is involved', () => {
    const p = write('version: 1\nchecks:\n  - id: x\n');
    expect(message(() => check(p))).toContain(p);
  });
});

describe('input errors are distinct, and each says what to do next', () => {
  it('missing path', () => {
    const m = message(() => check(OK(), join(dir, 'nope')));
    expect(m).toContain('No synthesized templates found at');
    expect(m).toContain('run `cdk synth` first');
  });

  it('empty directory says it is empty, not that synth failed', () => {
    expect(message(() => check(OK(), join(dir, 'empty')))).toContain(
      'is empty — no synthesized templates found',
    );
  });

  it('JSON files that are not templates say so specifically', () => {
    const m = message(() => check(OK(), join(dir, 'jsonly')));
    expect(m).toContain('contains JSON files but none named *.template.json');
    expect(m).toContain('parameters.json');
  });

  it('unreadable JSON suggests the interrupted-synth cause', () => {
    const broken = join(dir, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'X.template.json'), '{"Resources":');
    const m = message(() => check(OK(), broken));
    expect(m).toContain('is not valid JSON');
    expect(m).toContain('interrupted');
  });

  it('a missing intent file points at `cloudsynth init`', () => {
    expect(message(() => check(join(dir, 'absent.yml')))).toContain('cloudsynth init');
  });
});

describe('YAML edge cases, pinned', () => {
  const doc = `version: 1
checks:
  - id: x
    description: X
    select: AWS::SQS::Queue
    on-empty: pass
    assert:
      SqsManagedSseEnabled: true
`;

  /**
   * Anchors and aliases WORK. They were banned outright (`maxAliasCount: 0`)
   * on the reasoning that an intent file has no legitimate use for them; a
   * file with a dozen checks sharing a `select` block is a legitimate use, and
   * the billion-laughs defense never required a ban — only a bound.
   */
  it('resolves a plain alias', () => {
    const r = check(write(`version: 1
checks:
  - id: a
    description: Queues encrypt
    select: &sqs AWS::SQS::Queue
    on-empty: pass
    assert:
      SqsManagedSseEnabled: true
  - id: b
    description: Queues still encrypt
    select: *sqs
    on-empty: pass
    assert:
      SqsManagedSseEnabled: true
`));
    expect(r.outcomes.map((o) => o.check.id)).toEqual(['a', 'b']);
  });

  it('resolves a merge key, which is what anchors are wanted for here', () => {
    const r = check(write(`version: 1
checks:
  - &base
    id: a
    description: Queues encrypt
    select: AWS::SQS::Queue
    on-empty: pass
    assert:
      SqsManagedSseEnabled: true
  - <<: *base
    id: b
`));
    expect(r.outcomes.map((o) => o.check.id)).toEqual(['a', 'b']);
  });

  /** The bound is what stops the attack, and it must still stop it. */
  it('still refuses a billion-laughs expansion', () => {
    const rows = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    let prev = 'a';
    for (const next of ['b', 'c', 'd', 'e', 'f', 'g']) {
      const refs = Array(9).fill(`*${prev}`).join(',');
      rows.push(`${next}: &${next} [${refs}]`);
      prev = next;
    }
    expect(() => check(write(`${rows.join('\n')}\nversion: 1\nchecks: []\n`))).toThrow(
      VerifyInputError,
    );
  });

  it('rejects a tab where YAML forbids one, and says it is a YAML problem', () => {
    expect(message(() => check(write('version: 1\nchecks:\n\t- id: x\n')))).toContain(
      'not valid YAML',
    );
  });

  it('reads a file with a UTF-8 BOM', () => {
    expect(check(write('\u{FEFF}' + doc)).outcomes).toHaveLength(1);
  });

  it('reads a file with CRLF line endings', () => {
    expect(check(write(doc.replace(/\n/g, '\r\n'))).outcomes).toHaveLength(1);
  });

  /**
   * A duplicate key is REFUSED, not silently last-wins. Better than the YAML
   * spec's own rule for this use: a policy file where one `description`
   * quietly overwrites another is a file whose author believes something the
   * tool does not, which is the whole failure mode this product exists to
   * prevent. Pinned because it is parser behaviour we depend on rather than
   * chose.
   */
  it('refuses a duplicate key rather than silently taking the last', () => {
    const m = message(() => check(write(`version: 1
checks:
  - id: x
    description: First
    description: Second
    select: AWS::SQS::Queue
    on-empty: pass
    assert:
      SqsManagedSseEnabled: true
`)));
    expect(m).toContain('not valid YAML');
    expect(m).toContain('Map keys must be unique');
  });
});

describe('output discipline', () => {
  const report = () => buildReport(check(OK()), { intentPath: 'i.yml', toolVersion: '0' });

  /** There is no colour anywhere, so NO_COLOR and a non-TTY are satisfied by
   *  construction rather than by a branch — branches are what rot. */
  it('emits no ANSI escape sequences in any format', () => {
    const ansi = new RegExp('\x1b');
    for (const format of ['text', 'github', 'json'] as const) {
      expect(ansi.test(render(report(), format))).toBe(false);
    }
  });

  it('--quiet drops the passing lines but keeps failures and the summary', () => {
    const r = report();
    const full = render(r, 'text');
    const quiet = render(r, 'text', { intentPath: 'i.yml', stale: [], expired: [], quiet: true });
    expect(full).toContain('FAIL');
    expect(quiet).toContain('FAIL');
    expect(quiet).toContain('checks passed against');
    expect(quiet.length).toBeLessThan(full.length);
  });
});

describe('exit codes', () => {
  const silent = () => {};

  it('1 when a check fails', () => {
    expect(run(['verify', '--intent', OK(), '--template', join(dir, 'cdk.out')], silent, silent)).toBe(1);
  });

  /** New in 0.4.0. Conflating "your stack is wrong" with "I could not read
   *  your file" is what makes a gating tool untrustworthy. */
  it('2 when the input cannot be read', () => {
    expect(run(['verify', '--template', join(dir, 'nope'), '--intent', OK()], silent, silent)).toBe(2);
  });

  it('2 for an unknown flag, an unknown command and an unknown format', () => {
    expect(run(['verify', '--nope'], silent, silent)).toBe(2);
    expect(run(['frobnicate'], silent, silent)).toBe(2);
    expect(run(['verify', '--format', 'xml'], silent, silent)).toBe(2);
  });

  it('0 for --help, and the help shows the quickstart and the exit codes', () => {
    let text = '';
    expect(run(['--help'], (s: string) => { text += s; }, silent)).toBe(0);
    expect(text).toContain('npx cloudsynth init');
    expect(text).toContain('2  the input could not be read');
    expect(text.split('\n').length).toBeLessThanOrEqual(40);
  });
});

describe('runtime coverage', () => {
  /** `engines` warns at install; this refuses at run time, which is where
   *  somebody on an old runtime actually finds out. */
  it('refuses an old Node with a sentence, not a stack trace', () => {
    expect(nodeVersionProblem('18.20.4')).toContain('needs Node 20 or newer');
    expect(nodeVersionProblem('18.20.4')).toContain('this is Node 18.20.4');
  });

  it('accepts every Node the matrix covers', () => {
    for (const v of ['20.11.0', '22.15.0', '24.0.0']) {
      expect(nodeVersionProblem(v), v).toBeUndefined();
    }
  });

  it('does not refuse on an unparseable version rather than guessing', () => {
    expect(nodeVersionProblem('not-a-version')).toBeUndefined();
  });

  /** A report keyed on `cdk.out\\AppStack` on Windows and `cdk.out/AppStack`
   *  elsewhere would make every snapshot and every aggregate
   *  platform-dependent. Template names are basenames, so they are not. */
  it('names templates without any path separator', () => {
    const r = check(OK());
    for (const t of r.templatesChecked) {
      expect(t).not.toContain('/');
      expect(t).not.toContain('\\');
    }
  });
});
