const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
// 公開中のdata/*.jsonは管理画面から随時更新されるため、テストは固定データ(tests/fixtures)を使う
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const publicScript = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'game-attendance.js'), 'utf8');
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
    localStorage: { getItem: () => '' }, TextEncoder, TextDecoder, crypto,
    atob: text => Buffer.from(text, 'base64').toString('binary'), btoa: text => Buffer.from(text, 'binary').toString('base64'),
    confirm: () => true, fetch: () => { throw new Error('Unexpected network'); },
  });
  const run = code => vm.runInContext(code, ctx);
  run(shared);
  run(admin.slice(0, admin.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')));
  const original = read('next-game.json');
  const schedule = read('schedule.json');
  delete schedule.games[0].attendance;
  if (attendance) schedule.games[0].attendance = clone(attendance);
  schedule.games[1].date = '2099-01-01';
  ctx.initialData = clone(original); ctx.initialSchedule = clone(schedule);
  run("states.nextGame = { data: initialData, sha: 'next-sha' }; states.schedule = { data: initialSchedule, sha: 'original-sha' }; renderLineup = () => {}; renderBench = () => {}; renderSchedule = () => {};");
  node('attendanceGameSelect').value = '0';
  const writes = [];
  ctx.ghGet = async file => ({ sha: 'read-sha', content: Buffer.from(JSON.stringify(file.endsWith('next-game.json') ? original : file.endsWith('players.json') ? read('players.json') : file.endsWith('results.json') ? read('results.json') : schedule)).toString('base64') });
  ctx.ghPut = async (file, data, sha, message) => { writes.push({ file, data: clone(data), sha, message }); return { content: { sha: 'new-sha' } }; };
  return { ctx, run, node, original, schedule, writes, state: () => run('states.schedule'), select: name => {
    ctx.selectedName = name; run('attendanceOptions.find(p => p.name === selectedName).selected = true;');
  } };
}
function publicContext() {
  const ctx = vm.createContext({});
  vm.runInContext(shared, ctx);
  vm.runInContext(publicScript.slice(publicScript.indexOf('function escapeHtml('), publicScript.indexOf('// トップページ(ヒーローエリア)')), ctx);
  vm.runInContext(publicScript.slice(publicScript.indexOf('function renderSchedule('), publicScript.indexOf('function renderGameDetail(')), ctx);
  return ctx;
}
function publicRender(current, schedule) {
  const ctx = publicContext(); const el = {};
  ctx.renderNextGame(el, { current: { ...current, attendance: ctx.nextGameAttendance(schedule.games, current) } });
  return el.innerHTML;
}

test('名簿の複数選択・旧選手・助っ人・人数・重複除去を維持', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  assert.equal(env.run('attendanceOptions.length'), 22);
  assert.deepEqual(clone(env.run('collectAttendanceMembers()')), fixtureAttendance.members);
  assert.equal(env.node('attendanceCount').textContent, '選択中：2人');
  assert.equal(env.node('attendancePublished').textContent, '公開中の参加予定：2人');
  assert.equal(env.run('buildAttendanceOptions([{name:"井口",number:"1"},{name:"井口",number:"1"}], initialSchedule.games[0].attendance).length'), 2);
});

test('保存は対象試合のattendanceだけ: 他試合・次戦・未保存の日程フォームに触れない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  env.ctx.collectSchedule = () => { throw new Error('未保存フォームを収集しない'); };
  env.ctx.collectNextGameForm = () => { throw new Error('次戦を収集しない'); };
  env.select('古賀'); await env.run('saveAttendance()');
  assert.equal(env.writes.length, 1);
  const saved = env.writes[0]; assert.equal(saved.file, 'data/schedule.json'); assert.equal(saved.sha, 'original-sha');
  assert.equal(saved.data.games[0].attendance.members.length, 3);
  assert.deepEqual(Object.keys(saved.data.games[0].attendance).sort(), ['members', 'updatedAt']);
  assert.ok(!Number.isNaN(Date.parse(saved.data.games[0].attendance.updatedAt)));
  for (const member of saved.data.games[0].attendance.members) assert.deepEqual(Object.keys(member).sort(), ['name', 'number']);
  const without = clone(saved.data); without.games[0].attendance = fixtureAttendance;
  assert.deepEqual(without, env.schedule);
  assert.deepEqual(clone(env.run('states.nextGame.data')), env.original);
  await env.run('saveAttendance()'); assert.equal(env.writes[1].sha, 'new-sha');
  assert.deepEqual(env.writes[1].data.games[0].attendance.members, saved.data.games[0].attendance.members);
});

