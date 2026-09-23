const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8'));
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const publicScript = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const fixtureAttendance = { members: [{ name: '井口', number: '1' }, { name: '助っ人', number: '' }], updatedAt: '2026-09-23T10:00:00Z' };

function setup(attendance = fixtureAttendance) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', disabled: false, dataset: {}, style: {}, events: {},
      addEventListener(event, callback) { this.events[event] = callback; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  };
  const ctx = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [] },
    localStorage: { getItem: () => '' }, TextEncoder, TextDecoder,
    atob: text => Buffer.from(text, 'base64').toString('binary'),
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    confirm: () => true,
    fetch: () => { throw new Error('Unexpected network'); },
  });
  const run = code => vm.runInContext(code, ctx);
  run(admin.slice(0, admin.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')));
  const original = read('next-game.json');
  if (attendance) original.current.attendance = clone(attendance);
  ctx.initialData = clone(original);
  run("states.nextGame = { data: initialData, sha: 'original-sha' }; renderLineup = () => {}; renderBench = () => {};");
  const writes = [];
  ctx.ghGet = async file => ({ sha: 'read-sha', content: Buffer.from(JSON.stringify(file.endsWith('next-game.json') ? original : file.endsWith('players.json') ? read('players.json') : { games: [{ date: '2099-01-01', opponent: '次の相手', time: '9:00' }] })).toString('base64') });
  ctx.ghPut = async (file, data, sha, message) => { writes.push({ file, data: clone(data), sha, message }); return { content: { sha: 'new-sha' } }; };
  return { ctx, run, node, original, writes, state: () => run('states.nextGame'), select: name => {
    ctx.selectedName = name; run('attendanceOptions.find(p => p.name === selectedName).selected = true;');
  } };
}
function publicRender(current) {
  const ctx = vm.createContext({});
  vm.runInContext(publicScript.slice(publicScript.indexOf('function escapeHtml('), publicScript.indexOf('// トップページ(ヒーローエリア)')), ctx);
  const el = {};
  ctx.renderNextGame(el, { current });
  return el.innerHTML;
}

test('名簿の未選択者は保存対象外、既存参加者と名簿外参加者は保持し重複を除く', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  assert.equal(env.run('attendanceOptions.length'), 22);
  assert.deepEqual(clone(env.run('collectAttendanceMembers()')), fixtureAttendance.members);
  assert.equal(env.node('attendanceCount').textContent, '選択中：2人');
  assert.equal(env.node('attendancePublished').textContent, '公開中の参加予定：2人');
  const result = env.run('buildAttendanceOptions([{name:"井口",number:"1"},{name:"井口",number:"1"}], initialData.current.attendance)');
  assert.equal(result.length, 2);
});

test('参加予定保存はcurrent.attendanceだけ更新、編集中の基本情報・スタメン・下書き・コメントは保存しない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  env.node('opponentInput').value = '未公開の対戦相手';
  env.node('noteInput').value = '未公開コメント';
  env.ctx.collectNextGameForm = () => { throw new Error('フォームを収集してはいけない'); };
  env.select('古賀'); await env.run('saveAttendance()');
  assert.equal(env.writes.length, 1);
  const saved = env.writes[0]; assert.equal(saved.file, 'data/next-game.json'); assert.equal(saved.sha, 'original-sha');
  assert.equal(saved.data.current.attendance.members.length, 3);
  assert.deepEqual(Object.keys(saved.data.current.attendance).sort(), ['members', 'updatedAt']);
  assert.ok(!Number.isNaN(Date.parse(saved.data.current.attendance.updatedAt)));
  for (const member of saved.data.current.attendance.members) assert.deepEqual(Object.keys(member).sort(), ['name', 'number']);
  const without = clone(saved.data); without.current.attendance = clone(env.original.current.attendance);
  assert.deepEqual(without, env.original);
  assert.equal(env.node('attendancePublished').textContent, '公開中の参加予定：3人');
  await env.run('saveAttendance()'); assert.equal(env.writes[1].sha, 'new-sha');
  assert.deepEqual(env.writes[1].data.current.attendance.members, saved.data.current.attendance.members);
});

test('チェック変更で人数更新、助っ人追加・再追加・未選択での除外', async () => {
  const env = setup(null); await env.run('loadAttendanceEditor()');
  env.node('attendanceOptions').events.change({target:{dataset:{attendanceIndex:'0'},checked:true}});
  assert.equal(env.node('attendanceCount').textContent, '選択中：1人');
  env.node('attendanceGuestName').value = ' 助っ人A '; env.node('attendanceGuestNumber').value = ' 99 ';
  env.node('addAttendanceGuestBtn').events.click();
  assert.equal(env.node('attendanceCount').textContent, '選択中：2人');
  env.node('attendanceGuestName').value = '助っ人A'; env.node('attendanceGuestNumber').value = '99';
  env.node('addAttendanceGuestBtn').events.click();
  assert.equal(env.run('collectAttendanceMembers().length'), 2);
  env.node('attendanceOptions').events.change({target:{dataset:{attendanceIndex:'0'},checked:false}});
  await env.run('saveAttendance()');
  assert.deepEqual(env.writes[0].data.current.attendance.members, [{name:'助っ人A',number:'99'}]);
});

