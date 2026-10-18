const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../script.js'),'utf8');
function setup(){
 const events={},calls=[],renders=[],timers=new Map();let seq=0;
 const nodes=Object.fromEntries(['nextGameContent','scheduleContent','heroNextGame'].map(id=>[id,{innerHTML:'',querySelectorAll:()=>[]} ]));
 const c=vm.createContext({Date,Promise,Set,JSON,Array,document:{visibilityState:'visible',getElementById:id=>nodes[id],addEventListener:(k,v)=>events[k]=v},window:{addEventListener:(k,v)=>events[k]=v},setTimeout:f=>{timers.set(++seq,f);return seq;},clearTimeout:id=>timers.delete(id),nextGameAttendance:()=>({members:[]}),renderNextGame:()=>renders.push('next'),renderHeroNextGame:()=>renders.push('hero'),renderSchedule:()=>renders.push('schedule'),fetch:(url,options)=>new Promise(resolve=>calls.push({url,options,resolve}))});
 vm.runInContext(source.match(/async function loadJson\([\s\S]*?\n\}/)[0],c);
 vm.runInContext(source.slice(source.indexOf('let jsonRequestSequence'),source.indexOf('/* ---- 試合日程')),c);
 const settle=async(start,note='new',ok=true)=>{for(const call of calls.slice(start,start+2))call.resolve({ok,json:async()=>call.url.includes('next-game')?{current:{note}}:{games:[]}});await new Promise(r=>setImmediate(r));};
 const flush=()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(f=>f());};
 return {c,events,calls,renders,nodes,settle,flush};
}
test('初回は2件のみ取得、通常pageshowは重複せず、復帰で新しいURLを取得する',async()=>{
 const e=setup();assert.equal(e.calls.length,2);await e.settle(0);
 assert.deepEqual(e.renders,['next','hero','schedule']);e.events.pageshow({persisted:false});e.flush();assert.equal(e.calls.length,2);
 e.c.document.visibilityState='hidden';e.events.visibilitychange();e.flush();assert.equal(e.calls.length,2);
 e.c.document.visibilityState='visible';e.events.visibilitychange();e.events.pageshow({persisted:true});e.flush();assert.equal(e.calls.length,4);
 assert.notEqual(e.calls[0].url,e.calls[2].url);assert.notEqual(e.calls[1].url,e.calls[3].url);
 assert.ok(e.calls.every(x=>/data\/(next-game|schedule)\.json\?t=/.test(x.url)&&x.options.cache==='no-store'));
 await e.settle(2);assert.equal(e.renders.length,3); // 同じ内容はUIを再作成しない
 e.events.pageshow({persisted:true});e.flush();await e.settle(4,'changed');assert.equal(e.renders.length,6);
});
test('古い応答と復帰時の取得失敗で現在の画面を上書きしない',async()=>{
 const e=setup();e.events.pageshow({persisted:true});e.flush();await e.settle(2,'latest');await e.settle(0,'old');assert.equal(e.renders.length,3);
 e.nodes.nextGameContent.innerHTML='保持';e.events.visibilitychange();e.flush();await e.settle(4,'',false);assert.equal(e.nodes.nextGameContent.innerHTML,'保持');assert.equal(e.renders.length,3);
});
test('再描画時は同じ試合IDの参加予定欄の展開を保持する',async()=>{
 const e=setup();await e.settle(0);
 const button={dataset:{scheduleId:'game-1',scheduleToggle:'2'},setAttribute:(k,v)=>button[k]=v};const detail={hidden:true};
 e.nodes.scheduleContent.querySelectorAll=()=>[button];e.nodes.scheduleContent.querySelector=()=>detail;
 e.events.visibilitychange();e.flush();await e.settle(2,'changed');assert.equal(button['aria-expanded'],'true');assert.equal(detail.hidden,false);
});
