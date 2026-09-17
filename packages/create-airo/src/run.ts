/**
 * The command, as a function: `run(argv, io)` resolves to an exit code.
 *
 *   0  scaffolded (or `--help` / `--version` / `--dry-run`)
 *   1  could not scaffold — target not empty, a write failed, no templates
 *   2  invoked wrongly — unknown flag, unknown template, nothing to prompt with
 *
 * ## Why this writes by default
 *
 * The rest of this repo's tooling is dry-run by default (`scripts/publish.sh`,
 * `scripts/rename-scope.sh`), because those commands change a tree the user
 * did not ask them to touch. `create` is the opposite: the user typed a verb
 * that means "make me a thing", in a place that does not exist yet. So this
 * writes by default and keeps the safety property those scripts protect
 * instead: it lists every file first, marking each one that already exists,
 * and it refuses a directory that is not empty unless `--force` is passed.
 * `--dry-run` is there for a preview, and previews a non-empty directory too.
 * Please don't "fix" this back to dry-run-by-default.
 */

import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type CliArgs, parseCliArgs, UsageError, usage } from './args.js';
import { VERSION } from './index.js';
import { deriveNames, nameVars } from './names.js';
import {
  DEFAULT_TEMPLATES_ROOT,
  isEmptyTarget,
  planScaffold,
  renderScaffold,
  writeScaffold,
} from './scaffold.js';
import { DEFAULT_TEMPLATE, TEMPLATES, type TemplateInfo } from './templates.js';
import { type Io, packageManager, runScript, style } from './ui.js';
import { targetLine, versionVars } from './versions.js';

export interface RunOptions {
  /** Override the shipped template list. Tests only. */
  templates?: readonly TemplateInfo[];
  /** Override where template directories are read from. Tests only. */
  templatesRoot?: string;
}

const FALLBACK_NAME = 'airo-app';

