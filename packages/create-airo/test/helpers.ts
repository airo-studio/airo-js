import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Io } from '../src/ui.js';

export interface FakeIo extends Io {
  out: string;
  err: string;
  questions: string[];
}

/**
 * A captured `Io`. `answers` are handed to `ask` in order; asking past the
 * end fails the test instead of hanging it.
 */
export function fakeIo(cwd: string, overrides: Partial<Io> & { answers?: string[] } = {}): FakeIo {
  const { answers = [], ...rest } = overrides;
  const io: FakeIo = {
    out: '',
    err: '',
    questions: [],
    stdout(text) {
      io.out += text;
    },
    stderr(text) {
      io.err += text;
    },
    cwd,
    interactive: false,
    color: false,
    userAgent: undefined,
    async ask(question) {
      io.questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      return answer;
    },
    ...rest,
  };
  return io;
}

/** A temp directory, removed by the returned cleanup. */
export function tempDir(prefix = 'create-airo-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a tree of files: `{ 'a/b.txt': 'content' }`. */
export function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    const dest = join(root, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}
