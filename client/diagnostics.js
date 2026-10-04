'use strict';
const fs = require('node:fs');
const path = require('node:path');
function createDiagnostics({directory,getSecrets=()=>[],maxBytes=2*1024*1024,filesystem=fs}) {
  const fs=filesystem;
  let file=path.join(directory,'main.log'),sequence=0;
  function redact(value) {
    if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/password|secret|token|authorization|chatText/i.test(key)?'[redacted]':redact(item)]));
    if (typeof value!=='string') return value;
    let text=value.replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted JWT]').replace(/(https?:\/\/|wss?:\/\/)([^\s/@]+@)/g,'$1[redacted]@').replace(/([?&](?:token|password|secret|auth)[^=\s]*=)[^&#\s]+/gi,'$1[redacted]');
    let secrets=[];try{secrets=getSecrets()||[];}catch{}
    for (const secret of secrets.filter(s=>typeof s==='string'&&s.length>0)) text=text.split(secret).join('[redacted]');
    return text;
  }
  function log(event,data) {
    try {
      fs.mkdirSync(directory,{recursive:true});
      if (fs.existsSync(file)&&fs.statSync(file).size>=maxBytes) file=path.join(directory,`main-${Date.now()}-${++sequence}.log`);
      fs.appendFileSync(file,`${new Date().toISOString()} ${redact(String(event))} ${JSON.stringify(redact(data??''))}\n`);
    } catch {}
  }
  function read() {
    let descriptor;
    try {
      descriptor=fs.openSync(file,'r');const size=fs.fstatSync(descriptor).size;
      const buffer=Buffer.alloc(Math.min(size,256*1024));fs.readSync(descriptor,buffer,0,buffer.length,Math.max(0,size-buffer.length));
      return {path:file,text:redact(buffer.toString('utf8'))};
    } catch(e) {return {path:file,text:`暂无日志或日志无法读取：${e.code || 'unknown'}`};}
    finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
  }
  return {log,read,redact};
}
module.exports={createDiagnostics};