test('試合を切り替え別々に選択・保存し、既存参加者を消さない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  env.node('attendanceGameSelect').value = '1'; env.node('attendanceGameSelect').events.change();
  assert.equal(env.run('collectAttendanceMembers().length'), 0);
  env.select('古賀'); await env.run('saveAttendance()');
  assert.deepEqual(env.writes[0].data.games[0].attendance, fixtureAttendance);
  assert.equal(env.writes[0].data.games[1].attendance.members[0].name, '古賀');
  env.node('attendanceGameSelect').value = '0'; env.node('attendanceGameSelect').events.change();
  assert.equal(env.run('collectAttendanceMembers().length'), 2);
});

test('チェック変更・助っ人追加と再追加・未選択での除外', async () => {
  const env = setup(null); await env.run('loadAttendanceEditor()');
  env.node('attendanceOptions').events.change({target:{dataset:{attendanceIndex:'0'},checked:true}});
  assert.equal(env.node('attendanceCount').textContent, '選択中：1人');
  env.node('attendanceGuestName').value = ' 助っ人A '; env.node('attendanceGuestNumber').value = ' 99 ';
  env.node('addAttendanceGuestBtn').events.click();
  assert.equal(env.node('attendanceCount').textContent, '選択中：2人');
  env.node('attendanceGuestName').value = '助っ人A'; env.node('attendanceGuestNumber').value = '99'; env.node('addAttendanceGuestBtn').events.click();
  assert.equal(env.run('collectAttendanceMembers().length'), 2);
  env.node('attendanceOptions').events.change({target:{dataset:{attendanceIndex:'0'},checked:false}});
  await env.run('saveAttendance()');
  assert.deepEqual(env.writes[0].data.games[0].attendance.members, [{name:'助っ人A',number:'99'}]);
});

test('全員解除は0人、未設定とは区別し旧next-gameの人数に戻らない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  env.run('attendanceOptions.forEach(p => p.selected = false)'); await env.run('saveAttendance()');
  const current = {...env.original.current, attendance: fixtureAttendance};
  assert.match(publicRender(current, env.writes[0].data), /参加予定：0人/);
  assert.doesNotMatch(publicRender(env.original.current, setup(null).schedule), /参加予定：/);
});

test('日付・相手の手動修正とスタメン公開でIDを維持し、参加予定をコピーしない', async () => {
  const env = setup();
  env.node('opponentInput').value = '訂正した相手'; env.node('dateInput').value = '2026-10-01';
  await env.run('saveCurrent()');
  const current = env.writes[0].data.current;
  assert.equal(current.scheduleGameId, env.schedule.games[0].id);
  assert.equal(current.opponent, '訂正した相手');
  assert.ok(!('attendance' in current));
  assert.match(publicRender(current, env.schedule), /参加予定：2人/);
});

test('下書き・いつものオーダーに参加予定や紐付けを含めず、参加選択は維持', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()'); env.select('古賀');
  await env.run('saveDraft()'); await env.run('saveDefaultOrder()');
  for (const data of [env.writes[0].data.drafts.at(-1), env.writes[1].data.defaultOrder]) {
    assert.ok(!('attendance' in data)); assert.ok(!('scheduleGameId' in data));
  }
  env.run('loadDefaultOrder()');
  env.node('draftListArea').events.click({target:{closest:()=>({dataset:{act:'loadDraft',index:'0'}})}});
  assert.equal(env.run('collectAttendanceMembers().length'), 3);
});

test('試合終了は次の試合IDへ切替: 試合ごとの参加予定を消さずhistoryにも複製しない', async () => {
  const env = setup(); env.ctx.todayJstDateString = () => '2026-09-27'; await env.run('archiveAndClear()');
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].data.current.scheduleGameId, 'schedule-2');
  assert.ok(!('attendance' in env.writes[0].data.current));
  assert.ok(!('attendance' in env.writes[0].data.history.at(-1)));
  assert.deepEqual(clone(env.state().data), env.schedule);
});

test('SHA競合は入力と保存前状態を保持し、他端末の情報を上書きしない', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()'); env.select('古賀');
  env.ctx.ghPut = async (file, data, sha) => { assert.equal(sha,'original-sha'); throw new Error('HTTP 409'); };
  await env.run('saveAttendance()');
  assert.match(env.node('statusMsg').textContent, /409/);
  assert.equal(env.state().sha, 'original-sha'); assert.deepEqual(clone(env.state().data), env.schedule);
  assert.equal(env.run('collectAttendanceMembers().length'), 3);
});

