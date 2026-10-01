const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const root = path.resolve(__dirname, '..');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(setImmediate);

async function backend(t) {
  const rooms = new Map();
  let serial = 0;
  const mock = http.createServer(async (req,res) => {
    let text=''; for await (const chunk of req) text += chunk;
    const body=JSON.parse(text || '{}');
    const method=req.url.split('/').pop();
    let result={};
    if (method === 'ListRooms') {
      result={rooms:[...rooms.values()].filter(r=>!body.names || body.names.includes(r.name))};
      await new Promise(r=>setTimeout(r,15));
    } else if (method === 'CreateRoom') {
      if (!rooms.has(body.name)) rooms.set(body.name,{name:body.name,sid:`RM_${++serial}`,metadata:body.metadata,num_publishers:0,num_participants:0});
      result=rooms.get(body.name);
    } else if (method === 'DeleteRoom') rooms.delete(body.room);
    else { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(result));
  });
  mock.listen(0,'127.0.0.1'); await once(mock,'listening');
  const reserve=http.createServer(); reserve.listen(0,'127.0.0.1'); await once(reserve,'listening');
  const port=reserve.address().port; await new Promise(r=>reserve.close(r));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quickshare-test-'));
  const config=path.join(dir,'config.json');
  fs.writeFileSync(config,JSON.stringify({listen:`127.0.0.1:${port}`,livekit:{httpUrl:`http://127.0.0.1:${mock.address().port}`,wsUrl:'ws://test',apiKey:'test',apiSecret:'test-secret'},authToken:'shared-auth',rooms:{emptyTimeoutSeconds:0}}));
  let child;
  async function start() {
    child=spawn(process.execPath,[path.join(root,'server/token-service/server.mjs')],{windowsHide:true,env:{...process.env,CONFIG_PATH:config,AUTH_TOKEN:'shared-auth',REQUIRE_AUTH:'1'}});
    let error=''; child.stderr.on('data',c=>error+=c);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('server startup timeout '+error)),5000);
      child.stdout.on('data',c=>{if(String(c).includes('listening')){clearTimeout(timer);resolve();}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('server exit '+code+' '+error));});
    });
  }
  async function stop() { if(child && child.exitCode === null) { const done=once(child,'exit'); child.kill(); await done; } }
  t.after(async()=>{await stop();await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  await start();
  async function api(method,route,body,auth='shared-auth') {
    const response=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,headers:response.headers,body:response.status===204?null:await response.json()};
  }
  return {rooms,api,restart:async()=>{await stop();await start();}};
}

