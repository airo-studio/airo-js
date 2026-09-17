/**
 * HTTP checks against a running server:
 *
 *   npm run build && npm start      # in one terminal
 *   npm run smoke                   # in another
 *
 * `BASE_URL` points it elsewhere (default http://localhost:3000).
 *
 * These check what the site promises, not how it is built: real status
 * codes, every page rendered on the server, one canonical url each, and
 * every surface — HTML, sitemap, llms.txt, agent tools — agreeing about
 * which pages exist.
 */

const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, '');

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) passed++;
  else failures.push(detail ? `${name} — ${detail}` : name);
}

async function get(path) {
  const res = await fetch(BASE + path, { redirect: 'manual' });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}

async function call(body) {
  const res = await fetch(`${BASE}/mcp/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ── status codes ──────────────────────────────────────────────────────────
for (const [path, want] of [
  ['/', 200],
  ['/post/hello', 200],
  ['/post/server-first', 200],
  ['/post/unfinished', 404], // no `updatedAt`, so the crawler adapter blocks it
  ['/post/nope', 404],
  ['/does-not-exist', 404], // the renderer reports `fellBack.reason: 'unknown-page'`
]) {
  const { status } = await get(path);
  check(`${path} → ${want}`, status === want, `got ${status}`);
}

// ── server rendering, per page ────────────────────────────────────────────
const index = await get('/');
check('index is server-rendered', index.body.includes('class="site-title"'));
check('index links a published post', index.body.includes('href="/post/hello"'));
check('index does not link the unpublished post', !index.body.includes('/post/unfinished'));
check('index carries its canonical', index.body.includes('rel="canonical" href="https://example.com"'));
check('index mounts in hydrate mode', index.body.includes('data-airo-mode="hydrate"'));

const post = await get('/post/hello');
check('post is server-rendered', post.body.includes('<h1 class="site-title">Hello</h1>'));
check('post has its own canonical', post.body.includes('rel="canonical" href="https://example.com/post/hello"'));
check('post carries JSON-LD', post.body.includes('"@type":"BlogPosting"'));
check('post has anchor ids from the transformer', post.body.includes('id="where-to-start"'));

const missing = await get('/does-not-exist');
check('the 404 page loads no client bundle', !missing.body.includes('/client.js'));

// ── the client bundle ─────────────────────────────────────────────────────
const bundle = await get('/client.js');
check('/client.js is served', bundle.status === 200, `got ${bundle.status}`);
check('/client.js is JavaScript', /javascript/.test(bundle.type), bundle.type);
check('/client.js is bundled, not raw tsc output', !/from\s*["']@airo-js\//.test(bundle.body));

// ── search-engine surfaces ────────────────────────────────────────────────
const sitemap = await get('/sitemap.xml');
check('sitemap lists the index', sitemap.body.includes('<loc>https://example.com</loc>'));
check('sitemap lists a post', sitemap.body.includes('<loc>https://example.com/post/hello</loc>'));
check('sitemap leaves the unpublished post out', !sitemap.body.includes('unfinished'));

const llms = await get('/llms.txt');
check('llms.txt opens with the site heading', llms.body.startsWith('# '), llms.body.slice(0, 40));
check('llms.txt lists a post', llms.body.includes('(https://example.com/post/hello)'));
check('llms.txt agrees with the sitemap about the unpublished post', !llms.body.includes('unfinished'));

const robots = await get('/robots.txt');
check('robots.txt points at the sitemap', robots.body.includes('Sitemap: https://example.com/sitemap.xml'));

// ── agent surfaces ────────────────────────────────────────────────────────
const tools = JSON.parse((await get('/mcp/tools')).body);
const toolNames = tools.tools.map((t) => t.name);
check('the manifest lists both tools', toolNames.includes('list_posts') && toolNames.includes('get_section'), toolNames.join(','));
check('the manifest carries input schemas', tools.tools.every((t) => t.inputSchema));

const listed = await call({ name: 'list_posts' });
check('list_posts answers', listed.status === 200 && listed.json.ok, JSON.stringify(listed.json));
check('list_posts agrees with the sitemap', listed.json.result?.posts?.length === 2, JSON.stringify(listed.json.result));

// The agent's answer and the rendered page come from the same snapshot.
const section = await call({ name: 'get_section', arguments: { id: 'where-to-start' }, slug: 'hello' });
check('get_section answers', section.status === 200 && section.json.ok, JSON.stringify(section.json));
check('get_section matches the rendered page', post.body.includes(section.json.result?.html ?? '∅'));

const noPost = await call({ name: 'get_section', arguments: { id: 'x' } });
check('get_section without a post is refused', noPost.status === 400, `got ${noPost.status}`);
check('…and says what was missing', noPost.json.error?.code === 'missing-required-fields', JSON.stringify(noPost.json));

const unknown = await call({ name: 'no_such_tool' });
check('an unknown tool is a 400, not a 500', unknown.status === 400 && unknown.json.error?.code === 'unknown-tool');

const nameless = await call({});
check('a call without a tool name is a 400', nameless.status === 400);

// ── result ────────────────────────────────────────────────────────────────
console.log(`\n${passed}/${passed + failures.length} smoke checks passed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