test('名簿取得失敗・未選択・日付未定では保存できない', async () => {
  const env = setup(); env.ctx.ghGet = async () => { throw new Error('network error'); };
  await env.run('loadAttendanceEditor()'); await env.run('saveAttendance()');
  assert.equal(env.node('saveAttendanceBtn').disabled, true); assert.equal(env.writes.length, 0);
  const blank = setup(); blank.node('attendanceGameSelect').value = '';
  await blank.run('loadAttendanceEditor()'); await blank.run('saveAttendance()');
  assert.equal(blank.node('saveAttendanceBtn').disabled,true); assert.equal(blank.writes.length,0);
  blank.node('attendanceGameSelect').value = '2'; blank.run('resetAttendanceEditor()'); await blank.run('saveAttendance()');
  assert.equal(blank.writes.length, 0);
});

test('次戦欄は基本情報の下・スタメン前、名前と背番号をエスケープして表示', () => {
  const env = setup(); const current = env.original.current;
  const html = publicRender(current, env.schedule);
  assert.match(html,/参加予定：2人/); assert.match(html,/井口［1］/); assert.match(html,/助っ人/);
  assert.ok(html.indexOf('</dl>') < html.indexOf('参加予定：2人'));
  assert.ok(html.indexOf('参加予定：2人') < html.indexOf('スタメン（予定）'));
  current.lineup = [{order:1,name:'井口',number:'1',position:'捕'}];
  assert.match(publicRender(current, env.schedule),/参加予定：2人/);
  env.schedule.games[0].attendance.members = [{name:'<img src=x onerror=alert(1)>',number:'<1>'}];
  assert.doesNotMatch(publicRender(current, env.schedule), /<img src=x/);
});

test('旧JSON互換: 空白表記差を吸収、一意でない試合には紐付けず、ID優先', () => {
  const c = publicContext(); const current = {date:'2026-09-27',opponent:'六本松BLACK SOX',attendance:fixtureAttendance};
  const game = {date:current.date,opponent:'六本松 BLACK SOX'};
  assert.deepEqual(c.nextGameAttendance([game],current), fixtureAttendance);
  assert.equal(c.findAttendanceGame([game,{...game}],current),null);
  assert.equal(c.scheduleGameAttendance(game,[game,{...game}],current),null);
  assert.equal(c.nextGameAttendance([game],{...current,scheduleGameId:'deleted'}),null);
  assert.equal(c.nextGameAttendance([{...game,attendance:{members:[]}}],current).members.length,0);
});

test('公開日程: 確定試合だけ開閉、未設定/0人を区別、地図リンクを維持', () => {
  const c = publicContext(); const games = [
    {date:'2026-10-04',opponent:'<相手>',location:'球場',attendance:fixtureAttendance},
    {date:'2026-10-11',opponent:'B',attendance:{members:[]}},
    {date:'2026-10-18',opponent:'C'}, {date:null,opponent:'未定相手'}];
  const detail = {hidden:true}; const attrs={'aria-expanded':'false'};
  const button={dataset:{scheduleToggle:'0'},getAttribute:k=>attrs[k],setAttribute:(k,v)=>attrs[k]=v};
  const container={contains:node=>node===button,querySelector:()=>detail};
  c.renderSchedule(container,{games});
  assert.equal((container.innerHTML.match(/data-schedule-toggle=/g)||[]).length,3);
  assert.match(container.innerHTML,/参加予定 2人/); assert.match(container.innerHTML,/参加予定 0人/);
  assert.match(container.innerHTML,/参加予定 未設定/); assert.match(container.innerHTML,/maps/);
  assert.match(container.innerHTML,/&lt;相手&gt;/); assert.match(container.innerHTML,/colspan="4"/);
  container.onclick({target:{closest:()=>button}}); assert.equal(detail.hidden,false); assert.equal(attrs['aria-expanded'],'true');
  container.onclick({target:{closest:()=>button}}); assert.equal(detail.hidden,true); assert.equal(attrs['aria-expanded'],'false');
});

function scheduleRows(env) {
  const games=env.run('states.schedule.data.games');
  const rows=games.map(game=>({_originalGame:game, querySelector:selector=>({value:({'.sch-date':game.date,'.sch-opponent':game.opponent,'.sch-location':game.location,'.sch-time':game.time})[selector]||''})}));
  env.ctx.document.querySelectorAll=()=>rows;
  return rows;
}

