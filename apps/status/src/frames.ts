// The frame browser: every kept frame with the boxes the detector produced on it, drawn client-side from the
// normalized coordinates in SQLite (nothing rendered or stored on the server). docs/FRAMES-AND-BASELINE.md §2.
export const framesPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ranch frames</title>
<style>
  :root{color-scheme:dark;--bg:#0f1115;--card:#171a21;--line:#262a33;--fg:#e6e8ee;--dim:#8b93a7;--ok:#3ecf8e}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,system-ui,sans-serif;padding:12px 16px}
  h1{font-size:16px;margin:0 0 8px} a{color:#9ecbff} .muted{color:var(--dim)}
  form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px} input,select,button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit}
  .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;cursor:pointer}
  .img{position:relative;background:#000;aspect-ratio:16/9} .img img{width:100%;height:100%;object-fit:contain;display:block}
  .box{position:absolute;border:2px solid #ffd166;border-radius:2px;pointer-events:none} .box span{position:absolute;left:-2px;top:-18px;background:#ffd166;color:#000;font-size:11px;padding:0 4px;border-radius:2px;white-space:nowrap}
  .box.horse{border-color:var(--ok)} .box.horse span{background:var(--ok)} .box.person{border-color:#ff6b6b} .box.person span{background:#ff6b6b}
  .box.car,.box.truck{border-color:#9ecbff} .box.car span,.box.truck span{background:#9ecbff}
  .box.gold{border-style:dashed;border-color:#3ecf8e} .box.gold span{background:#3ecf8e}
  .meta{padding:6px 8px;font-size:12px} .meta b{font-weight:600}
  #view{position:fixed;inset:0;background:#000d;display:none;z-index:9;padding:12px} #view.open{display:flex;flex-direction:column}
  #view .img{flex:1;aspect-ratio:auto;min-height:0} #view .img img{object-fit:contain;max-height:100%} #view .bar{display:flex;gap:12px;align-items:center;padding:6px 0}
</style></head><body>
<h1>ranch frames <a href="/" class="muted" style="font-weight:400;font-size:13px">· status</a></h1>
<form id="f">
  <select name="set"><option value="">live frames</option></select>
  <select name="model" style="display:none"></select>
  <select name="camera"><option value="">all cameras</option></select>
  <select name="since"><option value="1h">last hour</option><option value="6h">6 h</option><option value="24h">24 h</option><option value="7d">7 days</option></select>
  <select name="label"><option value="">any label</option></select>
  <input name="min_conf" placeholder="min conf" size="7" type="number" step="0.05" min="0" max="1">
  <select name="reason"><option value="">any reason</option><option value="change">scene change</option><option value="floor">floor</option></select>
  <label><input type="checkbox" name="with_detections" value="1"> only with detections</label>
  <button>show</button> <span id="count" class="muted"></span>
</form>
<div class="grid" id="grid"></div>
<p><button id="more" style="display:none">older…</button></p>
<div id="view"><div class="bar"><button id="prev">‹ prev</button><span id="vmeta"></span><button id="next">next ›</button><span style="flex:1"></span><button id="close">close</button></div><div class="img" id="vimg"></div></div>
<script>
const $=s=>document.querySelector(s); const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const local=iso=>new Date(iso).toLocaleString('sv-SE').replace(' ','T').slice(5,19);
let rows=[], cur=-1;
function boxes(f,w){return f.detections.map(d=>'<div class="box '+esc(d.label.split('/')[0].replace(/\\s/g,'-'))+(d.model&&String(d.model).startsWith('labels:')?' gold':'')+'" style="left:'+(100*d.x)+'%;top:'+(100*d.y)+'%;width:'+(100*d.w)+'%;height:'+(100*d.h)+'%"><span>'+esc(d.label)+' '+d.confidence.toFixed(2)+'</span></div>').join('')}
function imgBox(f,w){return '<div class="img"><img src="'+(f.img?f.img+'?w='+w:'/api/frame/'+f.id+'?w='+w)+'" loading="lazy" alt="">'+boxes(f)+'</div>'}
function card(f,i){const labs=f.detections.map(d=>d.label).reduce((m,l)=>(m[l]=(m[l]||0)+1,m),{});
  return '<div class="card" data-i="'+i+'">'+imgBox(f,640)+'<div class="meta"><b>'+esc(f.camera)+'</b> <span class="muted">'+local(f.ts)+' · '+f.reason+(f.change!=null?' · Δ'+(100*f.change).toFixed(1)+'%':'')+'</span><br>'+(Object.entries(labs).map(([l,n])=>esc(l)+(n>1?' ×'+n:'')).join(', ')||'<span class="muted">no detections</span>')+'</div></div>'}
function query(){const fd=new FormData($('#f'));const p=new URLSearchParams();for(const [k,v] of fd)if(v)p.set(k,v);p.set('limit','60');return p}
let sets=[];
function syncSet(){const set=$('[name=set]').value;const ms=$('[name=model]');ms.style.display=set?'':'none';const info=sets.find(x=>x.date===set);
  if(info&&[...ms.options].map(o=>o.value).join()!==info.models.join()){ms.innerHTML=info.models.map(m=>'<option>'+esc(m)+'</option>').join('')}}
async function load(more){const p=query();const set=p.get('set');let r;
  if(set){const q=new URLSearchParams({model:p.get('model')||'',min_conf:p.get('min_conf')||'0.25'});if(p.get('camera'))q.set('camera',p.get('camera'));
    r=await (await fetch('/api/baseline/'+set+'?'+q)).json();if(p.get('label'))r=r.filter(f=>f.detections.some(d=>d.label===p.get('label')));if(p.get('with_detections'))r=r.filter(f=>f.detections.length);rows=r;$('#more').style.display='none';$('#grid').innerHTML=rows.map(card).join('');$('#count').textContent=rows.length+' baseline frames';history.replaceState(null,'','/frames?'+query());return}
  if(more&&rows.length)p.set('before',rows[rows.length-1].id);
  r=await (await fetch('/api/frames?'+p)).json();rows=more?rows.concat(r):r;
  $('#grid').innerHTML=rows.map(card).join('');$('#count').textContent=rows.length+' frames';$('#more').style.display=r.length>=60?'':'none';
  history.replaceState(null,'','/frames?'+query())}
function show(i){if(i<0||i>=rows.length)return;cur=i;const f=rows[i];$('#vimg').innerHTML=imgBox(f,1920);
  $('#vmeta').innerHTML='<b>'+esc(f.camera)+'</b> '+local(f.ts)+' · '+f.reason+' · frame #'+f.id+' · '+(f.detections.map(d=>esc(d.label)+' '+d.confidence.toFixed(2)).join(', ')||'no detections');$('#view').classList.add('open')}
$('#grid').addEventListener('click',e=>{const c=e.target.closest('.card');if(c)show(+c.dataset.i)});
$('#prev').onclick=()=>show(cur-1);$('#next').onclick=()=>show(cur+1);$('#close').onclick=()=>$('#view').classList.remove('open');
document.addEventListener('keydown',e=>{if(!$('#view').classList.contains('open'))return;if(e.key==='ArrowLeft')show(cur-1);if(e.key==='ArrowRight')show(cur+1);if(e.key==='Escape')$('#close').onclick()});
$('#f').onsubmit=e=>{e.preventDefault();load(false)};$('#more').onclick=()=>load(true);$('[name=set]').onchange=syncSet;
(async()=>{const s=await (await fetch('/api/status')).json();const sel=$('[name=camera]');for(const c of s.cameras)sel.insertAdjacentHTML('beforeend','<option>'+esc(c.name)+'</option>');
  for(const l of (s.label_order||[]))$('[name=label]').insertAdjacentHTML('beforeend','<option>'+esc(l)+'</option>');
  sets=await (await fetch('/api/baseline')).json();for(const b of sets)$('[name=set]').insertAdjacentHTML('beforeend','<option value="'+esc(b.date)+'">baseline '+esc(b.date)+' ('+b.n+')</option>');
  const u=new URLSearchParams(location.search);for(const [k,v] of u){const el=$('[name='+k+']');if(!el)continue;if(el.type==='checkbox')el.checked=v==='1';else el.value=v}
  syncSet();if(u.get('model'))$('[name=model]').value=u.get('model');load(false)})();
</script></body></html>`;
