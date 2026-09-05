/**
 * The version this build reports as `tool.version`.
 *
 * Injected by esbuild at bundle time (`--define`) rather than read from
 * package.json at runtime: the published package is a single file that a
 * GitHub Action runs straight out of `github.action_path`, and resolving a
 * sibling manifest from inside a bundle is exactly the kind of thing that
 * works locally and fails there.
 *
 * `typeof` guards the tsc build, where the identifier is never declared — the
 * dist/ used by this package's own tests, which is why the fallback is a
 * visible placeholder and not a plausible-looking version number.
 */
declare const __CLOUDSYNTH_VERSION__: string | undefined;

export const TOOL_VERSION: string =
  typeof __CLOUDSYNTH_VERSION__ === 'string' ? __CLOUDSYNTH_VERSION__ : '0.0.0-dev';