test('参加予定保存後の日程保存: 未保存の日付修正と新しい参加予定を両方維持', async () => {
  const env=setup(); await env.run('loadAttendanceEditor()'); const rows=scheduleRows(env);
  const previousQuery=rows[0].querySelector;
  rows[0].querySelector=selector=>selector==='.sch-date'?{value:'2026-10-03'}:previousQuery(selector);
  env.select('古賀'); await env.run('saveAttendance()');
  assert.equal(env.writes[0].data.games[0].date,'2026-09-27');
  await env.run('saveSchedule()');
  assert.equal(env.writes[1].data.games[0].date,'2026-10-03');
  assert.equal(env.writes[1].data.games[0].attendance.members.length,3);
  assert.equal(env.writes[1].data.games[0].id,'schedule-1');
});

test('旧日程データの保存はIDを付与し、並べ替えても参加予定を同じ試合に保持', async () => {
  const env=setup(); env.run('delete states.schedule.data.games[1].id');
  const rows=scheduleRows(env); rows.reverse(); await env.run('saveSchedule()');
  const saved=env.writes[0].data.games;
  assert.deepEqual(saved.find(g=>g.id==='schedule-1').attendance,fixtureAttendance);
  assert.match(saved.find(g=>g.opponent==='3ColorRuns').id,/^schedule-/);
});

test('旧next-gameの参加者も日程編集で失わず、scheduleへの初回保存時に引き継ぐ', async () => {
  const env=setup(null);
  delete env.original.current.scheduleGameId;
  env.original.current.attendance=clone(fixtureAttendance);
  env.run('states.schedule.data.games.forEach(game => delete game.id)');
  await env.run('loadAttendanceEditor()');
  assert.equal(env.run('collectAttendanceMembers().length'),2);
  const rows=scheduleRows(env); const query=rows[0].querySelector;
  rows[0].querySelector=selector=>selector==='.sch-date'?{value:'2026-10-03'}:query(selector);
  await env.run('saveSchedule()');
  assert.deepEqual(env.writes[0].data.games[0].attendance,fixtureAttendance);
  assert.equal(env.writes[0].data.games[0].date,'2026-10-03');
});

test('IDのない旧データは公開・下書き可、終了は再読み込み案内で停止', async () => {
  const env=setup(null); delete env.original.current.scheduleGameId;
  await env.run('loadNextGame()'); await env.run('saveCurrent()'); await env.run('saveDraft()');
  env.ctx.todayJstDateString=()=> '2026-09-27'; await env.run('archiveAndClear()');
  assert.equal(env.writes.length,2);
  for (const write of env.writes) assert.ok(!('attendance' in write.data.current));
});

function switchingSetup(count = 2, sameOpponent = false) {
  const env = setup();
  env.schedule.games = Array.from({ length: count }, (_, index) => ({
    id: `double-${index + 1}`, date: '2026-09-27', time: `${9 + index * 2}:00`,
    opponent: sameOpponent ? '同一相手' : `相手${index + 1}`, location: '球場',
    attendance: { members: [{ name: `参加者${index + 1}`, number: String(index + 1) }], updatedAt: 'test' },
  }));
  env.schedule.games.push({ id: 'tomorrow', date: '2026-09-28', time: '9:00', opponent: '翌日の相手' });
  env.ctx.switchCurrent = { scheduleGameId: 'double-1', date: '2026-09-27', opponent: env.schedule.games[0].opponent, lineup: [], bench: [] };
  env.ctx.switchSchedule = env.schedule;
  env.run('states.nextGame.data = { current: switchCurrent, history: [], drafts: [] }; states.schedule.data = switchSchedule;');
  env.ctx.todayJstDateString = () => '2026-09-27';
  env.results = { groups: [] };
  env.remoteNext = env.run('states.nextGame.data');
  env.ctx.ghGet = async file => ({ sha: 'next-sha', content: Buffer.from(JSON.stringify(file.endsWith('next-game.json') ? env.remoteNext : file.endsWith('results.json') ? env.results : env.schedule)).toString('base64') });
  const put = env.ctx.ghPut;
  env.ctx.ghPut = async (...args) => { const result = await put(...args); if (args[0].endsWith('next-game.json')) env.remoteNext = clone(args[1]); return result; };
  return env;
}

