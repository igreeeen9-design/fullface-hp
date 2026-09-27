const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

function loadAdmin() {
  const element = () => ({ value: '', style: {}, addEventListener() {}, querySelectorAll: () => [] });
  const context = vm.createContext({ document: { getElementById: element, querySelectorAll: () => [] },
    localStorage: { getItem: () => '' }, TextEncoder, TextDecoder });
  vm.runInContext(script.slice(0, script.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')), context);
  return context;
}

// 率はupdateBattingRatesで打数・安打などから計算させる(手書きの率と計数の食い違いを防ぐ)
function player(c, name, fields) {
  const rec = { name, gp: 1, pa: 0, ab: 0, h: 0, b2: 0, b3: 0, hr: 0, rbi: 0, sb: 0, ...fields };
  c.updateBattingRates(rec);
  return rec;
}

function category(seasonRanking, label) {
  return JSON.parse(JSON.stringify(seasonRanking.categories.find((cat) => cat.label === label).entries));
}

function sampleRanking(c) {
  return {
    players: [
      player(c, 'A', { pa: 30, ab: 25, h: 9, b2: 2, b3: 1, rbi: 9 }), // .360 / .467 / .520 / .987
      player(c, 'B', { pa: 20, ab: 18, h: 5, hr: 1, rbi: 3 }),        // .278 / .350 / .444 / .794
      player(c, 'C', { pa: 10, ab: 10, h: 2, rbi: 2 }),               // .200 / .200 / .200 / .400
      player(c, 'D', { pa: 12, ab: 12, rbi: 1 }),                     // .000(0以下は除外)
      player(c, 'E', { pa: 2, ab: 2, h: 2, rbi: 1 }),                 // 1.000だが3打席未満
    ],
    categories: [{ label: '勝利数', entries: [{ name: 'A', value: '2' }] }],
  };
}

test('率系ランキング: .360など1未満の値でも対象になり、0以下と3打席未満は除外', () => {
  const c = loadAdmin();
  const ranking = sampleRanking(c);
  c.recomputeSeasonCategories(ranking);
  assert.deepEqual(category(ranking, '打率'), [
    { name: 'A', value: '.360' }, { name: 'B', value: '.278' }, { name: 'C', value: '.200' }]);
  assert.deepEqual(category(ranking, '出塁率'), [
    { name: 'A', value: '.467' }, { name: 'B', value: '.350' }, { name: 'C', value: '.200' }]);
  assert.deepEqual(category(ranking, '長打率'), [
    { name: 'A', value: '.520' }, { name: 'B', value: '.444' }, { name: 'C', value: '.200' }]);
});

test('OPS: 1未満の選手も対象になり、1以上の選手と並べて順位付けされる', () => {
  const c = loadAdmin();
  const ranking = sampleRanking(c);
  ranking.players.push(player(c, 'F', { pa: 5, ab: 4, h: 2, hr: 1 })); // .500 / .600 / 1.250 / 1.850
  c.recomputeSeasonCategories(ranking);
  assert.deepEqual(category(ranking, 'OPS'), [
    { name: 'F', value: '1.850' }, { name: 'A', value: '.987' }, { name: 'B', value: '.794' }, { name: 'C', value: '.400' }]);
});

test('minValue指定: 打点ランキングは2打点以上の下限を維持し、未指定の項目は1以上を対象にする', () => {
  const c = loadAdmin();
  const ranking = sampleRanking(c);
  c.recomputeSeasonCategories(ranking);
  assert.deepEqual(category(ranking, '打点'), [
    { name: 'A', value: '9' }, { name: 'B', value: '3' }, { name: 'C', value: '2' }]);
  assert.deepEqual(category(ranking, '本塁打'), [{ name: 'B', value: '1' }]);
  assert.deepEqual(category(ranking, '勝利数'), [{ name: 'A', value: '2' }]);
});

test('mergeTiesIntoTopRows: 未指定なら0以下で打ち切り、指定時はその下限で打ち切る', () => {
  const c = loadAdmin();
  const sorted = [{ name: 'A', v: 0.36 }, { name: 'B', v: 0.25 }, { name: 'C', v: 0.25 }, { name: 'D', v: 0 }];
  const rows = (min) => JSON.parse(JSON.stringify(c.mergeTiesIntoTopRows(sorted, (p) => p.v, String, min)));
  assert.deepEqual(rows(), [{ name: 'A', value: '0.36' }, { name: 'B・C', value: '0.25' }]);
  assert.deepEqual(rows(0.3), [{ name: 'A', value: '0.36' }]);
  assert.deepEqual(rows(1), []);
});

test('公開集計: 当年度の実参加者は打席なしでもGP1、旧年度と旧形式の数値は維持', () => {
  const publicScript = fs.readFileSync(path.join(root,'script.js'),'utf8');
  const ctx = vm.createContext({boxscoreSourceOf: game => game.boxscore});
  vm.runInContext("const NON_ROSTER_GUEST_PLAYERS = ['中山','大内'];" + publicScript.slice(publicScript.indexOf('function aggregateBoxscoreSeason('),publicScript.indexOf('function renderSeasonTotalsTable(')), ctx);
  const headers = ['選手名','打数','安打','単打','二塁打','三塁打','本塁打','打点','得点','三振','四球','死球','打席'];
  const game = {boxscore:{headers,rows:[['打者',3,1,1,0,0,0,0,0,0,0,0,3],['欠席',0,0,0,0,0,0,0,0,0,0,0,0]]}};
  const original = JSON.stringify(game);
  const old = ctx.aggregateBoxscoreSeason({era:'current',games:[game]}).rows;
  game.actualParticipants = {names:['打者','監督','監督']};
  const current = ctx.aggregateBoxscoreSeason({era:'current',games:[game]}).rows;
  assert.deepEqual({...current.find(p=>p.name==='打者')}, {...old.find(p=>p.name==='打者')});
  assert.equal(current.find(p=>p.name==='監督').GP,1);
  assert.equal(current.find(p=>p.name==='監督').AB,0);
  assert.equal(current.find(p=>p.name==='欠席').GP,0);
  const archived = ctx.aggregateBoxscoreSeason({era:'past',games:[game]}).rows;
  assert.equal(JSON.stringify(archived),JSON.stringify(old));
  delete game.actualParticipants;
  assert.equal(JSON.stringify(game),original);
});
