const fs=require('fs');
const crypto=require('crypto');
let html=fs.readFileSync(__dirname+'/src/index.html','utf8');
const build=crypto.createHash('sha1').update(html).digest('hex').slice(0,10);
html=html.replace('__BUILD__', build);
const src=fs.readFileSync(__dirname+'/src/worker.src.js','utf8');
fs.writeFileSync(__dirname+'/worker.js', src.replace('__HTML__', ()=>JSON.stringify(html)).replace('"__BUILDID__"', JSON.stringify(build)));
