#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyIntent, VerifyInputError } from './verify.js';
import { buildReport, render, defaultFormat, type ReportFormat } from './report.js';
import { init, summarise } from './init.js';
import { INTENT_FILE_NAME } from './contract/intent.js';

/**
 * `cloudsynth verify`
 *
 * Reads cloudsynth.intent.yml and checks a synthesized CloudFormation template
 * against it. Exit 0 if every error-severity check holds, 1 otherwise — the
 * contract a CI step needs and the only thing a pipeline actually reads.
 *
 * Hand-rolled argument parsing rather than a dependency: this is one command
 * with four flags, and a CLI a customer runs in their own pipeline should have
 * as close to no transitive dependencies as it can manage.
 */

/**
 * Exit codes, which are the only part of this tool a pipeline actually reads.
 *
 * `2` for usage and input errors is new in 0.4.0 and is a real behaviour
 * change: 0.3.0 and earlier returned 1 for everything that was not a pass, so
 * a script doing `if verify; then` is unaffected, but one branching on `$? ==
 * 1` to mean "a check failed" would now miss an input error. That is the point
 * — conflating "your stack is wrong" with "I could not read your file" is
 * exactly what makes a gating tool untrustworthy, and the changelog says so.
 */
export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_INPUT_ERROR = 2;

const USAGE = `cloudsynth — check a synthesized CDK stack against cloudsynth.intent.yml

Quickstart:
  npx cdk synth --all        you already do this
  npx cloudsynth init        write an intent file from what your stack does
  npx cloudsynth verify      check it, and fail the build if it drifts

Usage:
  cloudsynth init [options]
  cloudsynth verify [options]

Options:
  --intent <path>     Intent file        (default: ./cloudsynth.intent.yml)
  --template <path>   cdk.out dir, or one *.template.json  (default: ./cdk.out)
  --format <fmt>      text | github | json
                      (default: github on a GitHub runner, else text)
  --quiet             Failures and the summary only
  --out <path>        init only: where to write
  --all               init only: write currently-failing checks active
  --force             init only: overwrite an existing file
  -h, --help          Show this

Exit codes:
  0  every error-severity check passed
  1  at least one check failed
  2  the input could not be read (bad path, invalid file, unknown flag)

Nothing is uploaded. Synthesis happens in your pipeline and the templates are
read from disk; your infrastructure code never leaves the runner.`;

interface Args {
  command?: string;
  intent: string;
  template: string;
  format?: ReportFormat;
  quiet: boolean;
  out?: string;
  all: boolean;
  force: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    intent: INTENT_FILE_NAME,
    template: 'cdk.out',
    all: false,
    force: false,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--out') args.out = argv[++i] ?? args.out;
    else if (arg === '--intent') args.intent = argv[++i] ?? args.intent;
    else if (arg === '--template') args.template = argv[++i] ?? args.template;
    else if (arg === '--format') args.format = argv[++i] as ReportFormat;
    else if (!arg.startsWith('-') && !args.command) args.command = arg;
    else throw new VerifyInputError(`Unknown argument: ${arg}`);
  }
  return args;
}

/** The oldest Node this is tested on. `engines` warns at install; this refuses
 *  at run time, which is where somebody on an old runtime actually finds out. */
export const MINIMUM_NODE_MAJOR = 20;

/**
 * A sentence, not a stack trace.
 *
 * Someone on Node 18 running this in a pipeline gets a syntax error from a
 * language feature they have never heard of, in a bundled file, with no
 * indication that the version is the problem. The check costs nothing and is
 * the difference between a five-minute fix and an abandoned tool.
 */
export function nodeVersionProblem(version = process.versions.node): string | undefined {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isNaN(major) || major >= MINIMUM_NODE_MAJOR) return undefined;
  return (
    `cloudsynth needs Node ${MINIMUM_NODE_MAJOR} or newer — this is Node ${version}. ` +
    'Upgrade Node, or pin an older cloudsynth if you cannot.'
  );
}

export function run(argv: string[], out = console.log, err = console.error): number {
  const tooOld = nodeVersionProblem();
  if (tooOld) {
    err(tooOld);
    return EXIT_INPUT_ERROR;
  }

  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    err(USAGE);
    return EXIT_INPUT_ERROR;
  }

  if (args.help || !args.command) {
    out(USAGE);
    return args.help ? EXIT_OK : EXIT_INPUT_ERROR;
  }

  if (args.command === 'init') {
    try {
      const result = init({
        outPath: args.out ?? args.intent,
        templatePath: args.template,
        all: args.all,
        force: args.force,
      });
      out(`${result.path}: ${summarise(result, args.all)}`);
      if (result.active.length === 0 && result.commented.length === 0) {
        out(
          `No resources matched any catalog rule in ${args.template}. ` +
            'Run `cdk synth --all` first if you have not.',
        );
      }
      out('Next:  npx cloudsynth verify');
      return 0;
    } catch (e) {
      if (e instanceof VerifyInputError) {
        err(`cloudsynth init: ${e.message}`);
        return EXIT_INPUT_ERROR;
      }
      throw e;
    }
  }

  if (args.command !== 'verify') {
    err(`Unknown command: ${args.command}. Expected \`init\` or \`verify\`.`);
    err(USAGE);
    return EXIT_INPUT_ERROR;
  }

  const format = args.format ?? defaultFormat();
  if (!['text', 'github', 'json'].includes(format)) {
    err(`Unknown format: ${format}. Expected text, github or json.`);
    return EXIT_INPUT_ERROR;
  }

  try {
    const result = verifyIntent({ intentPath: args.intent, templatePath: args.template });
    out(
      render(buildReport(result, { intentPath: args.intent }), format, {
        intentPath: args.intent,
        stale: result.staleExemptions,
        expired: result.expiredExemptions,
        unusedOverrides: result.unusedOverrides,
        quiet: args.quiet,
      }),
    );
    return result.passed ? EXIT_OK : EXIT_CHECK_FAILED;
  } catch (e) {
    // A bad path or an unparseable intent file is OUR error to state plainly,
    // not a stack trace: the reader is looking at a failed pipeline and needs
    // to know whether their stack is wrong or their setup is.
    if (e instanceof VerifyInputError) {
      err(`cloudsynth verify: ${e.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw e;
  }
}

// Run only when executed as a binary, never when imported by a test. Compared
// as resolved real paths — matching on the URL suffix breaks the moment the
// binary is invoked through a symlink, which is exactly how npm bins work.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exit(run(process.argv.slice(2)));
}
