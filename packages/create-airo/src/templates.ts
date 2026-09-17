/**
 * The templates this build ships.
 *
 * Metadata lives here rather than in a file inside each template directory,
 * because everything inside a template directory is copied to the user.
 * `test/templates.test.ts` asserts this list and the directories under
 * `templates/` agree in both directions.
 *
 * The CLI accepts only what is listed here. It never advertises a template
 * that has not been built.
 */

export interface TemplateInfo {
  /** Directory name under `templates/`, and the `--template` value. */
  name: string;
  /** One line for the prompt and `--help`. */
  description: string;
  /** Script names, in order, printed as the "Next steps". */
  nextScripts: readonly string[];
}

export const TEMPLATES: readonly TemplateInfo[] = [
  {
    name: 'site',
    description: 'A server-rendered site that hydrates, with search-engine and AI-agent surfaces',
    nextScripts: ['dev'],
  },
];

/** Used by `--yes` when no `--template` is given. */
export const DEFAULT_TEMPLATE = 'site';