for (const count of [2, 3]) test(`同日${count}試合はIDごとに順次切替、全終了後は翌日、参加者は次の試合だけ表示`, async () => {
  const env = switchingSetup(count);
  const originalSchedule = clone(env.schedule);
  for (let number = 1; number <= count; number++) {
    await env.run('archiveAndClear()');
    assert.equal(env.writes.length, number);
    const data = env.writes.at(-1).data;
    assert.equal(data.current.scheduleGameId, number < count ? `double-${number + 1}` : 'tomorrow');
    assert.equal(data.history.at(-1).scheduleGameId, `double-${number}`);
    assert.ok(!('attendance' in data.history.at(-1)));
    assert.ok(!('attendance' in data.current));
    const html = publicRender(data.current, env.schedule);
    assert.ok(!html.includes(`参加者${number}`));
    if (number < count) assert.ok(html.includes(`参加者${number + 1}`));
    assert.ok(env.writes.every(write => write.file === 'data/next-game.json'));
  }
  assert.deepEqual(env.schedule, originalSchedule);
  assert.deepEqual(env.results, { groups: [] });
});

test('同日同一相手でもIDで区別し、配列順によらず開始時刻順に次戦を選ぶ', async () => {
  const env = switchingSetup(3, true);
  env.schedule.games.reverse();
  await env.run('archiveAndClear()');
  assert.equal(env.writes[0].data.current.scheduleGameId, 'double-2');
  await env.run('archiveAndClear()');
  assert.equal(env.writes[1].data.current.scheduleGameId, 'double-3');
});

test('結果登録済みと過去の終了履歴のIDは次戦候補から除外', async () => {
  const env = switchingSetup(3);
  env.results.groups = [{ games: [{ gameId: 'double-2', date: '別日付でもID優先' }] }];
  env.run("states.nextGame.data.history = [{ scheduleGameId: 'double-3' }];");
  await env.run('archiveAndClear()');
  assert.equal(env.writes[0].data.current.scheduleGameId, 'tomorrow');
});

test('日付や相手名が一致する別IDの結果だけでは終了判定しない', async () => {
  const env = switchingSetup(2, true);
  env.results.groups = [{ games: [{ gameId: 'unrelated', date: '2026-09-27', opponent: '同一相手' }] }];
  await env.run('archiveAndClear()');
  assert.equal(env.writes[0].data.current.scheduleGameId, 'double-2');
});

test('1日1試合は翌日へ進み、全試合終了後は空欄にする', async () => {
  const env = switchingSetup(1);
  await env.run('archiveAndClear()');
  assert.equal(env.writes[0].data.current.scheduleGameId, 'tomorrow');
  await env.run('archiveAndClear()');
  assert.equal(env.writes[1].data.current.opponent, '');
  assert.ok(!env.writes[1].data.current.scheduleGameId);
});

for (const time of [null, '未定', '25:00', '13:00']) test(`同日順序が不明(${time})なら履歴保存も行わず停止`, async () => {
  const env = switchingSetup(3);
  env.schedule.games[1].time = time;
  const before = clone(env.run('states.nextGame.data'));
  await env.run('archiveAndClear()');
  assert.equal(env.writes.length, 0);
  assert.match(env.node('statusMsg').textContent, /開始時刻/);
  assert.deepEqual(clone(env.run('states.nextGame.data')), before);
});

test('過去日付だけでは終了扱いしない・日付未定は候補外', () => {
  const env = switchingSetup();
  const next = env.ctx.findNextScheduledGame({ games: [
    { id: 'undated', date: null }, { id: 'past', date: '2026-09-26' }, { id: 'today', date: '2026-09-27' },
  ] });
  assert.equal(next.id, 'past');
});

test('次戦IDなしで同日同一相手が複数なら推測せず停止', async () => {
  const env = switchingSetup(2, true);
  env.run('delete states.nextGame.data.current.scheduleGameId;');
  await env.run('archiveAndClear()');
  assert.equal(env.writes.length, 0);
  assert.match(env.node('statusMsg').textContent, /対象試合ID/);
});

test('結果取得失敗・次戦SHA競合では切替前の状態を維持', async () => {
  for (const failRead of [true, false]) {
    const env = switchingSetup();
    const before = clone(env.run('states.nextGame.data'));
    if (failRead) env.ctx.ghGet = async () => { throw new Error('read failure'); };
    else env.ctx.ghPut = async (file, data, sha) => { assert.equal(sha, 'next-sha'); throw new Error('409'); };
    await env.run('archiveAndClear()');
    assert.equal(env.writes.length, 0);
    assert.deepEqual(clone(env.run('states.nextGame.data')), before);
  }
});

test('次戦を雨天中止すると次の日程へ進み、中止状態とIDを同時保存する', async () => {
  const env = switchingSetup(1);
  await env.node('cancelGameBtn').events.click();
  assert.equal(env.writes.length, 1);
  const saved = env.writes[0];
  assert.equal(saved.file, 'data/next-game.json');
  assert.equal(saved.sha, 'next-sha');
  assert.equal(saved.data.current.scheduleGameId, 'tomorrow');
  assert.equal(saved.data.history.at(-1).scheduleGameId, 'double-1');
  assert.equal(saved.data.history.at(-1).status, 'cancelled');
  assert.equal(saved.data.history.at(-1).cancellationReason, '雨天中止');
  assert.ok(saved.data.history.at(-1).archivedAt);
});

