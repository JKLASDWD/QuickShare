const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
module.exports=async({appOutDir})=>{
 const root=path.join(appOutDir,'resources');
 const files=[path.join(root,'native','process-audio.exe'),path.join(root,'app.asar.unpacked','native','bin','process-audio.exe')];
 const hashes=files.map(file=>{const data=fs.readFileSync(file);if(data.length<1024||data.toString('ascii',0,2)!=='MZ')throw Error(`无效应用声音模块: ${file}`);return crypto.createHash('sha256').update(data).digest('hex');});
 if(hashes[0]!==hashes[1])throw Error('应用声音模块与备用副本不一致');
 const legal=path.join(root,'licenses');
 for(const relative of ['LICENSE','THIRD_PARTY_NOTICES.md','upstream/OBS-GPL-2.0.txt','vendor/manifest.json']){
  if(!fs.statSync(path.join(legal,relative)).size)throw Error(`缺少许可材料: ${relative}`);
 }
 const manifest=JSON.parse(fs.readFileSync(path.join(legal,'vendor','manifest.json'),'utf8'));
 if(!manifest.some(item=>item.name==='livekit-client'))throw Error('缺少 LiveKit 许可');
 for(const item of manifest){
  if(!item.files.length)throw Error(`缺少依赖许可: ${item.name}`);
  for(const relative of item.files){if(!fs.statSync(path.join(legal,'vendor',relative)).size)throw Error(`缺少依赖许可: ${relative}`);}
 }
 console.log(`Verified project, OBS and ${manifest.length} vendor license records`);
 console.log('Verified application audio module and backup');
};
