// 真实 LiveKit + Electron 画布推流/收帧/删房；所有配置与进程均隔离。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),dgram=require('node:dgram');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const children=[];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'quickshare-e2e-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function tcpPort(){const s=http.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function udpPort(){const s=dgram.createSocket('udp4');s.bind(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function launch(exe,args,extraEnv={}) {
  const env={...process.env,...extraEnv};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(exe,args,{cwd:root,windowsHide:true,env});children.push(child);
  child.output='';child.records=[];
  child.stdout.on('data',chunk=>{
    child.output+=chunk;
    for(const line of child.output.split(/\r?\n/)) {
      if(!line.startsWith('{'))continue;
      try{const record=JSON.parse(line);if(!child.records.some(r=>JSON.stringify(r)===line))child.records.push(record);}catch{}
    }
  });
  child.stderr.on('data',c=>{child.errors=(child.errors||'')+c;});
  child.on('error',e=>{child.launchError=e;});
  return child;
}
async function waitFor(child,predicate,timeout=15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(predicate())return;if(child.launchError)throw child.launchError;if(child.exitCode!==null)throw new Error(`process exit ${child.exitCode}\n${child.output}\n${child.errors||''}`);await sleep(100);}
  throw new Error(`timeout\n${child.output}\n${child.errors||''}`);
}
async function exited(child,timeout=30000) {
  await waitFor(child,()=>child.smokeExit!==undefined || child.exitCode!==null,timeout);
  assert.equal(child.smokeExit??child.exitCode,0,JSON.stringify(child.records)+'\n'+(child.errors||''));
}
async function browserSmoke(mode,room,server,duration) {
  const candidates=[process.env.QUICKSHARE_CHROME,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const exe=candidates.find(p=>p && fs.existsSync(p));
  assert.ok(exe,'set QUICKSHARE_CHROME to a Chrome/Edge executable');
  const dir=path.join(tmp,'browser-'+mode+'-'+Math.random());fs.mkdirSync(dir);
  const port=await tcpPort();
  const child=launch(exe,['--headless=new',...(process.argv.includes('--no-sandbox')?['--no-sandbox']:[]),'--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required',`--user-data-dir=${dir}`,`--remote-debugging-port=${port}`,'about:blank']);
  await waitFor(child,()=>/DevTools listening/.test(child.errors||''));
  const targets=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
  const target=targets.find(t=>t.type==='page');assert.ok(target);
  const ws=new WebSocket(target.webSocketDebuggerUrl);child.ws=ws;
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('CDP WebSocket connection timeout')),10000);
    ws.addEventListener('open',()=>{clearTimeout(timeout);resolve();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(timeout);reject(new Error('CDP WebSocket failed'));},{once:true});
  });
  let seq=0;const pending=new Map();
  ws.addEventListener('message',ev=>{
    const m=JSON.parse(ev.data);
    if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(new Error(JSON.stringify(m.error)));else p?.resolve(m.result);}
    if(m.method==='Runtime.consoleAPICalled'){
      const line=m.params.args.map(a=>a.value??a.description??'').join(' ');
      child.output+=line+'\n';
      if(line.startsWith('SMOKE '))child.records.push(JSON.parse(line.slice(6)));
      if(line.startsWith('SMOKE-EXIT ')){
        const match=line.match(/^SMOKE-EXIT (\d+)(?: (.*))?$/);child.smokeExit=Number(match[1]);
        if(match[2])child.records.push({event:'summary',...JSON.parse(match[2])});
      }
    }
    if(m.method==='Runtime.exceptionThrown')child.output+=JSON.stringify(m.params)+'\n';
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq;
    const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},10000);
    pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});
    ws.send(JSON.stringify({id,method,params}));
  });
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.bridge={getConfig:async()=>({authToken:'e2e-auth'}),smokeLog:o=>console.log('SMOKE '+JSON.stringify(o)),smokeExit:(code,summary)=>console.log('SMOKE-EXIT '+code+' '+JSON.stringify(summary))};`});
  const url=pathToFileURL(path.join(root,'client/renderer/engine.html'));
  url.search=new URLSearchParams({mode,room,server,duration:String(duration)}).toString();
  await send('Page.navigate',{url:String(url)});
  console.log('browser loaded:',mode);
  return child;
}
(async()=>{
  const lkPort=await tcpPort(),rtcPort=await tcpPort(),apiPort=await tcpPort(),udp=await udpPort();
  const server=`http://127.0.0.1:${apiPort}`;
  const lk=launch(path.join(root,'tools/livekit-server.exe'),['--dev','--bind','127.0.0.1','--node-ip','127.0.0.1','--port',String(lkPort),'--rtc.tcp_port',String(rtcPort),'--udp-port',String(udp),'--rtc.enable_loopback_candidate']);
  await waitFor(lk,()=>/starting LiveKit server/i.test(lk.errors||''));
  console.log('LiveKit ready');
  const config=path.join(tmp,'server.json');
  fs.writeFileSync(config,JSON.stringify({listen:`127.0.0.1:${apiPort}`,livekit:{httpUrl:`http://127.0.0.1:${lkPort}`,wsUrl:`ws://127.0.0.1:${lkPort}`,apiKey:'devkey',apiSecret:'secret'},authToken:'e2e-auth'}));
  const token=launch(process.execPath,[path.join(root,'server/token-service/server.mjs')],{CONFIG_PATH:config,AUTH_TOKEN:'e2e-auth',REQUIRE_AUTH:'1'});
  await waitFor(token,()=>token.output.includes('listening'));
  console.log('Token service ready');
  const electron=path.join(root,'client/node_modules/electron/dist/electron.exe');
  async function smoke(mode,room,duration) {
    if(process.argv.includes('--browser'))return browserSmoke(mode,room,server,duration);
    const dir=path.join(tmp,mode+Math.random());fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({server,authToken:'e2e-auth'}));
    return launch(electron,[path.join(root,'client'),...(process.argv.includes('--no-sandbox')?['--no-sandbox']:[]),'--smoke',mode,room,server,String(duration)],{QUICKSHARE_SMOKE_DATA:dir});
  }
  const room='e2e-'+Date.now();
  const pub=await smoke('publish',room,30000);
  await waitFor(pub,()=>pub.records.some(r=>r.event==='published'));
  let active;
  const listDeadline=Date.now()+5000;
  do {
    active=await fetch(server+'/api/rooms',{headers:{authorization:'Bearer e2e-auth'},signal:AbortSignal.timeout(5000)}).then(r=>r.json());
    if(active.rooms.some(r=>r.roomId===room))break;
    await sleep(200);
  } while(Date.now()<listDeadline);
  if(!active.rooms.some(r=>r.roomId===room)) {
    const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
    const payload=b64({iss:'devkey',sub:'test',exp:Math.floor(Date.now()/1000)+60,video:{roomList:true}});
    const head=b64({alg:'HS256',typ:'JWT'});const signature=crypto.createHmac('sha256','secret').update(head+'.'+payload).digest('base64url');
    const raw=await fetch(`http://127.0.0.1:${lkPort}/twirp/livekit.RoomService/ListRooms`,{method:'POST',headers:{authorization:`Bearer ${head}.${payload}.${signature}`,'content-type':'application/json'},body:'{}'}).then(r=>r.json());
    console.error('LiveKit room counters:',raw.rooms?.map(({metadata,...r})=>r));
  }
  assert.ok(active.rooms.some(r=>r.roomId===room),'published room absent from active list: '+JSON.stringify(active));
  const denied=await fetch(server+'/api/rooms/'+room,{method:'DELETE',headers:{authorization:'Bearer e2e-auth','content-type':'application/json'},body:'{}'});
  assert.equal(denied.status,403);
  const watch=await smoke('watch',room,10000);
  await exited(watch);
  const result=watch.records.find(r=>r.event==='summary');
  assert.ok(result?.framesIn3s>0,JSON.stringify(watch.records));
  console.log('WATCH',JSON.stringify(result));
  await exited(pub);
  const join=await fetch(server+'/api/rooms/'+room+'/join',{method:'POST',headers:{authorization:'Bearer e2e-auth','content-type':'application/json'},body:'{}'});
  assert.equal(join.status,404,'room still exists after publisher cleanup');
  const again=await smoke('publish',room,1000);await exited(again);
  console.log('PASS: authenticated publication, real decoded frames, owner-only deletion, cleanup and same-ID recreation');
})().catch(e=>{
  console.error(e);
  for (const item of fs.readdirSync(tmp,{withFileTypes:true})) {
    if (!item.isDirectory()) continue;
    const log=path.join(tmp,item.name,'main.log');
    if(fs.existsSync(log))console.error('MAIN LOG:',fs.readFileSync(log,'utf8'));
  }
  process.exitCode=1;
}).finally(async()=>{
  for(const child of children.reverse()) {
    child.ws?.close();
    if(child.exitCode===null){const done=once(child,'exit');child.kill();await Promise.race([done,sleep(3000)]);}
  }
  // 删除范围仅限本脚本创建的系统临时目录。
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch(e){console.error('temporary profile cleanup:',e.message);}
});