export async function run(argv: readonly string[], io: Io, opts: RunOptions = {}): Promise<number> {
  const templates = opts.templates ?? TEMPLATES;
  const templatesRoot = opts.templatesRoot ?? DEFAULT_TEMPLATES_ROOT;

  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) return usageFailure(io, err, templates);
    throw err;
  }

  if (args.help) {
    io.stdout(usage(templates));
    return 0;
  }
  if (args.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  io.stdout(banner(io));

  try {
    if (templates.length === 0) {
      io.stderr(`${style(io, 'red', 'error')} This build of create-airo ships no templates.\n`);
      return 1;
    }

    const name = await chooseName(args, io);
    const template = await chooseTemplate(args, templates, io);
    const names = deriveNames(name, io.cwd);
    const rel = relative(io.cwd, names.targetDir) || '.';

    const files = planScaffold(join(templatesRoot, template.name));
    // Marked in the list itself, so `--force` says exactly what it replaces
    // rather than only that the directory was not empty.
    const overwrites = files.filter((file) => existsSync(join(names.targetDir, file.path)));
    const replaced = new Set(overwrites);
    io.stdout(`\nScaffolding ${style(io, 'bold', template.name)} into ${style(io, 'cyan', rel)}\n`);
    for (const file of files) {
      const mark = replaced.has(file) ? `  ${style(io, 'yellow', '(overwrites)')}` : '';
      io.stdout(`  ${style(io, 'dim', file.path)}${mark}\n`);
    }

    const notEmpty = !isEmptyTarget(names.targetDir);
    // A dry run writes nothing, so it previews a non-empty target instead of
    // refusing it: that preview is how you decide whether --force is safe.
    if (notEmpty && !args.force && !args.dryRun) {
      io.stderr(
        `\n${style(io, 'red', 'error')} ${rel} is not empty` +
          (overwrites.length ? `, and ${plural(overwrites.length, 'file')} above would be replaced. ` : '. ') +
          'Choose another name, empty it, or pass --force to write into it anyway.\n',
      );
      return 1;
    }
    if (notEmpty && overwrites.length) {
      io.stdout(
        `\n${style(io, 'yellow', `${plural(overwrites.length, 'existing file')} will be replaced`)}` +
          `${args.dryRun && !args.force ? ' (a real run also needs --force)' : ''}.\n`,
      );
    }

    // Render everything before writing anything: an unknown placeholder
    // throws here, while the target is still untouched.
    const rendered = renderScaffold(files, {
      ...nameVars(names),
      ...versionVars({ exact: args.exact }),
      CREATE_AIRO_VERSION: VERSION,
      TEMPLATE: template.name,
      TARGET_LINE: targetLine(),
    });

    if (args.dryRun) {
      io.stdout(`\n${style(io, 'yellow', 'Dry run')} — nothing was written.\n`);
      return 0;
    }

    writeScaffold(rendered, names.targetDir);
    io.stdout(nextSteps(io, rel, template));
    return 0;
  } catch (err) {
    if (err instanceof UsageError) return usageFailure(io, err, templates);
    io.stderr(`${style(io, 'red', 'error')} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function usageFailure(io: Io, err: UsageError, templates: readonly TemplateInfo[]): number {
  io.stderr(`${style(io, 'red', 'error')} ${err.message}\n\n${usage(templates)}`);
  return 2;
}

function banner(io: Io): string {
  const head = style(io, 'bold', `create-airo ${VERSION}`);
  if (!VERSION.includes('-')) return `${head}\n`;
  return (
    `${head} ${style(io, 'yellow', '(beta)')}\n` +
    style(
      io,
      'dim',
      `Scaffolds against @airo-js ${targetLine()}. The API freezes at 1.0, and this template will be regenerated then.`,
    ) +
    '\n'
  );
}

function canAsk(args: CliArgs, io: Io): io is Io & { ask: NonNullable<Io['ask']> } {
  return io.interactive && !args.yes && io.ask !== undefined;
}

async function chooseTemplate(args: CliArgs, templates: readonly TemplateInfo[], io: Io): Promise<TemplateInfo> {
  if (args.template !== undefined) {
    const found = templates.find((t) => t.name === args.template);
    if (!found) {
      throw new UsageError(
        `Unknown template "${args.template}". Available: ${templates.map((t) => t.name).join(', ')}.`,
      );
    }
    return found;
  }

  const [only] = templates;
  if (only && templates.length === 1) {
    io.stdout(`Template: ${style(io, 'bold', only.name)} (the only one in this build)\n`);
    return only;
  }

  if (canAsk(args, io)) {
    const menu = templates.map((t, i) => `  ${i + 1}) ${t.name.padEnd(10)} ${t.description}`).join('\n');
    const fallback = templates.findIndex((t) => t.name === DEFAULT_TEMPLATE);
    const defaultIndex = fallback === -1 ? 0 : fallback;
    for (;;) {
      const answer = (await io.ask(`Which template?\n${menu}\nNumber [${defaultIndex + 1}]: `)).trim();
      const index = answer === '' ? defaultIndex : Number(answer) - 1;
      const picked = Number.isInteger(index) ? templates[index] : undefined;
      if (picked) return picked;
      io.stderr(`Pick a number between 1 and ${templates.length}.\n`);
    }
  }

  if (args.yes) {
    const picked = templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? only;
    if (picked) return picked;
  }

  throw new UsageError('No --template given, and no terminal to ask. Pass --template <name>, or --yes.');
}

async function chooseName(args: CliArgs, io: Io): Promise<string> {
  if (args.name !== undefined) return args.name;
  if (canAsk(args, io)) {
    const answer = (await io.ask(`Project name [${FALLBACK_NAME}]: `)).trim();
    return answer || FALLBACK_NAME;
  }
  if (args.yes) return FALLBACK_NAME;
  throw new UsageError(
    'No project name given, and no terminal to ask. Pass one, e.g. `npm create airo@beta my-app`, or --yes.',
  );
}

function nextSteps(io: Io, rel: string, template: TemplateInfo): string {
  const pm = packageManager(io.userAgent);
  const steps: string[] = [];
  if (rel !== '.') steps.push(`cd ${/\s/.test(rel) ? JSON.stringify(rel) : rel}`);
  steps.push(`${pm} install`);
  for (const script of template.nextScripts) steps.push(runScript(pm, script));
  return `\n${style(io, 'green', 'Done.')} Next:\n${steps.map((s) => `  ${s}`).join('\n')}\n`;
}
