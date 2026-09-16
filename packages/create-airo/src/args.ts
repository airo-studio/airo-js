/**
 * The command line: `create-airo [project-name] [options]`.
 *
 * `node:util` `parseArgs` rather than a flags library — it is stable from
 * Node 20, which is this package's floor, and it keeps runtime dependencies
 * at zero.
 */

import { parseArgs } from 'node:util';

import type { TemplateInfo } from './templates.js';

/** A problem with how the command was invoked. Exits 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export interface CliArgs {
  name: string | undefined;
  template: string | undefined;
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
}

const OPTIONS = {
  template: { type: 'string', short: 't' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    throw new UsageError(`Expected one project name, got ${positionals.length}: ${positionals.join(' ')}`);
  }
  const name = positionals[0]?.trim();
  return {
    name: name === '' ? undefined : name,
    template: values.template,
    yes: values.yes === true,
    dryRun: values['dry-run'] === true,
    force: values.force === true,
    help: values.help === true,
    version: values.version === true,
  };
}

export function usage(templates: readonly TemplateInfo[]): string {
  const width = Math.max(0, ...templates.map((t) => t.name.length));
  const list = templates.length
    ? templates.map((t) => `  ${t.name.padEnd(width)}  ${t.description}`).join('\n')
    : '  (none in this build)';
  return `Usage:
  npm create airo@beta [project-name] -- [options]
  pnpm create airo@beta [project-name] [options]

npm needs the \`--\` before options; pnpm, yarn and bun do not.

Options:
  -t, --template <name>  Which starter to use
  -y, --yes              Accept defaults and never prompt
      --dry-run          List the files that would be written; write nothing
      --force            Write into a directory that is not empty
  -h, --help             Show this help
  -v, --version          Show the version

Templates:
${list}
`;
}
