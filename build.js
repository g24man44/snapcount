const fs=require('fs');
const html=fs.readFileSync(__dirname+'/src/index.html','utf8');
const src=fs.readFileSync(__dirname+'/src/worker.src.js','utf8');
fs.writeFileSync(__dirname+'/worker.js', src.replace('__HTML__', ()=>JSON.stringify(html)));