test('HTTP API: concurrent creation, owner-only deletion, restart, stale credentials and auth', async t => {
  const b=await backend(t);
  assert.equal((await b.api('GET','/api/rooms',undefined,'')).status,401);
  const preflight=await b.api('OPTIONS','/api/rooms',undefined,'');
  assert.match(preflight.headers.get('access-control-allow-headers'),/authorization/);
  const results=await Promise.all([b.api('POST','/api/rooms',{roomId:'race',password:'pw'}),b.api('POST','/api/rooms',{roomId:'race',password:'other'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const created=results.find(r=>r.status===201).body;
  const meta=JSON.parse(b.rooms.get('race').metadata);
  assert.equal(meta.password,undefined); assert.equal(meta.ownerToken,undefined);
  assert.equal((await b.api('DELETE','/api/rooms/race',{password:'pw'})).status,403);
  assert.equal((await b.api('DELETE','/api/rooms/race',{ownerToken:'forged'})).status,403);
  await b.restart();
  assert.equal((await b.api('POST','/api/rooms/race/join',{password:'bad'})).status,401);
  const joined=await b.api('POST','/api/rooms/race/join',{password:'pw'});
  assert.equal(joined.status,200);
  const claims=JSON.parse(Buffer.from(joined.body.token.split('.')[1],'base64url'));
  assert.equal(claims.video.canPublish,false);
  assert.equal(joined.body.ownerToken,undefined);
  assert.equal((await b.api('GET','/api/rooms')).body.rooms.length,0);
  b.rooms.get('race').numPublishers=1;b.rooms.get('race').numParticipants=3;
  const listed=(await b.api('GET','/api/rooms')).body.rooms;
  assert.equal(listed.length,1);assert.equal(listed[0].participants,3);
  assert.equal((await b.api('DELETE','/api/rooms/race',{ownerToken:created.ownerToken})).status,200);
  const replacement=await b.api('POST','/api/rooms',{roomId:'race'});
  assert.equal(replacement.status,201);
  assert.equal((await b.api('DELETE','/api/rooms/race',{ownerToken:created.ownerToken})).status,403);
  assert.equal((await b.api('DELETE','/api/rooms/race',{ownerToken:replacement.body.ownerToken})).status,200);
  assert.equal((await b.api('POST','/api/rooms',null)).status,400);
  assert.equal((await b.api('POST','/api/rooms',{roomId:'x',presenter:'中'.repeat(24000)})).status,413);
  b.rooms.set('legacy',{name:'legacy',sid:'legacy',metadata:JSON.stringify({hasPassword:true})});
  assert.equal((await b.api('DELETE','/api/rooms/legacy',{})).status,403);
  assert.equal((await b.api('POST','/api/rooms/legacy/join',{password:'pw'})).status,503);
});

test('room sweeper removes abandoned managed rooms and preserves active/foreign rooms',async t=>{
  const b=await backend(t);
  const abandoned=await b.api('POST','/api/rooms',{roomId:'abandoned'});
  assert.equal(abandoned.status,201);
  await b.api('POST','/api/rooms',{roomId:'active'});b.rooms.get('active').num_publishers=1;
  b.rooms.set('foreign',{name:'foreign',sid:'foreign',num_publishers:0,metadata:'{}'});
  const deadline=Date.now()+18000;
  while(b.rooms.has('abandoned') && Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  assert.equal(b.rooms.has('abandoned'),false);
  assert.equal(b.rooms.has('active'),true);assert.equal(b.rooms.has('foreign'),true);
});

function renderer(name, options={}) {
  let src=fs.readFileSync(path.join(root,'client/renderer',name+'.html'),'utf8').match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  src=src.replace('init();','');
  const exports=name==='picker'?'startShare, startShareViaSystemPicker, stopShare, setSelected(s){selected=s;}, state(){return {sharing,starting,active,stopTask};}':'joinRoom,leaveRoom,loadRooms,state(){return {room,joining};}';
  src=src.replace(/\}\)\(\);\s*$/,`globalThis.audit={${exports}};})();`);
  const nodes=new Map();
  function node(id){if(!nodes.has(id)) nodes.set(id,{value:id==='roomId'?'demo':'',style:{},textContent:'',innerHTML:'',disabled:false,addEventListener(){},appendChild(){},focus(){},remove(){},classList:{toggle(){}}});return nodes.get(id);}
  const timers=new Map();let timerId=0;
  const config={server:'http://old',displayName:'Tester',authToken:'old',maxBitrateKbps:8000};
  const calls=[],instances=[],tracks=[];
  class Room extends EventEmitter {
    constructor(){super();instances.push(this);this.remoteParticipants=new Map();this.disconnects=0;this.localParticipant={publishTrack:async()=>{if(options.publishError) throw new Error('publish failed');}};}
    async connect(){if(options.connect) await options.connect(this);}
    async disconnect(){this.disconnects++;this.emit('Disconnected');}
  }
  class LocalVideoTrack {constructor(raw){this.mediaStreamTrack=raw;}stop(){this.mediaStreamTrack.stop();}}
  function raw(){const track={stops:0,label:'test',stop(){this.stops++;},addEventListener(event,cb){this[event]=cb;}};tracks.push(track);return track;}
  const bridge={getConfig:async()=>({...config}),log(){},shareBusy(){calls.push('busy');},shareStarted(){calls.push('started');},shareStopped(){calls.push('stopped');},notify(){}};
  const capture=async()=>{const t=raw();return {getTracks:()=>[t],getVideoTracks:()=>[t]};};
  const context={window:{LivekitClient:{Room,LocalVideoTrack,RoomEvent:{Disconnected:'Disconnected',TrackSubscribed:'TrackSubscribed',TrackUnsubscribed:'TrackUnsubscribed',ParticipantConnected:'ParticipantConnected',ParticipantDisconnected:'ParticipantDisconnected'},Track:{Source:{ScreenShare:'screen'},Kind:{Video:'video'}},VideoQuality:{HIGH:2}},bridge,addEventListener(){}},document:{getElementById:node,createElement:()=>node(Math.random()),querySelectorAll:()=>[]},navigator:{mediaDevices:{getUserMedia:options.capture||capture,getDisplayMedia:options.capture||capture}},fetch:options.fetch||(async(url,opts)=>{calls.push({url,opts});return {ok:true,status:opts?.method==='POST'?201:200,json:async()=>({ownerToken:'owner',url:'ws://test',token:'token',rooms:[]})};}),console,AbortSignal,URLSearchParams,location:{search:''},setTimeout:(cb,ms)=>{timers.set(++timerId,{cb,ms});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:(cb,ms)=>{timers.set(++timerId,{cb,ms,interval:true});return timerId;},clearInterval:id=>timers.delete(id)};
  vm.runInNewContext(src,context,{filename:name+'.html'});
  context.audit.setSelected?.({id:'screen:1',name:'Screen'});
  return {...context,audit:context.audit,config,calls,instances,tracks,nodes,timers,node};
}

test('publisher: concurrent start, rollback on create failure, buttons and raw capture cleanup',async()=>{
  let posts=0;
  const r=renderer('picker',{fetch:async()=>{posts++;await tick();return {ok:false,status:409,json:async()=>({error:'occupied'})};}});
  await Promise.all([r.audit.startShare(),r.audit.startShare()]);
  assert.equal(posts,1);assert.equal(r.tracks.length,1);assert.ok(r.tracks[0].stops>0);
  assert.equal(r.node('startBtn').disabled,false);assert.equal(r.node('sysPickBtn').disabled,false);
  assert.equal(r.audit.state().active,null);
});

test('publisher: connect/publish failure deletes created room and permits retry',async()=>{
  for(const options of [{connect:async()=>{throw new Error('connect failed');}},{publishError:true}]) {
    const r=renderer('picker',options);await r.audit.startShare();
    assert.ok(r.tracks[0].stops>0);assert.equal(r.instances[0].disconnects,1);
    const deletion=r.calls.find(c=>c.opts?.method==='DELETE');
    assert.equal(JSON.parse(deletion.opts.body).ownerToken,'owner');
    assert.equal(r.node('startBtn').disabled,false);
  }
});

test('publisher: latest configuration, session-scoped deletion and idempotent stopping',async()=>{
  const r=renderer('picker');r.config.server='http://new';r.config.authToken='new';
  await r.audit.startShare();assert.equal(r.audit.state().sharing,true);
  r.config.server='http://other';r.config.authToken='other';
  await Promise.all([r.audit.stopShare(),r.audit.stopShare()]);
  const post=r.calls.find(c=>c.opts?.method==='POST'),del=r.calls.find(c=>c.opts?.method==='DELETE');
  assert.equal(post.url,'http://new/api/rooms');assert.equal(del.url,'http://new/api/rooms/demo');
  assert.equal(del.opts.headers.authorization,'Bearer new');
  assert.equal(r.calls.filter(c=>c.opts?.method==='DELETE').length,1);
  assert.equal(r.instances[0].disconnects,1);assert.equal(r.audit.state().sharing,false);
});

test('publisher: cancellation during capture and late system-picker result stop tracks',async()=>{
  const capture=deferred();let stops=0;
  const stream={getTracks:()=>[{stop(){stops++;}}],getVideoTracks:()=>[{stop(){stops++;}}]};
  const r=renderer('picker',{capture:()=>capture.promise});
  const start=r.audit.startShare();await tick();const stop=r.audit.stopShare();capture.resolve(stream);
  await Promise.all([start,stop]);assert.ok(stops>0);assert.equal(r.calls.filter(c=>c.opts?.method==='POST').length,0);
  const later=deferred();const s=renderer('picker',{capture:()=>later.promise});
  const pending=s.audit.startShareViaSystemPicker();await tick();
  [...s.timers.values()].find(t=>t.ms===60000).cb();await pending;
  const previous=stops;later.resolve(stream);await tick();assert.ok(stops>previous);
});

test('publisher: stop while creation is pending rolls back the returned room',async()=>{
  const created=deferred();let deletes=0;
  const r=renderer('picker',{fetch:async(url,opts)=>{if(opts.method==='DELETE'){deletes++;return {ok:true,status:200};}return created.promise;}});
  const start=r.audit.startShare();await tick();const stop=r.audit.stopShare();
  created.resolve({ok:true,status:201,json:async()=>({ownerToken:'owner',url:'ws://test',token:'token'})});
  await Promise.all([start,stop]);assert.equal(deletes,1);assert.equal(r.instances.length,0);
});

test('viewer: concurrent joins, connect failure cleanup and retry',async()=>{
  let attempts=0;
  const r=renderer('viewer',{connect:async()=>{attempts++;await tick();if(attempts===1)throw new Error('failed');}});
  await Promise.all([r.audit.joinRoom('a'),r.audit.joinRoom('a')]);
  assert.equal(r.instances.length,1);assert.equal(r.instances[0].disconnects,1);
  assert.equal(r.audit.state().room,null);assert.equal(r.audit.state().joining,false);
  await r.audit.joinRoom('b');assert.equal(r.instances.length,2);assert.equal(r.node('title').textContent,'房间 b');
  await r.audit.leaveRoom();assert.equal(r.instances[1].disconnects,1);
});

test('viewer: cancelled connection and old disconnect cannot close a new room',async()=>{
  const pending=deferred();let count=0;
  const r=renderer('viewer',{connect:async()=>{if(++count===1)await pending.promise;}});
  const first=r.audit.joinRoom('a');await tick();await r.audit.leaveRoom();
  r.config.server='http://latest';await r.audit.joinRoom('b');
  pending.resolve();await first;r.instances[0].emit('Disconnected');
  assert.equal(r.audit.state().room,r.instances[1]);assert.equal(r.node('title').textContent,'房间 b');
  assert.ok(r.calls.some(c=>c.url==='http://latest/api/rooms/b/join'));
});

test('viewer: direct protected-room entry prompts for password',async()=>{
  const r=renderer('viewer',{fetch:async()=>({ok:false,status:401,json:async()=>({error:'password'})})});
  await r.audit.joinRoom('protected');assert.equal(r.node('pwBox').style.display,'flex');
  assert.equal(r.node('pwRoom').textContent,'protected');assert.equal(r.audit.state().joining,false);
});

test('main process: sharing window hides on close but exit waits for cleanup and then closes',async()=>{
  const app=new EventEmitter();const ipc=new EventEmitter();ipc.handlers=new Map();ipc.handle=(name,fn)=>ipc.handlers.set(name,fn);
  const windows=[];const messages=[];let quitCompleted=0;
  class Window extends EventEmitter {
    constructor(){super();windows.push(this);this.webContents=new EventEmitter();this.webContents.send=(...args)=>messages.push(args);this.destroyed=false;}
    loadFile(){} show(){} focus(){} moveTop(){} hide(){this.hidden=true;} isDestroyed(){return this.destroyed;}
  }
  Object.assign(app,{getPath:()=>os.tmpdir(),commandLine:{appendSwitch(){}},getVersion:()=> 'test',requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),focus(){},quit(){let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(prevented)return;for(const w of windows){let blocked=false;w.emit('close',{preventDefault(){blocked=true;}});if(!blocked)w.destroyed=true;}quitCompleted++;}});
  const fakeFs={existsSync:()=>false,appendFileSync(){},readFileSync:()=>JSON.stringify({server:'http://old'}),writeFileSync(){},mkdirSync(){}};
  const electron={app,BrowserWindow:Window,ipcMain:ipc,Tray:class extends EventEmitter{setContextMenu(){}setToolTip(){}},Menu:{buildFromTemplate:m=>m},globalShortcut:{register:()=>true,unregisterAll(){}},desktopCapturer:{getSources:async()=>[]},session:{defaultSession:{setDisplayMediaRequestHandler(){},setCertificateVerifyProc(){}}},Notification:{isSupported:()=>false},nativeImage:{createEmpty:()=>({})}};
  const timers=[];
  vm.runInNewContext(fs.readFileSync(path.join(root,'client/main.js'),'utf8'),{require:n=>n==='electron'?electron:n==='fs'?fakeFs:n==='./certificate-policy'?require('../client/certificate-policy'):require(n),__dirname:path.join(root,'client'),process:{env:{},argv:[],on(){},versions:{electron:'test'}},console,URLSearchParams,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}});
  await tick();
  ipc.handlers.get('save-config')({}, {server:'http://new',authToken:'new'});
  assert.ok(messages.some(m=>m[0]==='config-changed' && m[1].server==='http://new'));
  ipc.emit('share-started',{}, {roomId:'demo'});
  let prevented=false;windows[0].emit('close',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
  app.quit();assert.equal(quitCompleted,0);assert.ok(messages.some(m=>m[0]==='stop-share'));
  ipc.emit('share-stopped',{},{});assert.equal(quitCompleted,1);assert.equal(windows[0].destroyed,true);
  assert.equal(timers.length,1);
  timers[0]();assert.equal(quitCompleted,1,'late quit timeout must be idempotent');
});

test('syntax: all renderer scripts and preload compile',()=>{
  for(const name of ['picker','viewer','settings','engine']) {
    const html=fs.readFileSync(path.join(root,'client/renderer',name+'.html'),'utf8');
    for(const script of html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g))new vm.Script(script[1],{filename:name+'.html'});
  }
  new vm.Script(fs.readFileSync(path.join(root,'client/preload.js'),'utf8'));
});
