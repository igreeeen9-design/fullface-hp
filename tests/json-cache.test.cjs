const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
function setup(ok = true) {
  const calls = [], data = { current: { opponent: '相手' }, games: [] };
  const context = vm.createContext({ Date: { now: () => 1792300000000 }, fetch: async (url, options) => {
    calls.push({ url, cache: options.cache });
    return { ok, json: async () => data };
  }});
  vm.runInContext('let jsonRequestSequence = 0;\n' + source.match(/async function loadJson\([\s\S]*?\n\}/)[0], context);
  return { context, calls, data };
}
test('同じ時刻の再取得も別URLになり、通常取得はURLと返却JSONを維持', async () => {
  const { context:c, calls, data } = setup();
  await c.loadJson('data/next-game.json', { cacheBust:true });
  await c.loadJson('data/next-game.json', { cacheBust:true });
  assert.notEqual(calls[0].url, calls[1].url);
  for (const name of ['results','stats','players','notice']) {
    const url = `data/${name}.json`;
    assert.equal(await c.loadJson(url), data);
    assert.equal(calls.at(-1).url, url);
    assert.equal(calls.at(-1).cache, 'no-store');
  }
  await c.loadJson('data/schedule.json?v=old', { cacheBust:true });
  assert.match(calls.at(-1).url, /\?v=old&t=/);
});
test('取得エラーは従来同様に呼び出し側へ通知', async () => {
  const { context:c } = setup(false);
  await assert.rejects(c.loadJson('data/next-game.json', {cacheBust:true}), /failed to load data\/next-game.json/);
});