test('同日第1試合の中止で第2試合へ進み、全試合中止後は翌日へ・参加者は引き継がない', async () => {
  const env = switchingSetup(2, true);
  const scheduleBefore = clone(env.schedule);
  await env.run("archiveAndClear('cancelled')");
  let current = env.writes.at(-1).data.current;
  assert.equal(current.scheduleGameId, 'double-2');
  assert.match(publicRender(current, env.schedule), /参加者2/);
  assert.doesNotMatch(publicRender(current, env.schedule), /参加者1/);
  assert.ok(!('attendance' in current));
  await env.run("archiveAndClear('cancelled')");
  current = env.writes.at(-1).data.current;
  assert.equal(current.scheduleGameId, 'tomorrow');
  assert.doesNotMatch(publicRender(current, env.schedule), /参加者[12]/);
  assert.deepEqual(env.writes.at(-1).data.history.map(game => game.status), ['cancelled', 'cancelled']);
  assert.deepEqual(env.schedule, scheduleBefore);
  assert.deepEqual(env.results, { groups: [] });
});

test('中止履歴は通常終了後にも除外され、同日中止試合へ戻らない', async () => {
  const env = switchingSetup(3);
  await env.run("archiveAndClear('cancelled')");
  await env.run('archiveAndClear()');
  assert.equal(env.writes.at(-1).data.current.scheduleGameId, 'double-3');
  assert.equal(env.writes.at(-1).data.history[0].status, 'cancelled');
  assert.ok(!env.writes.at(-1).data.history[1].status);
});

test('振替の新規日程は別ID、参加者・球場・時刻を元日程からコピーしない', () => {
  const env = switchingSetup();
  const rows = [{ _originalGame: {}, querySelector: selector => ({ value: {
    '.sch-date': '2026-10-11', '.sch-opponent': '相手1', '.sch-location': '', '.sch-time': '',
  }[selector] }) }];
  env.ctx.document.querySelectorAll = () => rows;
  const replacement = env.run('collectSchedule()')[0];
  assert.match(replacement.id, /^schedule-/);
  assert.ok(env.schedule.games.every(game => game.id !== replacement.id));
  assert.equal(replacement.location, null);
  assert.equal(replacement.time, null);
  assert.ok(!('attendance' in replacement));
});

test('中止保存のSHA競合・順序不明では中止も次戦切替も反映しない', async () => {
  for (const conflict of [true, false]) {
    const env = switchingSetup(3);
    const before = clone(env.run('states.nextGame.data'));
    if (conflict) env.ctx.ghPut = async () => { throw new Error('409'); };
    else env.schedule.games[1].time = null;
    await env.run("archiveAndClear('cancelled')");
    assert.equal(env.writes.length, 0);
    assert.deepEqual(clone(env.run('states.nextGame.data')), before);
    assert.equal(env.node('cancelGameBtn').disabled, false);
  }
});

test('試合ID不明・結果登録済みの試合は中止として記録しない', async () => {
  for (const completed of [true, false]) {
    const env = switchingSetup(2, true);
    if (completed) env.results.groups = [{ games: [{ gameId: 'double-1' }] }];
    else env.run('delete states.nextGame.data.current.scheduleGameId;');
    await env.run("archiveAndClear('cancelled')");
    assert.equal(env.writes.length, 0);
  }
});

for (const action of [undefined, 'cancelled']) test(`直前の${action ? '雨天中止' : '終了'}を1回だけ取り消し、現在と履歴を復元`, async () => {
  const env = switchingSetup(2);
  const before = clone(env.remoteNext);
  const dialogs = [];
  env.ctx.confirm = text => { dialogs.push(text); return true; };
  env.ctx.testAction = action;
  await env.run('archiveAndClear(testAction)');
  assert.match(dialogs[0], /2026-09-27 相手1/);
  assert.match(dialogs[0], /2026-09-27 相手2/);
  assert.ok(env.remoteNext.lastTransitionUndo);
  await env.run('undoLastTransition()');
  assert.deepEqual(env.remoteNext.current, before.current);
  assert.deepEqual(env.remoteNext.history, before.history);
  assert.equal(env.remoteNext.lastTransitionUndo, null);
  assert.match(dialogs[1], /現在の次戦.*相手2/);
  assert.match(dialogs[1], /復元する試合.*相手1/);
  await env.run('undoLastTransition()');
  assert.equal(env.writes.length, 2);
});

