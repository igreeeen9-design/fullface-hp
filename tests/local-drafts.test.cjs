const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname,'../admin.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const clone = x => JSON.parse(JSON.stringify(x));
function setup() {
  const nodes = new Map(), storage = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id,{value:'',style:{},events:{},addEventListener(e,f){this.events[e]=f;},querySelectorAll:()=>[]}); return nodes.get(id); };
  const c=vm.createContext({document:{getElementById:node,querySelectorAll:()=>[]},crypto,TextEncoder,TextDecoder,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),confirm:()=>true});
  vm.runInContext(source.slice(0,source.lastIndexOf('refreshTokenUI();\nrefreshGcTokenUI();')),c);
  const original={current:{scheduleGameId:'game1',note:'keep'},history:[{scheduleGameId:'old'}],lastTransitionUndo:{id:'undo'},extra:{keep:true},drafts:Array.from({length:7},(_,i)=>({name:`案${i+1}`,savedAt:'2026-10-01T00:00:00Z',lineup:[{name:'選手',number:'1',order:i+1,position:'遊',comment:'保持'}],bench:[],note:'秘密'}))};
  const env={c,node,storage,remote:clone(original),original,sha:'a',puts:0,gets:0,exports:[],race:false,lost:false};
  c.fetch=async (url,options={})=>{
    if(options.method!=='PUT'){env.gets++;return {ok:true,json:async()=>({sha:env.sha,content:Buffer.from(JSON.stringify(env.remote)).toString('base64')})};}
    const body=JSON.parse(options.body);env.puts++;
    if(env.race){env.remote.drafts.push({name:'追加案',lineup:[]});env.sha='other';}
    if(body.sha!==env.sha)return {ok:false,status:409,text:async()=> 'conflict'};
    env.remote=JSON.parse(Buffer.from(body.content,'base64').toString());env.sha='saved';
    if(env.lost)throw new Error('response lost');
    return {ok:true,json:async()=>({content:{sha:env.sha}})};
  };
  c.showStatus=(type,text)=>{env.status={type,text};};
  c.fillNextGameForm=d=>{env.form=clone(d);};
  env.download=r=>env.exports.push(c.draftBackupText(r));
  return env;
}
test('下書き保存・読込・削除・同名追加は端末だけで完結',async()=>{
  const e=setup(),{c}=e;
  e.node('draftNameInput').value='同名';await c.saveDraft();
  e.node('draftNameInput').value='同名';await c.saveDraft();
  assert.equal(c.readLocalDrafts().length,2);assert.equal(e.gets,0);assert.equal(e.puts,0);
  const id=c.readLocalDrafts()[0].id;
  e.node('draftListArea').events.click({target:{closest:()=>({dataset:{act:'loadDraft',id}})}});
  assert.equal(e.form.name,'同名');
  await c.deleteDraft(id);assert.equal(c.readLocalDrafts().length,1);assert.equal(e.puts,0);
});
test('案7を含む7件の全内容を保護して移行、再実行で増えずcurrent等は保持',async()=>{
  const e=setup();await e.c.migratePublicDrafts(e.download,()=>true);
  assert.deepEqual(clone(e.c.readLocalDrafts()).map(r=>r.content),e.original.drafts);
  assert.equal(e.exports.length,1);assert.equal(e.puts,1);
  const expected=clone(e.original);delete expected.drafts;assert.deepEqual(e.remote,expected);
  await e.c.migratePublicDrafts(e.download,()=>true);assert.equal(e.c.readLocalDrafts().length,7);assert.equal(e.puts,1);
  assert.deepEqual(clone(await e.c.legacyDraftRecords(e.original)).map(r=>r.id),clone(e.c.readLocalDrafts()).map(r=>r.id));
});
test('確認を取り消すと端末コピーとバックアップのみ、公開JSONは保持',async()=>{
  const e=setup();await e.c.migratePublicDrafts(e.download,()=>false);
  assert.equal(e.c.readLocalDrafts().length,7);assert.equal(e.puts,0);assert.deepEqual(e.remote,e.original);
  await e.c.migratePublicDrafts(e.download,()=>false);assert.equal(e.c.readLocalDrafts().length,7);
});
for(const failure of ['write','verify','read'])test(`端末${failure}失敗なら公開下書きを削除しない`,async()=>{
  const e=setup();
  if(failure==='write')e.c.localStorage.setItem=()=>{throw new Error('quota');};
  if(failure==='verify')e.c.localStorage.setItem=()=>{};
  if(failure==='read')e.c.localStorage.getItem=()=>{throw new Error('denied');};
  await e.c.migratePublicDrafts(e.download,()=>true);
  assert.equal(e.puts,0);assert.deepEqual(e.remote,e.original);assert.equal(e.status.type,'err');
});
test('SHA競合時は削除せず、最新の追加案も端末へ保護して再試行可能',async()=>{
  const e=setup();e.race=true;await e.c.migratePublicDrafts(e.download,()=>true);
  assert.equal(e.remote.drafts.length,8);assert.equal(e.c.readLocalDrafts().length,8);assert.equal(e.status.type,'err');
  e.race=false;await e.c.migratePublicDrafts(e.download,()=>true);
  assert.ok(!('drafts'in e.remote));assert.equal(e.c.readLocalDrafts().length,8);
});
test('削除成功後の応答消失は最新JSONを確認して完了とする',async()=>{
  const e=setup();e.lost=true;await e.c.migratePublicDrafts(e.download,()=>true);
  assert.equal(e.status.type,'ok');assert.equal(e.c.readLocalDrafts().length,7);assert.equal(e.puts,1);
});
test('エクスポート・インポートは全内容保持、同IDは重複せず異なる内容なら停止',async()=>{
  const e=setup();const records=await e.c.legacyDraftRecords(e.original);
  const parsed=e.c.parseDraftBackup(e.c.draftBackupText(records));e.c.mergeLocalDrafts(parsed);e.c.mergeLocalDrafts(parsed);
  assert.equal(e.c.readLocalDrafts().length,7);
  const changed=clone(parsed);changed[0].content.note='different';
  assert.throws(()=>e.c.mergeLocalDrafts(changed),/同じID/);
  assert.deepEqual(clone(e.c.readLocalDrafts()),clone(records));
  assert.throws(()=>e.c.parseDraftBackup('{"version":99}'));
  assert.throws(()=>e.c.mergeLocalDrafts([{id:'x',content:{lineup:'invalid'}}]));
});
test('旧draft単体とdrafts双方を保護し、同内容の別案も失わない',async()=>{
  const e=setup();e.remote={...e.remote,drafts:[e.original.drafts[0],e.original.drafts[0]],draft:e.original.drafts[6]};
  await e.c.migratePublicDrafts(e.download,()=>true);
  assert.equal(e.c.readLocalDrafts().length,3);assert.equal(new Set(e.c.readLocalDrafts().map(r=>r.id)).size,3);
  assert.ok(!('draft'in e.remote));assert.ok(!('drafts'in e.remote));
});
test('共通の公開保存入口は旧下書き存在時に停止、移行後も古いデータから再混入しない',async()=>{
  const e=setup();const path='data/next-game.json';
  await assert.rejects(e.c.ghPut(path,e.original,'a','公開'),/先に/);assert.equal(e.puts,0);
  delete e.remote.drafts;
  await e.c.ghPut(path,{...e.original,draft:{name:'old'},defaultOrder:{}},'a','公開');
  assert.ok(!('drafts'in e.remote));assert.ok(!('draft'in e.remote));assert.ok(!('defaultOrder'in e.remote));
  await assert.rejects(e.c.ghPut(path,e.original,'stale','公開'),/SHA競合/);
});

test('通信失敗でも端末の下書き一覧を表示し、読み込み時にGitHubへ書かない',async()=>{
  const e=setup();e.c.mergeLocalDrafts(await e.c.legacyDraftRecords(e.original));
  e.c.fetch=async()=>{throw new Error('offline');};
  await e.c.loadNextGame();
  assert.match(e.node('draftListArea').innerHTML,/案7/);assert.equal(e.puts,0);
});
test('公開時はフォームのcurrentだけを更新し、端末下書きは保持する',async()=>{
  const e=setup();await e.c.migratePublicDrafts(e.download,()=>true);
  const saved=e.c.draftBackupText(e.c.readLocalDrafts());
  e.node('opponentInput').value='次の相手';
  await e.c.saveCurrent();
  assert.equal(e.remote.current.opponent,'次の相手');
  assert.equal(e.remote.current.scheduleGameId,'game1');
  assert.ok(!('drafts'in e.remote));assert.ok(!('draft'in e.remote));
  assert.equal(e.c.draftBackupText(e.c.readLocalDrafts()),saved);
});
