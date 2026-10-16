// The page. One HTML string, inline CSS and script; data comes from /api/status and the SSE stream.
export const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ranch status</title>
<style>
  :root{color-scheme:dark;--bg:#0f1115;--card:#171a21;--line:#262a33;--fg:#e6e8ee;--dim:#8b93a7;--ok:#3ecf8e;--bad:#ff6b6b;--warn:#f5b84b}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,system-ui,sans-serif;padding:12px 16px}
  h1{font-size:16px;margin:0 0 4px} h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:20px 0 8px}
  .muted{color:var(--dim)} .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:hidden}
  .card img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:4px;background:#000;display:block;margin-bottom:6px}
  .badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
  .on{background:#143d2c;color:var(--ok)} .off{background:#3d1818;color:var(--bad)} .warnb{background:#3d2f12;color:var(--warn)}
  table{width:100%;border-collapse:collapse} td,th{padding:4px 6px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
  th{color:var(--dim);font-weight:500} code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--dim);word-break:break-all}
  .kv{display:flex;flex-wrap:wrap;gap:6px 18px} .kv b{font-weight:600}
  .bar{height:6px;background:#2a3b55;border-radius:3px;margin-top:3px} .bar i{display:block;height:100%;background:#5b8def;border-radius:3px}
  #ticker{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;max-height:260px;overflow:auto;white-space:nowrap}
  #ticker div{padding:1px 0;border-bottom:1px solid var(--line)} .t{color:var(--dim)} .topic{color:#9ecbff}
  @media (max-width:600px){body{padding:10px} td,th{padding:3px 4px}}
</style></head><body>
<h1>ranch-ai <span id="hdr" class="muted"></span></h1>
<div id="host" class="kv muted"></div>
<h2>Daemons</h2><div class="card" style="padding:0"><table id="daemons"><thead><tr><th>daemon</th><th>pid</th><th>exit</th><th>mqtt status</th><th>last log line</th></tr></thead><tbody></tbody></table></div>
<h2>Cameras</h2><div id="cams" class="grid"></div>
<h2>Detections, last hour</h2><div id="labels" class="card"></div>
<h2>Events, latest</h2><div class="card" style="padding:0"><table id="events"><thead><tr><th>ts</th><th>camera</th><th>type</th><th>conf</th><th>tier</th><th>verdict</th></tr></thead><tbody></tbody></table></div>
<h2>Live MQTT <span id="upd" class="badge">updated …</span> <span id="sse" class="badge off">connecting</span></h2><div id="ticker" class="card"></div>
<script>
const $=s=>document.querySelector(s); const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const age=s=>s==null?'never':s<60?s+' s':s<3600?Math.round(s/60)+' min':(s/3600).toFixed(1)+' h';
const local=iso=>iso?new Date(iso).toLocaleString('sv-SE').replace(' ','T').slice(5,19):'';
function render(d){
  lastStatusAt=Date.now(); $('#hdr').textContent='· '+local(d.ts);
  const seedWin=d.seed.window_start?Math.min(100,Math.round(100*(Date.now()-new Date(d.seed.window_start))/(d.seed.window_hours*3600e3))):null;
  $('#host').innerHTML=['up <b>'+age(d.uptime_s)+'</b>','load <b>'+d.load.join(' ')+'</b>','disk free <b>'+d.disk_free_gb+' / '+d.disk_total_gb+' GB</b>',
    'frames <b>'+d.totals.frames+'</b>','detections <b>'+d.totals.detections+'</b>','events <b>'+d.totals.events+'</b>',
    'seed frames <b>'+d.seed.total+'</b>'+(seedWin!=null?' ('+seedWin+'% of '+d.seed.window_hours+' h window)':'')].map(x=>'<span>'+x+'</span>').join('');
  $('#daemons tbody').innerHTML=d.daemons.map(x=>{const s=x.status||{};const st=Object.entries(s).filter(([k])=>!['ts','pid','cameras'].includes(k)).map(([k,v])=>k+'='+v).join(' ');
    return '<tr><td>'+esc(x.label.replace('com.ranch.',''))+'</td><td>'+(x.pid?'<span class="badge on">'+x.pid+'</span>':'<span class="badge off">down</span>')+'</td><td>'+x.last_exit+'</td><td><code>'+esc(st)+'</code></td><td><code>'+esc(x.log)+'</code></td></tr>'}).join('');
  $('#cams').innerHTML=d.cameras.map(c=>'<div class="card"><img src="/api/frame/'+encodeURIComponent(c.name)+'?t='+Math.floor(Date.now()/15000)+'" alt="" loading="lazy" onerror="this.style.opacity=.2">'
    +'<div><b>'+esc(c.name)+'</b> <span class="badge '+(c.online?'on':'off')+'">'+(c.online?'online':'offline')+'</span></div>'
    +'<div class="muted">last frame '+age(c.last_frame_age_s)+' ago · '+(c.frames_10m/10).toFixed(1)+' frames/min</div>'
    +'<div>horses: <b>'+(c.horse_last_min==null?'–':c.horse_last_min)+'</b> <span class="muted">· seed '+c.seed_frames+'</span></div>'
    +'<div class="muted">'+esc(c.model||'')+' '+esc(c.fw||'')+' '+esc(c.ip||'')+'</div></div>').join('');
  const max=Math.max(1,...d.labels_1h.map(l=>l.n));
  $('#labels').innerHTML=d.labels_1h.length?d.labels_1h.map(l=>'<div><span>'+esc(l.label)+' <b>'+l.n+'</b> <span class="muted">avg '+l.conf+'</span></span><div class="bar"><i style="width:'+(100*l.n/max)+'%"></i></div></div>').join(''):'<span class="muted">none</span>';
  $('#events tbody').innerHTML=d.events.length?d.events.map(e=>'<tr><td>'+local(e.ts)+'</td><td>'+esc(e.camera)+'</td><td>'+esc(e.type)+'</td><td>'+e.confidence.toFixed(2)+'</td><td>'+e.tier_decided+'</td><td>'+esc(e.verdict||'')+'</td></tr>').join(''):'<tr><td colspan="6" class="muted">none yet (Phase 2)</td></tr>';
}
let lastStatusAt=0, es=null;
async function refresh(){try{render(await (await fetch('/api/status',{cache:'no-store'})).json())}catch(e){console.error(e)}}
function connect(){
  if(es){try{es.close()}catch(e){}}
  es=new EventSource('/api/events');
  es.onopen=()=>{$('#sse').className='badge on';$('#sse').textContent='live'};
  es.onerror=()=>{$('#sse').className='badge off';$('#sse').textContent='reconnecting'};
  es.addEventListener('status',ev=>render(JSON.parse(ev.data)));
  es.addEventListener('mqtt',ev=>{const m=JSON.parse(ev.data);const t=$('#ticker');const row=document.createElement('div');
    row.innerHTML='<span class="t">'+new Date().toLocaleTimeString('en-GB')+'</span> <span class="topic">'+esc(m.topic)+'</span> '+esc(typeof m.payload==='string'?m.payload:JSON.stringify(m.payload)).slice(0,220);
    t.prepend(row); while(t.children.length>30)t.lastChild.remove()});
}
// Liveness. A suspended tab or a sleeping device leaves the SSE connection silently dead (Safari never
// reconnects it), so: tick the "updated N s ago" badge, poll /api/status every 30 s regardless, and if no
// status arrived for 45 s rebuild the EventSource. Coming back to the foreground forces a refresh too.
setInterval(()=>{const s=Math.round((Date.now()-lastStatusAt)/1000);const b=$('#upd');b.textContent='updated '+s+' s ago';b.className='badge '+(s>45?'off':'on');
  if(lastStatusAt&&s>45){connect();refresh()}},5000);
setInterval(refresh,30000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){refresh();if(!es||es.readyState===2)connect()}});
window.addEventListener('pageshow',()=>{refresh();if(!es||es.readyState===2)connect()});
refresh(); connect();
</script></body></html>`;
