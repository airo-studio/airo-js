/**
 * Everything the command needs from its surroundings, as one object.
 *
 * `run()` receives this instead of touching `process` directly, which is what
 * makes it testable: a test passes captured streams, a temp `cwd` and a
 * scripted `ask`, and reads back an exit code instead of intercepting
 * `process.exit`.
 */

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  /** A human is present to answer prompts. */
  interactive: boolean;
  /** Emit ANSI colour. */
  color: boolean;
  /** `npm_config_user_agent`, used only to phrase the next-steps commands. */
  userAgent: string | undefined;
  /** Ask one question and resolve with the typed answer. */
  ask?(question: string): Promise<string>;
}

const STYLES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
} as const;

export type StyleName = keyof typeof STYLES;

/**
 * Eight lines instead of a colour dependency. This package is run by
 * strangers through npx with no lockfile; zero runtime dependencies is the
 * smallest supply-chain surface available.
 */
export function style(io: Pick<Io, 'color'>, name: StyleName, text: string): string {
  if (!io.color) return text;
  const [open, close] = STYLES[name];
  return `[${open}m${text}[${close}m`;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** `npm_config_user_agent` starts with `<pm>/<version>`. */
export function packageManager(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split('/')[0];
  return name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : 'npm';
}

export function runScript(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}
