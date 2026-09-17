#!/usr/bin/env node
/**
 * The `create-airo` binary: `npm create airo@beta my-app`.
 *
 * Everything real is in `run.ts`. This file only adapts `process` to the `Io`
 * object `run()` takes, which is what keeps the command testable.
 */

import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { run } from './run.js';

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    // Ctrl+C or a closed stdin rejects the pending question.
    throw new Error('Cancelled.');
  } finally {
    rl.close();
  }
}

// `exitCode`, not `exit()`: exiting immediately can truncate output that is
// still being written to a pipe.
process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  cwd: process.cwd(),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
  userAgent: process.env.npm_config_user_agent,
  ask,
});
