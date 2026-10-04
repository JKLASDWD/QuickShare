const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
module.exports=async({appOutDir})=>{
 const root=path.join(appOutDir,'resources');
 const files=[path.join(root,'native','process-audio.exe'),path.join(root,'app.asar.unpacked','native','bin','process-audio.exe')];
 const hashes=files.map(file=>{const data=fs.readFileSync(file);if(data.length<1024||data.toString('ascii',0,2)!=='MZ')throw Error(`无效应用声音模块: ${file}`);return crypto.createHash('sha256').update(data).digest('hex');});
 if(hashes[0]!==hashes[1])throw Error('应用声音模块与备用副本不一致');
 console.log('Verified application audio module and backup');
};
