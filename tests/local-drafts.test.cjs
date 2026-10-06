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
  const env={c,node,storage,remote:clone(original),original,sha:'a',puts:0,gets:0};
  c.fetch=async (url,options={})=>{
    if(options.method!=='PUT'){env.gets++;return {ok:true,json:async()=>({sha:env.sha,content:Buffer.from(JSON.stringify(env.remote)).toString('base64')})};}
    const body=JSON.parse(options.body);env.puts++;
    if(body.sha!==env.sha)return {ok:false,status:409,text:async()=> 'conflict'};
    env.remote=JSON.parse(Buffer.from(body.content,'base64').toString());env.sha='saved';
    return {ok:true,json:async()=>({content:{sha:env.sha}})};
  };
  c.showStatus=(type,text)=>{env.status={type,text};};
  c.fillNextGameForm=d=>{env.form=clone(d);};
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
test('移行・入出力専用UIと処理はなく、端末保存UIは維持',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../admin.html'),'utf8');
  assert.doesNotMatch(html,/migrateDraftsBtn|migratePublicDrafts|legacyDraftRecords|draftMigrationBusy|removeDrafts|公開下書きをバックアップ|exportDraftsBtn|importDraftsFile|exportLocalDrafts|importLocalDrafts|downloadDraftBackup|mergeLocalDrafts|stableDraftJson/);
  for(const id of ['saveDraftBtn','draftListArea']) assert.ok(html.includes(`id="${id}"`));
});
for(const failure of ['write','verify','read'])test(`端末${failure}失敗は表示し、公開JSONには書き込まない`,async()=>{
  const e=setup();
  if(failure==='write')e.c.localStorage.setItem=()=>{throw new Error('quota');};
  if(failure==='verify')e.c.localStorage.setItem=()=>{};
  if(failure==='read')e.c.localStorage.getItem=()=>{throw new Error('denied');};
  await e.c.saveDraft();
  assert.equal(e.puts,0);assert.equal(e.gets,0);assert.deepEqual(e.remote,e.original);assert.equal(e.status.type,'err');
});
test('既存の保存キー・形式の下書きを内容とIDを変えず読み書きできる',()=>{
  const e=setup();const records=e.original.drafts.map((content,i)=>({id:`legacy-existing-${i}`,content}));
  const key='ffhp_nextgame_drafts_v1:'+JSON.stringify(['igreeeen9-design','fullface-hp','main']);
  const text=JSON.stringify({format:'ffhp-nextgame-drafts',version:1,drafts:records},null,2);
  e.storage.set(key,text);
  assert.equal(e.c.localDraftKey(),key);
  assert.deepEqual(clone(e.c.readLocalDrafts()),records);
  e.c.writeLocalDrafts(e.c.readLocalDrafts());assert.equal(e.storage.get(key),text);
  assert.throws(()=>e.c.parseDraftBackup('{"version":99}'));
  assert.throws(()=>e.c.writeLocalDrafts([{id:'x',content:{lineup:'invalid'}}]));
  assert.equal(e.storage.get(key),text);assert.equal(e.puts,0);
});
test('旧draft単体が残る場合も公開保存せず既存データを保護',async()=>{
  const e=setup();delete e.remote.drafts;e.remote.draft=e.original.drafts[6];
  const before=clone(e.remote);
  await assert.rejects(e.c.ghPut('data/next-game.json',e.original,'a','公開'),/保護のため保存を停止/);
  assert.equal(e.puts,0);assert.deepEqual(e.remote,before);assert.equal(e.c.readLocalDrafts().length,0);
});
test('共通の公開保存入口は旧下書き存在時に停止、旧下書きがない場合も古いデータから再混入しない',async()=>{
  const e=setup();const path='data/next-game.json';
  await assert.rejects(e.c.ghPut(path,e.original,'a','公開'),/保護のため保存を停止/);assert.equal(e.puts,0);
  delete e.remote.drafts;
  await e.c.ghPut(path,{...e.original,draft:{name:'old'},defaultOrder:{}},'a','公開');
  assert.ok(!('drafts'in e.remote));assert.ok(!('draft'in e.remote));assert.ok(!('defaultOrder'in e.remote));
  await assert.rejects(e.c.ghPut(path,e.original,'stale','公開'),/SHA競合/);
});

test('通信失敗でも端末の下書き一覧を表示し、読み込み時にGitHubへ書かない',async()=>{
  const e=setup();e.c.writeLocalDrafts(e.original.drafts.map((content,i)=>({id:`existing-${i}`,content})));
  e.c.fetch=async()=>{throw new Error('offline');};
  await e.c.loadNextGame();
  assert.match(e.node('draftListArea').innerHTML,/案7/);assert.equal(e.puts,0);
});
test('公開時はフォームのcurrentだけを更新し、端末下書きは保持する',async()=>{
  const e=setup();e.c.writeLocalDrafts(e.original.drafts.map((content,i)=>({id:`existing-${i}`,content})));
  delete e.remote.drafts;await e.c.loadNextGame();
  const saved=e.c.draftBackupText(e.c.readLocalDrafts());
  e.node('opponentInput').value='次の相手';
  await e.c.saveCurrent();
  assert.equal(e.remote.current.opponent,'次の相手');
  assert.equal(e.remote.current.scheduleGameId,'game1');
  assert.ok(!('drafts'in e.remote));assert.ok(!('draft'in e.remote));
  assert.equal(e.c.draftBackupText(e.c.readLocalDrafts()),saved);
});