test('全員を外して保存すると設定済み0人、未設定とは区別する', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  env.run('attendanceOptions.forEach(p => p.selected = false)'); await env.run('saveAttendance()');
  assert.deepEqual(env.writes[0].data.current.attendance.members, []);
  assert.match(publicRender(env.writes[0].data.current), /参加予定：0人/);
  assert.doesNotMatch(publicRender(read('next-game.json').current), /参加予定：/);
});

test('スタメン公開・日付と相手の変更でも保存済み参加予定を保持、未保存のチェックは公開しない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()'); env.select('古賀');
  env.node('opponentInput').value = '訂正した相手'; env.node('dateInput').value = '2026-10-01';
  await env.run('saveCurrent()');
  assert.equal(env.writes[0].data.current.opponent, '訂正した相手');
  assert.equal(env.writes[0].data.current.date, '2026-10-01');
  assert.deepEqual(env.writes[0].data.current.attendance, fixtureAttendance);
  assert.equal(env.run('collectAttendanceMembers().length'), 3);
});

test('下書き・いつものオーダーには参加予定を保存せず、読み込み時も参加選択を上書きしない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()'); env.select('古賀');
  await env.run('saveDraft()');
  assert.ok(!('attendance' in env.writes[0].data.drafts.at(-1)));
  assert.deepEqual(env.writes[0].data.current.attendance, fixtureAttendance);
  await env.run('saveDefaultOrder()');
  assert.ok(!('attendance' in env.writes[1].data.defaultOrder));
  env.run('loadDefaultOrder()');
  env.node('draftListArea').events.click({target:{closest:()=>({dataset:{act:'loadDraft',index:'0'}})}});
  assert.equal(env.run('collectAttendanceMembers().length'), 3);
  assert.deepEqual(clone(env.state().data.current.attendance), fixtureAttendance);
});

test('試合終了時だけ参加予定を初期化しhistoryには保存しない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  await env.run('archiveAndClear()');
  assert.equal(env.writes.length, 1);
  assert.ok(!('attendance' in env.writes[0].data.current));
  assert.ok(!('attendance' in env.writes[0].data.history.at(-1)));
  assert.equal(env.writes[0].data.current.opponent, '次の相手');
  assert.equal(env.run('collectAttendanceMembers().length'), 0);
  assert.equal(env.node('attendancePublished').textContent, '参加予定は未設定です。');
});

test('SHA競合時はエラーと入力を保持、公開状態・SHAを進めない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()'); env.select('古賀');
  env.ctx.ghPut = async (file, data, sha) => { assert.equal(sha,'original-sha'); throw new Error('保存に失敗しました (HTTP 409)'); };
  await env.run('saveAttendance()');
  assert.match(env.node('statusMsg').textContent, /409/);
  assert.equal(env.state().sha, 'original-sha');
  assert.deepEqual(clone(env.state().data), env.original);
  assert.equal(env.run('collectAttendanceMembers().length'), 3);
});

test('名簿取得失敗と次戦未設定では参加予定の誤保存を防ぐ', async () => {
  const env = setup(); env.ctx.ghGet = async () => { throw new Error('network error'); };
  await env.run('loadAttendanceEditor()'); await env.run('saveAttendance()');
  assert.equal(env.node('saveAttendanceBtn').disabled, true); assert.equal(env.writes.length, 0);
  assert.match(env.node('attendanceEditorStatus').textContent,/読み込めません/);
  const blank = setup(null); blank.run('states.nextGame.data.current = {}');
  await blank.run('loadAttendanceEditor()'); await blank.run('saveAttendance()');
  assert.equal(blank.node('saveAttendanceBtn').disabled,true); assert.equal(blank.writes.length,0);
});

test('旧データにattendanceがなくても通常公開・下書き・試合終了が動く', async () => {
  const env = setup(null); await env.run('loadNextGame()');
  assert.equal(env.run('collectAttendanceMembers().length'),0);
  await env.run('saveCurrent()'); await env.run('saveDraft()'); await env.run('archiveAndClear()');
  assert.equal(env.writes.length,3);
  for (const write of env.writes) assert.ok(!('attendance' in write.data.current));
});

test('公開欄は基本情報の下・スタメン前、スタメン未発表/発表後とも名前と背番号を表示', () => {
  const current = read('next-game.json').current; current.attendance = fixtureAttendance;
  const html = publicRender(current);
  assert.match(html,/参加予定：2人/); assert.match(html,/井口［1］/); assert.match(html,/助っ人/);
  assert.ok(html.indexOf('</dl>') < html.indexOf('参加予定：2人'));
  assert.ok(html.indexOf('参加予定：2人') < html.indexOf('スタメン（予定）'));
  assert.match(html,/スタメン未発表/);
  current.lineup = [{order:1,name:'井口',number:'1',position:'捕'}];
  assert.match(publicRender(current),/参加予定：2人/);
  assert.doesNotMatch(publicRender(current),/スタメン未発表/);
  current.attendance.members = [{name:'<img src=x onerror=alert(1)>',number:'<1>'}];
  assert.match(publicRender(current), /&lt;img/); assert.doesNotMatch(publicRender(current), /<img src=x/);
});