test('通常管理の画面IDと最新IDが不一致なら確認前に停止', async () => {
  const env = switchingSetup();
  env.remoteNext = clone(env.remoteNext);
  env.remoteNext.current.scheduleGameId = 'today-other';
  let confirmed = false; env.ctx.confirm = () => { confirmed = true; return true; };
  await env.run('archiveAndClear()');
  assert.equal(env.writes.length, 0);
  assert.equal(confirmed, false);
  assert.match(env.node('statusMsg').textContent, /再読み込み/);
});

for (const type of ['current', 'history']) test(`取り消し: ${type}が変わっていたら復元しない`, async () => {
  const env = switchingSetup();
  await env.run('archiveAndClear()');
  if (type === 'current') env.remoteNext.current.note = '後続編集';
  else env.remoteNext.history.pop();
  const before = clone(env.remoteNext);
  await env.run('undoLastTransition()');
  assert.equal(env.writes.length, 1);
  assert.deepEqual(env.remoteNext, before);
});

test('取り消しは最新の下書き・通常オーダー・無関係な項目を保持', async () => {
  const env = switchingSetup();
  await env.run('archiveAndClear()');
  env.remoteNext.drafts = [{ name: '後から追加' }];
  env.remoteNext.defaultOrder = { lineup: [{ name: '後から変更' }] };
  env.remoteNext.extra = '保持';
  await env.run('undoLastTransition()');
  assert.deepEqual(env.remoteNext.drafts, [{ name: '後から追加' }]);
  assert.equal(env.remoteNext.defaultOrder.lineup[0].name, '後から変更');
  assert.equal(env.remoteNext.extra, '保持');
});

test('取り消し保存のSHA競合は復元せず停止', async () => {
  const env = switchingSetup();
  await env.run('archiveAndClear()');
  const before = clone(env.remoteNext);
  env.ctx.ghPut = async () => { throw new Error('HTTP 409'); };
  await env.run('undoLastTransition()');
  assert.deepEqual(env.remoteNext, before);
  assert.equal(env.writes.length, 1);
});

test('取り消し応答消失でも反映を再確認し、2回目は履歴を再削除しない', async () => {
  const env = switchingSetup();
  await env.run('archiveAndClear()');
  const put = env.ctx.ghPut;
  env.ctx.ghPut = async (...args) => { await put(...args); throw new Error('response lost'); };
  await env.run('undoLastTransition()');
  assert.equal(env.remoteNext.current.scheduleGameId, 'double-1');
  assert.equal(env.remoteNext.lastTransitionUndo, null);
  await env.run('undoLastTransition()');
  assert.equal(env.writes.length, 2);
});

test('2回切替した後の取り消しは最後の1回だけ', async () => {
  const env = switchingSetup(3);
  await env.run('archiveAndClear()');
  await env.run('archiveAndClear()');
  await env.run('undoLastTransition()');
  assert.equal(env.remoteNext.current.scheduleGameId, 'double-2');
  assert.equal(env.remoteNext.history.length, 1);
  await env.run('undoLastTransition()');
  assert.equal(env.writes.length, 3);
});

test('取り消し応答も確認も失敗した後は、再試行時に確認を先行して二重保存しない', async () => {
  const env = switchingSetup();
  await env.run('archiveAndClear()');
  const put = env.ctx.ghPut, get = env.ctx.ghGet;
  let unavailable = false;
  env.ctx.ghPut = async (...args) => { await put(...args); unavailable = true; throw new Error('response lost'); };
  env.ctx.ghGet = async (...args) => { if (unavailable) throw new Error('offline'); return get(...args); };
  await env.run('undoLastTransition()');
  assert.match(env.node('statusMsg').textContent, /未確認/);
  unavailable = false;
  await env.run('undoLastTransition()');
  assert.equal(env.writes.length, 2);
  assert.equal(env.remoteNext.current.scheduleGameId, 'double-1');
});

test('次戦なしの確認は空になることを明示し、終了操作は閉じた詳細内にある', async () => {
  const env = switchingSetup(1);
  env.schedule.games = [env.schedule.games[0]];
  let message; env.ctx.confirm = text => { message = text; return false; };
  await env.run('archiveAndClear()');
  assert.match(message, /次戦情報は空になります/);
  assert.equal(env.writes.length, 0);
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  assert.match(html, /<details class="transition-actions"><summary>試合を終了・中止する<\/summary>[\s\S]*?id="archiveBtn"[\s\S]*?id="cancelGameBtn"[\s\S]*?<\/details>/);
});

