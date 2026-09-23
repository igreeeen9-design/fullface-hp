const assert = require('node:assert/strict');

// Git objects are immutable; only PATCH changes the simulated public branch/files.
module.exports = function installCsvGitHub(context, files, writes = []) {
  const mock = { head: 'base', calls: [], failBlob: 0, failPath: '', loseResponse: false,
    failChecks: false, race: false, descendant: false, publications: 0 };
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const baseFiles = new Map(files);
  let index = 0;
  context.fetch = async (url, options = {}) => {
    const route = url.split('/fullface-hp/')[1];
    const body = options.body && JSON.parse(options.body);
    mock.calls.push({ route, method: options.method, body });
    const ok = (data) => ({ ok: true, json: async () => data });
    const missing = () => ({ ok: false, status: 404, text: async () => 'Not found' });
    if (route === mock.failPath) throw new Error('simulated failure');
    if (route.startsWith('git/ref/heads/')) {
      if (mock.failChecks && mock.publications) throw new Error('verification unavailable');
      return ok({ object: { sha: mock.head } });
    }
    if (route.startsWith('contents/')) {
      const [name, query] = route.slice(9).split('?');
      assert.equal(query, `ref=${mock.head}`);
      const source = mock.head === 'base' ? baseFiles : files;
      if (!source.has(name)) return missing();
      return ok({ sha: name + ':sha', content: Buffer.from(JSON.stringify(source.get(name))).toString('base64') });
    }
    if (route.startsWith('git/commits/')) return ok({ tree: { sha: 'base-tree' } });
    if (route === 'git/blobs') {
      const count = mock.calls.filter((c) => c.route === route).length;
      if (count === mock.failBlob) throw new Error('blob failure');
      assert.equal(body.encoding, 'base64');
      const sha = `blob-${++index}`;
      blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
      return ok({ sha });
    }
    if (route === 'git/trees') {
      assert.equal(body.base_tree, 'base-tree');
      assert.equal(body.tree.length, 3);
      assert.ok(body.tree.every((entry) => blobs.has(entry.sha)));
      const sha = `tree-${++index}`; trees.set(sha, body.tree);
      return ok({ sha });
    }
    if (route === 'git/commits') {
      assert.deepEqual(body.parents, ['base']);
      const sha = `commit-${++index}`; commits.set(sha, body);
      return ok({ sha });
    }
    if (route.startsWith('git/refs/heads/')) {
      assert.equal(body.force, false);
      if (mock.race) mock.head = 'other';
      if (mock.head !== commits.get(body.sha).parents[0]) {
        return { ok: false, status: 422, text: async () => 'Not fast forward' };
      }
      for (const entry of trees.get(commits.get(body.sha).tree)) {
        const content = blobs.get(entry.sha);
        const data = entry.path.endsWith('.json') ? JSON.parse(content) : content;
        files.set(entry.path, data);
        writes.push({ name: entry.path, data: JSON.parse(JSON.stringify(data)) });
      }
      mock.head = body.sha;
      mock.publications++;
      if (mock.descendant) mock.head = 'descendant';
      if (mock.loseResponse) throw new Error('response lost');
      return ok({ object: { sha: mock.head } });
    }
    if (route.startsWith('compare/')) return ok({ status: mock.head === 'descendant' ? 'ahead' : 'diverged' });
    throw new Error(`Unexpected request: ${route}`);
  };
  return mock;
};
