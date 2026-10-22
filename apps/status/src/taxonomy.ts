// The taxonomy editor (docs/TAXONOMY-UI.md §3): draft in the browser, validated and scored on the server, applied
// as a new version. Plain HTML + inline script like the other pages.
export const taxonomyPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ranch taxonomy</title>
<style>
  :root{color-scheme:dark;--bg:#0f1115;--card:#171a21;--line:#262a33;--fg:#e6e8ee;--dim:#8b93a7;--ok:#3ecf8e;--bad:#ff6b6b;--warn:#f5b84b}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,system-ui,sans-serif;padding:12px 16px;max-width:1200px}
  h1{font-size:16px;margin:0 0 8px} h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:18px 0 8px} a{color:#9ecbff} .muted{color:var(--dim)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px}
  .grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
  input,select,button,textarea{background:#0f1115;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 7px;font:inherit} input[type=number]{width:70px}
  button{cursor:pointer;background:#1f2430} button.primary{background:#2b4a7a} button.danger{background:#4a2b2b} button:disabled{opacity:.5;cursor:default}
  .chip{display:inline-flex;align-items:center;gap:4px;background:#242a36;border-radius:12px;padding:2px 8px;margin:2px;font-size:13px} .chip b{cursor:pointer;color:var(--dim)} .chip b:hover{color:var(--bad)}
  table{width:100%;border-collapse:collapse} td,th{padding:4px 6px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle} th{color:var(--dim);font-weight:500}
  .bar{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap;z-index:2}
  .banner{background:#3d2f12;color:var(--warn);padding:6px 10px;border-radius:6px;margin:8px 0} .ok{color:var(--ok)} .bad{color:var(--bad)}
  #errors{color:var(--bad);white-space:pre-wrap} .scorebox{overflow:auto} .delta-up{color:var(--ok)} .delta-down{color:var(--bad)}
</style></head><body>
<h1>ranch taxonomy <a href="/" class="muted" style="font-weight:400;font-size:13px">· status</a> <a href="/frames" class="muted" style="font-weight:400;font-size:13px">· frames</a></h1>
<div class="bar">
  <span id="active" class="muted">loading…</span>
  <span style="flex:1"></span>
  <input id="token" placeholder="write token" size="22" type="password" title="RANCH_STATUS_WRITE_TOKEN from ~/.config/ranch/status.env on the mini">
  <button id="validate">Validate</button>
  <button id="score">Score draft</button>
  <button id="apply" class="primary">Apply…</button>
  <button id="reset">Discard draft</button>
</div>
<div id="banner"></div>
<div id="errors"></div>
<div id="scoreout"></div>
<h2>Classes</h2><div class="grid" id="classes"></div>
<h2>Ignored (never boxed)</h2><div class="card" id="ignored"></div>
<h2>Model mappings <span class="muted" style="text-transform:none;letter-spacing:0">raw label → class / subclass at a threshold; unmapped raw labels are dropped</span></h2><div id="mappings"></div>
<h2>Label order</h2><div class="card" id="order"></div>
<h2>Scoring map <span class="muted" style="text-transform:none;letter-spacing:0">subclass → the label a family can express, for scoring gold labels</span></h2><div id="scoring"></div>
<h2>History</h2><div class="card" id="history"></div>
<script>
const $=s=>document.querySelector(s); const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let active=null, draft=null, meta=null;
const deep=o=>JSON.parse(JSON.stringify(o)); const dirty=()=>JSON.stringify(draft)!==JSON.stringify(active);
try{$('#token').value=sessionStorage.getItem('ranch_token')||''}catch{}
$('#token').onchange=()=>{try{sessionStorage.setItem('ranch_token',$('#token').value)}catch{}};
const hdr=()=>({'content-type':'application/json','x-ranch-token':$('#token').value});
const allSubs=()=>Object.entries(draft.classes).flatMap(([c,d])=>d.subclasses.map(s=>[c,s]));
const storedLabel=(c,s)=>c==='person'?'person':s;
function render(){
  const ver=meta.active; $('#active').innerHTML='active <b>v'+ver.id+'</b> <span class="muted">'+esc(ver.author)+' · '+esc((ver.created||'').slice(0,16).replace('T',' '))+(ver.gate?' · gate '+ver.gate:'')+'</span>'+(dirty()?' · <span class="bad">draft has changes</span>':'');
  $('#banner').innerHTML=meta.matches_repo?'':'<div class="banner">taxonomy v'+ver.id+' is not in git: run <code>make taxonomy-pull</code> on the laptop and commit, or the next provision supersedes it.</div>';
  $('#classes').innerHTML=Object.entries(draft.classes).map(([c,d])=>'<div class="card"><b>'+esc(c)+'</b><div>'+d.subclasses.map(s=>'<span class="chip">'+esc(s)+' <b data-rm-sub="'+esc(c)+'|'+esc(s)+'">×</b></span>').join('')+
    '<form data-add-sub="'+esc(c)+'" style="display:inline"><input placeholder="new subclass" size="12" pattern="[a-z][a-z0-9_]*"> <button>add</button></form></div>'+
    (d.attribute?'<div class="muted" style="margin-top:6px">'+esc(d.attribute.name)+': '+(d.attribute.values?d.attribute.values.map(v=>'<span class="chip">'+esc(v)+' <b data-rm-attr="'+esc(c)+'|'+esc(v)+'">×</b></span>').join('')+'<form data-add-attr="'+esc(c)+'" style="display:inline"><input placeholder="new value" size="10" pattern="[a-z][a-z0-9_]*"> <button>add</button></form>':'free text')+'</div>':'')+'</div>').join('');
  $('#ignored').innerHTML=draft.ignored.map(s=>'<span class="chip">'+esc(s)+' <b data-rm-ign="'+esc(s)+'">×</b></span>').join('')+'<form data-add-ign style="display:inline"><input placeholder="never boxed" size="12" pattern="[a-z][a-z0-9_]*"> <button>add</button></form>';
  const subOpts=(sel)=>allSubs().map(([c,s])=>'<option value="'+c+'/'+s+'"'+(sel===c+'/'+s?' selected':'')+'>'+c+' / '+s+'</option>').join('');
  $('#mappings').innerHTML=Object.entries(draft.mappings).map(([fam,map])=>'<div class="card"><b>'+esc(fam)+'</b>'+(meta.detector_family===fam?' <span class="ok">· active in the detector ('+esc(meta.detector_model||'')+')</span>':'')+
    '<table><thead><tr><th>raw label</th><th>class / subclass</th><th>stored as</th><th>threshold</th><th>note</th><th></th></tr></thead><tbody>'+
    Object.entries(map).map(([raw,m])=>'<tr><td><code>'+esc(raw)+'</code></td><td><select data-map="'+fam+'|'+esc(raw)+'|sub">'+subOpts(m.class+'/'+m.subclass)+'</select></td><td class="muted">'+esc(storedLabel(m.class,m.subclass))+'</td><td><input type="number" step="0.05" min="0" max="1" value="'+m.threshold+'" data-map="'+fam+'|'+esc(raw)+'|thr"></td><td><input value="'+esc(m.note||'')+'" size="40" data-map="'+fam+'|'+esc(raw)+'|note"></td><td><button data-rm-map="'+fam+'|'+esc(raw)+'">×</button></td></tr>').join('')+
    '</tbody></table><form data-add-map="'+fam+'" style="margin-top:6px"><input placeholder="raw label (model class)" size="18"> <select>'+subOpts('')+'</select> <input type="number" step="0.05" min="0" max="1" value="0.5"> <button>add mapping</button></form></div>').join('')+
    '<form data-add-family class="card"><input placeholder="new model family (e.g. ranch_v1)" size="24" pattern="[a-z][a-z0-9_]*"> <button>add family</button></form>';
  $('#order').innerHTML=draft.label_order.map((l,i)=>'<span class="chip">'+esc(l)+' <b data-ord="'+i+'|-1">▲</b><b data-ord="'+i+'|1">▼</b> <b data-rm-ord="'+i+'">×</b></span>').join('')+
    '<form data-add-ord style="display:inline"><select>'+['person',...new Set(allSubs().map(x=>x[1]))].filter(l=>!draft.label_order.includes(l)).map(l=>'<option>'+esc(l)+'</option>').join('')+'</select> <button>add</button></form>';
  $('#scoring').innerHTML=Object.keys(draft.mappings).map(fam=>{const labels=[...new Set(Object.values(draft.mappings[fam]).map(m=>storedLabel(m.class,m.subclass)))];const sm=draft.scoring_map[fam]||{};
    return '<div class="card"><b>'+esc(fam)+'</b><table><tbody>'+Object.entries(sm).map(([s,l])=>'<tr><td>'+esc(s)+'</td><td>→ <select data-sm="'+fam+'|'+esc(s)+'">'+labels.map(x=>'<option'+(x===l?' selected':'')+'>'+esc(x)+'</option>').join('')+'</select></td><td><button data-rm-sm="'+fam+'|'+esc(s)+'">×</button></td></tr>').join('')+
    '</tbody></table><form data-add-sm="'+fam+'" style="margin-top:6px"><select>'+allSubs().map(x=>x[1]).filter(s=>!(s in sm)).map(s=>'<option>'+esc(s)+'</option>').join('')+'</select> → <select>'+labels.map(x=>'<option>'+esc(x)+'</option>').join('')+'</select> <button>add</button></form></div>'}).join('');
  $('#history').innerHTML='<table><thead><tr><th>v</th><th>created</th><th>author</th><th>note</th><th>gate</th><th>horse R / FPPF</th><th></th></tr></thead><tbody>'+meta.versions.map(v=>{const s=v.score_summary;return '<tr'+(v.active?' style="color:var(--ok)"':'')+'><td>v'+v.id+'</td><td>'+esc((v.created||'').slice(0,16).replace('T',' '))+'</td><td>'+esc(v.author)+'</td><td>'+esc(v.note||'')+'</td><td>'+esc(v.gate||'')+'</td><td>'+(s?s.horse_recall.toFixed(2)+' / '+s.fppf_all.toFixed(2):'')+'</td><td>'+(v.active?'active':'<button data-load="'+v.id+'">load as draft</button> <button data-revert="'+v.id+'">revert to</button>')+'</td></tr>'}).join('')+'</tbody></table>';
}
async function load(){const r=await (await fetch('/api/taxonomy')).json(); meta=r; active=r.taxonomy; if(!draft)draft=deep(active); render();}
document.addEventListener('click',e=>{const t=e.target; let a;
  if((a=t.dataset.rmSub)){const [c,s]=a.split('|');draft.classes[c].subclasses=draft.classes[c].subclasses.filter(x=>x!==s);render()}
  else if((a=t.dataset.rmAttr)){const [c,v]=a.split('|');draft.classes[c].attribute.values=draft.classes[c].attribute.values.filter(x=>x!==v);render()}
  else if((a=t.dataset.rmIgn)){draft.ignored=draft.ignored.filter(x=>x!==a);render()}
  else if((a=t.dataset.rmMap)){const [f,raw]=a.split('|');delete draft.mappings[f][raw];render()}
  else if((a=t.dataset.rmSm)){const [f,s]=a.split('|');delete draft.scoring_map[f][s];render()}
  else if((a=t.dataset.rmOrd)){draft.label_order.splice(+a,1);render()}
  else if((a=t.dataset.ord)){const [i,d]=a.split('|').map(Number);const j=i+d;if(j<0||j>=draft.label_order.length)return;[draft.label_order[i],draft.label_order[j]]=[draft.label_order[j],draft.label_order[i]];render()}
  else if((a=t.dataset.load)){fetch('/api/taxonomy/versions/'+a).then(r=>r.json()).then(v=>{draft=v.taxonomy;render()})}
  else if((a=t.dataset.revert)){const note=prompt('Revert to v'+a+': note');if(note===null)return;post('/api/taxonomy/revert',{id:+a,note}).then(r=>{if(r&&r.ok){draft=null;load()}})}
});
document.addEventListener('submit',e=>{e.preventDefault();const f=e.target;const d=f.dataset;const inp=f.querySelectorAll('input,select');
  if(d.addSub!==undefined){const v=inp[0].value.trim();if(v&&!draft.classes[d.addSub].subclasses.includes(v))draft.classes[d.addSub].subclasses.push(v)}
  else if(d.addAttr!==undefined){const v=inp[0].value.trim();if(v)draft.classes[d.addAttr].attribute.values.push(v)}
  else if(d.addIgn!==undefined){const v=inp[0].value.trim();if(v&&!draft.ignored.includes(v))draft.ignored.push(v)}
  else if(d.addMap!==undefined){const raw=inp[0].value.trim();const [c,s]=inp[1].value.split('/');if(raw)draft.mappings[d.addMap][raw]={class:c,subclass:s,threshold:+inp[2].value}}
  else if(d.addFamily!==undefined){const v=inp[0].value.trim();if(v&&!draft.mappings[v]){draft.mappings[v]={};draft.scoring_map[v]={}}}
  else if(d.addOrd!==undefined){const v=inp[0].value;if(v)draft.label_order.push(v)}
  else if(d.addSm!==undefined){draft.scoring_map[d.addSm]=draft.scoring_map[d.addSm]||{};draft.scoring_map[d.addSm][inp[0].value]=inp[1].value}
  render()});
document.addEventListener('change',e=>{const t=e.target;let a;
  if((a=t.dataset.map)){const [f,raw,k]=a.split('|');const m=draft.mappings[f][raw];if(k==='sub'){const [c,s]=t.value.split('/');m.class=c;m.subclass=s}else if(k==='thr')m.threshold=+t.value;else if(k==='note'){if(t.value)m.note=t.value;else delete m.note}render()}
  else if((a=t.dataset.sm)){const [f,s]=a.split('|');draft.scoring_map[f][s]=t.value}
});
async function post(path,body){const r=await fetch(path,{method:'POST',headers:hdr(),body:JSON.stringify(body)});const j=await r.json().catch(()=>({error:r.statusText}));
  if(!r.ok){$('#errors').textContent=(j.errors||[j.error||('HTTP '+r.status)]).join('\\n');return null}$('#errors').textContent='';return j}
$('#validate').onclick=async()=>{const r=await post('/api/taxonomy/validate',{taxonomy:draft});if(r)$('#errors').innerHTML='<span class="ok">valid</span>'};
$('#reset').onclick=()=>{draft=deep(active);render();$('#errors').textContent='';$('#scoreout').innerHTML=''};
function scoreTable(r){const rows=[['horse recall',x=>x.horse_recall,'[%s]'],['horse AP',x=>x.horse_ap],['horse precision',x=>x.horse_precision],['FPPF all',x=>x.fppf_all,null,true],['count-exact',x=>x.count_exact],['horse recall day',x=>x.day_recall],['horse recall night',x=>x.night_recall]];
  const f=v=>v==null?'–':v.toFixed(2); const d=(a,b,lower)=>{if(a==null||b==null)return '';const x=b-a;if(Math.abs(x)<1e-9)return '';const good=lower?x<0:x>0;return ' <span class="'+(good?'delta-up':'delta-down')+'">('+(x>0?'+':'')+x.toFixed(2)+')</span>'};
  let h='<div class="card scorebox"><b>'+esc(r.model)+'</b> on '+esc(r.frames_dataset)+' × '+esc(r.labels_dataset)+' · gate <b class="'+(r.gate.pass?'ok':'bad')+'">'+(r.gate.pass?'pass':'FAIL')+'</b>'+(r.gate.reasons.length?' <span class="muted">'+esc(r.gate.reasons.join('; '))+'</span>':'')+
    '<table><thead><tr><th>metric</th><th>active v'+r.active_version+'</th><th>draft</th></tr></thead><tbody>'+rows.map(([n,g,,lower])=>'<tr><td>'+n+'</td><td>'+f(g(r.active))+(n==='horse recall'&&r.active.horse_ci?' <span class="muted">['+f(r.active.horse_ci.lo)+'–'+f(r.active.horse_ci.hi)+']</span>':'')+'</td><td>'+f(g(r.draft))+d(g(r.active),g(r.draft),lower)+(n==='horse recall'&&r.draft.horse_ci?' <span class="muted">['+f(r.draft.horse_ci.lo)+'–'+f(r.draft.horse_ci.hi)+']</span>':'')+'</td></tr>').join('')+'</tbody></table>'+
    '<table style="margin-top:8px"><thead><tr><th>class</th><th>gold</th><th>active P / R</th><th>draft P / R</th></tr></thead><tbody>'+Object.keys({...r.active.classes,...r.draft.classes}).map(c=>{const a=r.active.classes[c],b=r.draft.classes[c];return '<tr><td>'+esc(c)+'</td><td>'+(b?b.gold:a?a.gold:'')+'</td><td>'+(a?f(a.precision)+' / '+f(a.recall):'–')+'</td><td>'+(b?f(b.precision)+d(a&&a.precision,b.precision)+' / '+f(b.recall)+d(a&&a.recall,b.recall):'–')+'</td></tr>'}).join('')+'</tbody></table><div class="muted" style="margin-top:6px">'+r.ms+' ms</div></div>';
  return h}
let lastScore=null;
$('#score').onclick=async()=>{$('#score').disabled=true;$('#scoreout').innerHTML='<div class="muted">scoring…</div>';const r=await post('/api/taxonomy/score',{taxonomy:draft});$('#score').disabled=false;if(!r){$('#scoreout').innerHTML='';return}lastScore=r;$('#scoreout').innerHTML=scoreTable(r)};
$('#apply').onclick=async()=>{if(!dirty()){alert('no changes');return}const note=prompt('Apply as a new version. Note (what and why):');if(!note)return;
  const r=await post('/api/taxonomy/apply',{taxonomy:draft,note,score:lastScore&&JSON.stringify(lastScore.draft_taxonomy)===JSON.stringify(draft)?lastScore:null});if(r&&r.ok){draft=null;lastScore=null;$('#scoreout').innerHTML='';await load()}};
load();
</script></body></html>`;