test('参加予定の任意打順・守備を保存し旧データと助っ人も保持、次戦は変更しない', async () => {
  const env = setup();
  await env.run('loadAttendanceEditor()');
  env.run("attendanceOptions.find(p => p.name === '井口').order = '2'; attendanceOptions.find(p => p.name === '井口').position = '捕';");
  await env.run('saveAttendance()');
  const member = env.writes[0].data.games[0].attendance.members.find(p => p.name === '井口');
  assert.equal(member.order, 2); assert.equal(member.position, '捕');
  const guest = env.writes[0].data.games[0].attendance.members.find(p => p.name === '助っ人');
  assert.ok(!('order' in guest)); assert.ok(!('position' in guest));
  assert.ok(env.writes.every(write => write.file === 'data/schedule.json'));
});

test('参加予定を再読込しても名簿との統合で打順・守備を失わない', () => {
  const env = setup();
  const options = env.ctx.buildAttendanceOptions([{ name: '井口', number: '1' }], { members: [{ name: '井口', number: '1', order: 3, position: '遊' }] });
  assert.equal(options[0].order, 3); assert.equal(options[0].position, '遊');
});

test('参加予定から作る案は打順順・未定は空欄、コピー後は双方独立', () => {
  const env = setup();
  const attendance = { members: [{ name: '未定', number: '1' }, { name: '後', order: 5, position: '左' }, { name: '先', order: 2, position: '遊' }] };
  const lineup = env.ctx.lineupFromAttendance(attendance);
  assert.deepEqual(clone(lineup).map(p => p.name), ['先', '後', '未定']);
  assert.equal(lineup[2].order, ''); assert.equal(lineup[2].position, '');
  lineup[0].position = '二';
  assert.equal(attendance.members[2].position, '遊');
  attendance.members[1].name = '変更';
  assert.equal(lineup[1].name, '後');
});

test('スタメン案作成は対象を確認してフォームだけ変更、参加予定や次戦JSONを自動保存しない', async () => {
  const env = setup();
  await env.run('loadAttendanceEditor()');
  env.ctx.document.querySelector = () => ({ click() {} });
  env.run('copiedLineup = null; renderLineup = players => { copiedLineup = players; };');
  let confirmation;
  env.ctx.confirm = text => { confirmation = text; return true; };
  const before = clone(env.original);
  await env.run('copyAttendanceLineup()');
  assert.match(confirmation, /2026-09-27/); assert.match(confirmation, /上書き/);
  assert.equal(env.run('copiedLineup.length'), 2);
  assert.equal(env.writes.length, 0);
  assert.deepEqual(env.original, before);
});

test('別試合・同日同一相手でもID不一致ならスタメン案を上書きしない', async () => {
  const env = setup();
  env.original.current.scheduleGameId = 'different';
  let rendered = false; env.ctx.renderLineup = () => { rendered = true; };
  await env.run('copyAttendanceLineup()');
  assert.equal(rendered, false); assert.equal(env.writes.length, 0);
  assert.match(env.node('statusMsg').textContent, /一致しません/);
});

test('案の作成をキャンセルした場合と参加予定未保存の場合は変更しない', async () => {
  for (const absent of [false, true]) {
    const env = setup();
    if (absent) delete env.schedule.games[0].attendance;
    env.ctx.confirm = () => false;
    let rendered = false; env.ctx.renderLineup = () => { rendered = true; };
    await env.run('copyAttendanceLineup()');
    assert.equal(rendered, false); assert.equal(env.writes.length, 0);
  }
});

test('フォーム収集はコピーした空欄・指定打順を保持し通常行は従来どおり連番', () => {
  const env = setup();
  const row = order => ({ ...(order !== undefined ? { _plannedOrder: order } : {}), querySelector: selector => ({ value: selector === '.name-input' ? '選手' : '' }) });
  env.ctx.document.querySelectorAll = selector => selector.includes('lineupRows') ? [row(5), row(''), row(undefined)] : [];
  assert.deepEqual(clone(env.run('collectNextGameForm().lineup')).map(p => p.order), [5, '', 3]);
});

test('参加予定の不正な打順は保存前に停止する', async () => {
  const env = setup(); await env.run('loadAttendanceEditor()');
  env.run("attendanceOptions.find(p => p.selected).order = '-1';");
  await env.run('saveAttendance()');
  assert.equal(env.writes.length, 0); assert.match(env.node('statusMsg').textContent, /整数か空欄/);
});
