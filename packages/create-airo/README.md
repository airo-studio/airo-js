# `create-airo`

Scaffold an [airo-js](https://github.com/airo-studio/airo-js) project.

```bash
npm create airo@beta my-app
```

> **Beta.** `create-airo` 1.0.0-beta scaffolds against the current `@airo-js`
> line (0.11). The framework's API freezes at 1.0, and the templates will be
> regenerated against it then. A project you scaffold now stays on 0.11 —
> its caret ranges stop at the next minor — so nothing breaks when 1.0 ships;
> you migrate when you choose to, using the notes in the
> [changelog](https://github.com/airo-studio/airo-js/blob/main/CHANGELOG.md).
> Every generated `package.json` records which build created it under
> `"airo".scaffoldedWith`.

## Why use it

airo-js has a small surface and a handful of decisions that are easy to get
wrong and fail quietly: a page type that doesn't match its view renders a
blank page, a schema nothing ever calls validates nothing, an adapter
declared with the wrong format never runs. The starters make those decisions
for you, correctly, and say why in comments where you will be editing.

## Usage

```bash
npm  create airo@beta my-app -- --template site
pnpm create airo@beta my-app --template site
yarn create airo@beta my-app --template site
bun  create airo@beta my-app --template site
```

npm needs the `--` before options; the others do not. With no arguments the
command asks for a name and, if there is more than one, a template.

| Option | |
|---|---|
| `-t, --template <name>` | Which starter to use |
| `-y, --yes` | Accept defaults and never prompt (`airo-app`, `site`) |
| `--dry-run` | List the files that would be written, marking any it would replace; write nothing |
| `--force` | Write into a directory that is not empty, replacing the files marked `(overwrites)` |
| `--exact` | Pin `@airo-js` packages to exact versions instead of `^` ranges |
| `-h, --help` | Show help |
| `-v, --version` | Show the version |

It never installs dependencies for you. It prints the commands to run next,
phrased for the package manager you used.

## Templates

| Template | What you get |
|---|---|
| `site` | A server-rendered, multi-page site that hydrates in the browser, with search-engine and agent surfaces served from the same data. Needs Node 22.12+ |

More starters follow in later betas. The command only offers templates that
are in the build you are running.

## Writes by default — deliberately

This command creates files without asking first. Tools that change an
existing tree should preview by default; a command whose whole job is "make
me a new project" should not. What it does instead:

- lists every file before writing, marking each one that already exists
  with `(overwrites)`,
- refuses a directory that is not empty unless you pass `--force`, and says
  how many files a forced run would replace,
- renders every file before writing any, so a problem stops it with nothing
  on disk.

`--dry-run` is there if you want the preview, and previews a directory that
is not empty as well.

## License

Apache-2.0
