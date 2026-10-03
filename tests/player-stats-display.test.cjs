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
