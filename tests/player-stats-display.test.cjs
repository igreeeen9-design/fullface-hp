const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.match(/function escapeHtml\(str\) \{[\s\S]*?\n\}/)[0], context);
vm.runInContext(source.slice(source.indexOf('function renderPlayerStatsTable('), source.indexOf('\nfunction renderHistory(')), context);

test('個人成績は安打・打率・出塁率・二塁打の順で見出しと値が対応し、率の表示を保持する', () => {
  for (const [avg, obp] of [['.333', '.429'], ['-', '-']]) {
    const player = { name: 'テスト', gp: 1, pa: 7, ab: 6, h: 2, avg, obp, b2: 1, b3: 0, hr: 0, rbi: 3, slg: '.500', ops: '.929' };
    const before = JSON.stringify(player);
    const html = context.renderPlayerStatsTable([player]);
    const headers = [...html.matchAll(/<th>(.*?)<\/th>/g)].map(m => m[1]);
    const values = [...html.matchAll(/<td>(.*?)<\/td>/g)].map(m => m[1]);
    assert.deepEqual(headers, ['選手名', '試合', '打席', '打数', '安打', '打率', '出塁率', '二塁打', '三塁打', '本塁打', '打点', '長打率', 'OPS']);
    assert.deepEqual(values, ['テスト', '1', '7', '6', '2', avg, obp, '1', '0', '0', '3', '.500', '.929']);
    assert.equal(JSON.stringify(player), before);
  }
});

test('表示時のみPA・AB・Hの降順に並べ替え、全項目同数なら登録順を保つ', () => {
  const players = [
    { name: 'PA少', pa: 9, ab: 9, h: 9 },
    { name: 'H少', pa: 10, ab: 8, h: 1 },
    { name: '同数先', pa: '10', ab: '8', h: '3' },
    { name: 'AB少', pa: 10, ab: 7, h: 7 },
    { name: 'PA最多', pa: 11, ab: 1, h: 0 },
    { name: '同数後', pa: 10, ab: 8, h: 3 },
  ];
  const before = JSON.stringify(players);
  players.forEach(Object.freeze);
  Object.freeze(players);
  const html = context.renderPlayerStatsTable(players);
  const names = [...html.matchAll(/<tr>\s*<td>(.*?)<\/td>/g)].map(m => m[1]);
  assert.deepEqual(names, ['PA最多', '同数先', '同数後', 'H少', 'AB少', 'PA少']);
  assert.equal(JSON.stringify(players), before);
});
