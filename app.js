"use strict";
/* Pick'em '26 — static page (GitHub Pages) + Supabase for picks.
   Schedule, roster and results are JSON files in this repo; results are refreshed from ESPN by a
   scheduled GitHub Action. Picks save straight to the database as you tap — the database refuses
   changes to games that have kicked off and keeps everyone's picks hidden until kickoff. */
const TEAM = {
 ARI:["#97233F","#fff"], ATL:["#A71930","#fff"], BAL:["#241773","#fff"], BUF:["#00338D","#fff"],
 CAR:["#0085CA","#fff"], CHI:["#0B162A","#E64B17"], CIN:["#FB4F14","#111"], CLE:["#311D00","#FF3C00"],
 DAL:["#003594","#fff"], DEN:["#FB4F14","#0A2343"], DET:["#0076B6","#fff"], GB:["#203731","#FFB612"],
 HOU:["#03202F","#A71930"], IND:["#002C5F","#fff"], JAX:["#006778","#D7A22A"], KC:["#E31837","#FFB81C"],
 LV:["#000000","#A5ACAF"], LAC:["#0080C6","#FFC20E"], LAR:["#003594","#FFA300"], MIA:["#008E97","#FC4C02"],
 MIN:["#4F2683","#FFC62F"], NE:["#002244","#C60C30"], NO:["#101820","#D3BC8D"], NYG:["#0B2265","#A71930"],
 NYJ:["#125740","#fff"], PHI:["#004C54","#A5ACAF"], PIT:["#101820","#FFB612"], SF:["#AA0000","#B3995D"],
 SEA:["#002244","#69BE28"], TB:["#D50A0A","#FF7900"], TEN:["#0C2340","#4B92DB"], WSH:["#5A1414","#FFB612"]
};
const GAME_MS = 4*3600*1000;
const MISSING_GUESS_ERR = 100;
const SAVE_DELAY_MS = 600;
const WEEK_TTL_MS = 60*1000;
const CFG = window.PICKEM_CONFIG || {};

const app = document.getElementById("app");
const esc = s => String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const now = () => Date.now();
const ls = { get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }, set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }, del(k){ try{ localStorage.removeItem(k); }catch(e){} } };

const S = {
  schedule:{}, players:[], results:{}, week:1, tab:"picks", me:"",
  saved:{picks:{}, guess:""}, local:{}, localGuess:"", touched:new Set(), guessTouched:false,
  loadingMine:false, save:"idle", saveMsg:"", weeks:{}, error:""
};

/* ---------- data access ---------- */
const configured = () => /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(CFG.supabaseUrl||"") && !!CFG.supabaseAnonKey;
async function db(path, opts={}){
  const res = await fetch(CFG.supabaseUrl.replace(/\/$/,"")+"/rest/v1/"+path, {
    ...opts,
    headers:{ apikey:CFG.supabaseAnonKey, authorization:"Bearer "+CFG.supabaseAnonKey, "content-type":"application/json", ...(opts.headers||{}) }
  });
  if(!res.ok){ let msg="HTTP "+res.status; try{ const j=await res.json(); msg=j.message||msg; }catch(e){} throw new Error(msg); }
  return res.status===204 ? null : res.json();
}
const rpc = (fn, body) => db("rpc/"+fn, { method:"POST", body:JSON.stringify(body) });
const json = p => fetch(p+"?v="+now(), {cache:"no-store"}).then(r=>{ if(!r.ok) throw new Error(p+": HTTP "+r.status); return r.json(); });

/* ---------- schedule helpers ---------- */
const started = g => now() >= Date.parse(g.kickoff);
const wkGames = w => (S.schedule[w]||{}).games||[];
const mnf = w => wkGames(w).find(g=>g.id===(S.schedule[w]||{}).mnfGameId);
const lockSig = () => S.week+":"+wkGames(S.week).map(g=>started(g)?1:0).join("");
const playerName = slug => { const p=S.players.find(x=>x.slug===slug); return p?p.name:slug; };
function currentWeek(){
  const weeks = Object.keys(S.schedule).map(Number).sort((a,b)=>a-b);
  for(const w of weeks){ if(now() < Date.parse(S.schedule[w].lastKickoff)+GAME_MS) return w; }
  return weeks[weeks.length-1];
}

/* ---------- a week's shared data: visible picks, visible guesses, who's submitted ---------- */
async function loadWeek(w, force){
  const c=S.weeks[w];
  if(!force && c && now()-c.at < WEEK_TTL_MS) return c;
  const ids=wkGames(w).map(g=>g.id);
  const [rows, guesses, status] = await Promise.all([
    ids.length ? db("picks?select=player,game_id,side&game_id=in.("+ids.join(",")+")") : [],
    db("guesses?select=player,mnf_guess&week=eq."+w),
    rpc("week_status", {p_week:w})
  ]);
  const picks={}, gs={}, st={};
  for(const r of rows){ (picks[r.player]=picks[r.player]||{})[r.game_id]=r.side; }
  for(const g of guesses) gs[g.player]=g.mnf_guess;
  for(const s of status) st[s.player]={picked:new Set(s.picked||[]), hasGuess:!!s.has_guess};
  return (S.weeks[w]={at:now(), picks, guesses:gs, status:st});
}
async function refreshWeeks(ws, force){
  try{ await Promise.all(ws.map(w=>loadWeek(w, force))); S.error=""; }
  catch(e){ S.error="Couldn't reach the pick database ("+e.message+")."; }
  render();
}
const finalWeeks = () => Object.keys(S.results).map(Number).filter(w=>S.results[w]&&S.results[w].final).sort((a,b)=>a-b);

/* ---------- my sheet: server copy + local edits not yet saved ---------- */
const draftKey = ()=>"pickem26-draft-"+pad(S.week)+"-"+S.me;
async function loadMine(){
  S.saved={picks:{}, guess:""}; S.local={}; S.localGuess=""; S.touched=new Set(); S.guessTouched=false;
  S.save="idle"; S.saveMsg="";
  if(!S.me) return render();
  const who=S.me, week=S.week;
  S.loadingMine=true; render();
  try{
    const r=await rpc("my_sheet", {p_player:who, p_week:week});
    if(who!==S.me||week!==S.week) return;
    S.saved={picks:r.picks||{}, guess:r.mnf_guess==null?"":String(r.mnf_guess)};
    S.error="";
  }catch(e){
    if(who!==S.me||week!==S.week) return;
    S.error="Couldn't load your saved picks ("+e.message+")."; S.save="error"; S.saveMsg=S.error;
  }
  S.loadingMine=false;
  S.local=Object.assign({}, S.saved.picks); S.localGuess=S.saved.guess;
  // Re-apply edits that never made it to the server (closed tab, dropped connection).
  try{
    const d=JSON.parse(ls.get(draftKey())||"null");
    if(d){
      for(const id of d.touched||[]){ const g=wkGames(S.week).find(x=>x.id===id); if(g&&!started(g)){ S.local[id]=d.picks[id]||null; S.touched.add(id); } }
      if(d.guessTouched){ S.localGuess=d.guess||""; S.guessTouched=true; }
    }
  }catch(e){}
  render();
  if(pendingChanges()) queueSave(0);
}
function saveDraft(){
  if(!S.me) return;
  if(!S.touched.size && !S.guessTouched) return ls.del(draftKey());
  ls.set(draftKey(), JSON.stringify({picks:S.local, touched:[...S.touched], guess:S.localGuess, guessTouched:S.guessTouched}));
}
function pendingChanges(){
  for(const id of S.touched) if((S.local[id]||null)!==(S.saved.picks[id]||null)) return true;
  return S.guessTouched && S.localGuess!==S.saved.guess;
}

let saveTimer=null, saving=false, saveAgain=false;
function queueSave(delay){ clearTimeout(saveTimer); saveTimer=setTimeout(doSave, delay==null?SAVE_DELAY_MS:delay); }
async function doSave(){
  if(saving){ saveAgain=true; return; }
  if(!S.me || S.loadingMine) return;
  if(!pendingChanges()){ S.touched.clear(); S.guessTouched=false; saveDraft(); return render(); }
  const who=S.me, week=S.week;
  const guessNum = S.localGuess==="" ? null : parseInt(S.localGuess,10);
  if(S.guessTouched && S.localGuess!=="" && (isNaN(guessNum)||guessNum<0||guessNum>150)){
    S.save="error"; S.saveMsg="Tiebreaker must be a number from 0 to 150."; return render();
  }
  const sent={}; for(const id of S.touched) sent[id]=S.local[id]||null;
  const sentGuess=S.guessTouched;
  saving=true; S.save="saving"; S.saveMsg=""; render();
  try{
    const r=await rpc("save_sheet", {p_player:who, p_week:week, p_picks:sent, p_guess:guessNum, p_set_guess:sentGuess});
    const fresh=await rpc("my_sheet", {p_player:who, p_week:week});
    if(who===S.me && week===S.week){
      S.saved={picks:fresh.picks||{}, guess:fresh.mnf_guess==null?"":String(fresh.mnf_guess)};
      // Anything the server refused (kicked off meanwhile) snaps back to what's on record.
      for(const id of r.locked||[]){ if(id==="mnf"){ S.localGuess=S.saved.guess; S.guessTouched=false; } else { S.local[id]=S.saved.picks[id]||null; S.touched.delete(id); } }
      // Drop touched entries that now match the server; keep ones edited while this save was in flight.
      for(const id of [...S.touched]) if((S.local[id]||null)===(S.saved.picks[id]||null)) S.touched.delete(id);
      if(S.guessTouched && S.localGuess===S.saved.guess) S.guessTouched=false;
      saveDraft();
      const nLocked=(r.locked||[]).length;
      S.save=nLocked?"locked":"saved";
      S.saveMsg=nLocked?(nLocked===1?"1 change":nLocked+" changes")+" didn't count — kickoff had passed.":"";
      S.error="";
      delete S.weeks[week];
    }
  }catch(e){
    S.save="error"; S.saveMsg="Couldn't save ("+e.message+"). Your picks are kept on this device.";
  }finally{
    saving=false;
    render();
    if(saveAgain || (S.save!=="error" && pendingChanges())){ saveAgain=false; queueSave(); }
  }
}

/* ---------- scoring ---------- */
function scoreWeek(w){
  const res=S.results[w], wd=S.weeks[w]; if(!res||!res.winners||!wd) return null;
  const rows={};
  for(const p of S.players){
    const picks=wd.picks[p.slug]||{}, guess=wd.guesses[p.slug];
    let pts=0;
    for(const [gid,side] of Object.entries(picks)){ const win=res.winners[gid]; if(win&&win!=="TIE"&&win===side) pts++; }
    const err=(guess!=null&&res.mnfTotal!=null)?Math.abs(guess-res.mnfTotal):null;
    rows[p.slug]={pts,err,picked:Object.keys(picks).length>0};
  }
  const adj=res.adjust||{};
  for(const [slug,a] of Object.entries(adj)){ if(rows[slug]&&a&&a.pts){ rows[slug].pts+=a.pts; rows[slug].adj=a; } }
  const played=Object.values(rows).filter(r=>r.picked);
  let winners=[];
  if(res.final&&played.length){
    const max=Math.max(...played.map(r=>r.pts));
    let cands=Object.entries(rows).filter(([,r])=>r.picked&&r.pts===max);
    if(cands.length>1&&res.mnfTotal!=null){
      const best=Math.min(...cands.map(([,r])=>r.err==null?Infinity:r.err));
      if(best<Infinity) cands=cands.filter(([,r])=>(r.err==null?Infinity:r.err)===best);
    }
    winners=cands.map(([s])=>s);
  }
  return {rows,winners,final:!!res.final};
}
function standings(){
  const t={};
  for(const p of S.players) t[p.slug]={name:p.name,slug:p.slug,pts:0,wins:0,err:0,weeks:{},last:null};
  const finals=finalWeeks();
  for(const w of finals){
    const sw=scoreWeek(w); if(!sw) return null; // week data still loading
    for(const p of S.players){
      const r=sw.rows[p.slug];
      t[p.slug].pts+=r.pts; t[p.slug].weeks[w]=r.pts; t[p.slug].last=r.pts;
      t[p.slug].err+=(r.err==null?MISSING_GUESS_ERR:r.err);
      if(sw.winners.includes(p.slug)) t[p.slug].wins++;
    }
  }
  const list=Object.values(t).sort((a,b)=>b.pts-a.pts||b.wins-a.wins||a.err-b.err||a.name.localeCompare(b.name));
  let rank=0,prev=null;
  list.forEach((r,i)=>{ const key=r.pts+"/"+r.wins+"/"+r.err; if(key!==prev){rank=i+1;prev=key;} r.rank=rank; });
  return {list,weeksScored:finals};
}

/* ---------- render ---------- */
const fmtDay=new Intl.DateTimeFormat(undefined,{weekday:"short",month:"short",day:"numeric"});
const fmtTime=new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"});

function render(){
  if(!configured()){ app.innerHTML='<div class="offline"><b>Not connected yet.</b><p>Fill in <span class="mono">config.js</span> with the Supabase project URL and anon key.</p></div>'; return; }
  const w=S.week, sch=S.schedule[w];
  if(!sch){ app.innerHTML='<p class="empty">'+(S.error?esc(S.error):'Warming up&hellip;')+'</p>'; return; }
  const focus=document.activeElement&&document.activeElement.id==="guess";
  let h='<div class="controls"><div class="weeknav">'
    +'<button class="arrow" data-nav="-1" aria-label="Previous week" '+(w<=1?"disabled":"")+'>&larr;</button>'
    +'<div class="wk">Week '+w+'<small>'+fmtDay.format(new Date(sch.firstKickoff))+' &ndash; '+fmtDay.format(new Date(sch.lastKickoff))+'</small></div>'
    +'<button class="arrow" data-nav="1" aria-label="Next week" '+(w>=18?"disabled":"")+'>&rarr;</button></div>'
    +'<div class="tabs" role="tablist">'
    +['picks','board','standings'].map(t=>'<button role="tab" data-tab="'+t+'" aria-selected="'+(S.tab===t)+'">'+({picks:"My Picks",board:"Week Board",standings:"Standings"})[t]+'</button>').join("")
    +'</div></div>';
  if(S.error && S.save!=="error") h+='<div class="banner" role="alert">'+esc(S.error)+'</div>';
  h+=S.tab==="picks"?renderPicks():S.tab==="board"?renderBoard():renderStandings();
  h+='<div class="rules"><h2>House rules</h2><ul>'
    +'<li>Pick a winner for every game. Each correct pick is 1 point; NFL tie games score zero for everyone.</li>'
    +'<li>Each game locks at its own kickoff &mdash; you can still submit Sunday picks after Thursday has played.</li>'
    +'<li>Tiebreaker: closest guess at the Monday night combined final score. Skip it and you lose every tie.</li>'
    +'<li>Season ties break by weekly wins, then smallest season-long tiebreaker miss.</li>'
    +'<li>Commissioner adjustments (marked *) count toward season points but not weekly wins.</li>'
    +'<li>Picks save automatically as you tap. Everyone&#8217;s picks stay hidden until each game kicks off. Scores update on their own after games end. Honor system &mdash; play it straight.</li>'
    +'</ul></div>';
  app.innerHTML=h; wire();
  if(focus){ const g=document.getElementById("guess"); if(g){ g.focus(); const n=g.value.length; try{ g.setSelectionRange(n,n); }catch(e){} } }
}

function renderPicks(){
  const games=wkGames(S.week), m=mnf(S.week), res=S.results[S.week]||{};
  let h='<div class="who"><label for="who">Playing as</label><select id="who">'
    +'<option value=""'+(S.me?"":" selected")+' disabled>Choose your name&hellip;</option>'
    +S.players.map(p=>'<option value="'+esc(p.slug)+'"'+(p.slug===S.me?" selected":"")+'>'+esc(p.name)+'</option>').join("")
    +'</select></div>';
  if(!S.me) return h+'<p class="empty">Pick your name above to make your picks.</p>';
  if(S.loadingMine) return h+'<p class="empty">Loading your picks&hellip;</p>';
  h+='<div class="slate">'; let lastDay="";
  for(const g of games){
    const d=new Date(g.kickoff), day=fmtDay.format(d);
    if(day!==lastDay){ h+='<div class="daybreak">'+day+'</div>'; lastDay=day; }
    const lock=started(g), win=(res.winners||{})[g.id]||null, sc=(res.scores||{})[g.id]||null;
    const mine=lock ? (S.saved.picks[g.id]||null) : (S.local[g.id]||null);
    const st=win?'<span class="st final">Final</span>':lock?'<span class="st locked">&#128274; Locked</span>':'<span class="st">'+fmtTime.format(d)+'</span>';
    h+='<div class="game'+(!lock&&!mine?' pickme':'')+'"><div class="meta"><span>'+(g.neutral?esc(g.away)+' vs '+esc(g.home)+' &middot; neutral site':esc(g.away)+' at '+esc(g.home))+'</span>'+st+'</div>'
      +'<div class="matchup">'+teamBtn(g,"AWAY",mine,lock,win,sc)+'<span class="at">'+(g.neutral?"VS":"@")+'</span>'+teamBtn(g,"HOME",mine,lock,win,sc)+'</div></div>';
  }
  h+='</div>';
  if(m){
    const mlock=started(m);
    h+='<div class="tiebreak"><div style="flex:1"><div class="tlab">Tiebreaker &middot; MNF total</div>'
      +'<div class="tsub">Combined final score, '+esc(m.away)+' '+(m.neutral?'vs':'@')+' '+esc(m.home)+(mlock?' &middot; locked':'')+'</div></div>'
      +'<input id="guess" class="mono" type="number" inputmode="numeric" min="0" max="150" value="'+esc(mlock?S.saved.guess:S.localGuess)+'"'+(mlock?" disabled":"")+' aria-label="Combined final score guess"></div>';
  }
  const picked=games.filter(g=>(started(g)?S.saved.picks[g.id]:S.local[g.id])).length;
  const count=picked+'/'+games.length+' picked'+((m&&!S.localGuess)?' &middot; <b style="color:var(--accent)">no tiebreaker</b>':(m?' + tiebreaker':''));
  let note;
  if(S.save==="saving"||(pendingChanges()&&S.save!=="error")) note='<span class="savenote">Saving&hellip;</span>';
  else if(S.save==="error") note='<span class="savenote err" role="alert">'+esc(S.saveMsg||"Couldn't save.")+' <button class="retry" id="retry">Retry</button></span>';
  else if(S.save==="locked") note='<span class="savenote err" role="status">'+esc(S.saveMsg)+'</span>';
  else if(picked||S.saved.guess) note='<span class="savenote ok" role="status">Saved &#10003; &middot; '+count+'</span>';
  else note='<span class="savenote">Tap a team to pick &mdash; it saves automatically.</span>';
  h+='<div class="savebar">'+note+'</div>';
  return h;
}
function teamBtn(g,side,mine,lock,win,sc){
  const ab=side==="AWAY"?g.away:g.home, full=side==="AWAY"?g.awayFull:g.homeFull;
  const [bg,fg]=TEAM[ab]||["#555","#fff"]; const sel=mine===side;
  let cls="teambtn"; if(win){ if(win===side) cls+=" won"; else if(sel&&win!=="TIE") cls+=" lost"; }
  if(lock&&!sel) cls+=" dim";
  const scoreTxt=sc?'<span class="score">'+esc(String(side==="AWAY"?sc.away:sc.home))+'</span>':"";
  return '<button class="'+cls+'" data-g="'+esc(g.id)+'" data-s="'+side+'" aria-pressed="'+sel+'"'+(lock?" disabled":"")+' title="'+esc(full)+'">'
    +'<span class="abbr" style="background:'+bg+';color:'+fg+'">'+esc(ab)+'</span><span class="nm">'+esc(full.split(" ").pop())+'</span>'+scoreTxt+'</button>';
}

function renderSubs(games, wd){
  const total=games.length, ids=new Set(games.map(g=>g.id)); const inn=[], outn=[];
  for(const p of S.players){
    const st=wd.status[p.slug]; const n=st?[...st.picked].filter(id=>ids.has(id)).length:0;
    if(n>0) inn.push({p,n,noGuess:!st.hasGuess}); else outn.push(p);
  }
  const chip=(p,cls,inner)=>'<span class="chip '+cls+(p.slug===S.me?' me':'')+'">'+esc(p.name)+inner+'</span>';
  let h='<div class="subs"><div class="shead"><b>Who&#8217;s in &middot; Week '+S.week+'</b><span class="cnt">'+inn.length+' / '+S.players.length+' submitted</span></div>';
  h+='<div class="slab">Submitted</div><div class="chips">'+(inn.length?inn.map(({p,n,noGuess})=>chip(p,'in','<span class="n">'+n+'/'+total+'</span>'+(noGuess?'<span class="warn" title="No MNF tiebreaker guess">no TB</span>':''))).join(''):'<span class="chip out">Nobody yet</span>')+'</div>';
  h+='<div class="slab">Not yet</div><div class="chips">'+(outn.length?outn.map(p=>chip(p,'out','')).join(''):'<span class="chip in">Everyone&#8217;s in &#10003;</span>')+'</div></div>';
  return h;
}
function renderBoard(){
  const wd=S.weeks[S.week];
  if(!wd) return '<p class="empty">Loading the board&hellip;</p>';
  const games=wkGames(S.week), sw=scoreWeek(S.week), res=S.results[S.week]||{}, m=mnf(S.week), anyStarted=games.some(started);
  let h=renderSubs(games, wd);
  h+='<div class="boardwrap"><table class="board"><thead><tr><th class="pname">Player</th>';
  for(const g of games) h+='<th title="'+esc(g.awayFull+" at "+g.homeFull)+'">'+esc(g.away)+'<br>'+esc(g.home)+'</th>';
  h+='<th>MNF</th><th>Pts</th></tr></thead><tbody>';
  for(const p of S.players){
    const picks=wd.picks[p.slug]||{}, st=wd.status[p.slug], isWin=sw&&sw.winners.includes(p.slug);
    h+='<tr'+(isWin?' class="winner"':'')+'><td class="pname"'+(p.slug===S.me?' style="color:var(--accent)"':'')+'>'+esc(p.name)+'</td>';
    let pts=0;
    for(const g of games){
      const pick=picks[g.id]||null, hasPick=pick||(st&&st.picked.has(g.id));
      if(!hasPick){ h+='<td class="hid">&ndash;</td>'; continue; }
      if(!pick){ h+='<td class="hid" title="hidden until kickoff">&bull;</td>'; continue; }
      const ab=pick==="AWAY"?g.away:g.home, win=(res.winners||{})[g.id]; let cls="";
      if(win){ if(win!=="TIE"&&win===pick){cls="c";pts++;} else cls="x"; }
      h+='<td class="'+cls+'">'+esc(ab)+'</td>';
    }
    const guess=wd.guesses[p.slug];
    h+='<td class="mono">'+(guess!=null?guess:(st&&st.hasGuess?'&bull;':'&ndash;'))+'</td>';
    const adj=(res.adjust||{})[p.slug];
    h+='<td class="pts mono"'+(adj?' title="'+esc(adj.note||'adjustment')+'"':'')+'>'+((res.winners)?(adj?(pts+adj.pts)+'<small style="color:var(--muted)"> *</small>':pts):'&ndash;')+'</td></tr>';
  }
  h+='</tbody></table></div>';
  const adjs=Object.entries(res.adjust||{}).filter(([,a])=>a&&a.pts);
  if(adjs.length) h+='<p class="empty" style="margin:10px 0 0;font-size:12.5px">* '+adjs.map(([s,a])=>esc(playerName(s))+' +'+a.pts+(a.note?' ('+esc(a.note)+')':'')).join(' &middot; ')+'</p>';
  if(res.mnfTotal!=null) h+='<p class="empty" style="margin:10px 0 0">MNF total: <b class="mono">'+res.mnfTotal+'</b>'
    +(sw&&sw.winners.length?' &middot; Week '+S.week+' winner'+(sw.winners.length>1?'s':'')+': <b>'+sw.winners.map(s=>esc(playerName(s))).join(", ")+'</b> &#9733;':'')+'</p>';
  else if(!anyStarted) h+='<p class="empty" style="margin:10px 0 0">Picks stay hidden (&bull; = picked) until each game kicks off.</p>';
  return h;
}
function renderStandings(){
  const s=standings();
  if(!s) return '<p class="empty">Crunching the standings&hellip;</p>';
  const {list,weeksScored}=s;
  if(!weeksScored.length) return '<div class="stand"><table><thead><tr><th class="rk">#</th><th class="nm">Player</th><th class="tot">Pts</th></tr></thead><tbody>'
    +list.map((r,i)=>'<tr'+(r.slug===S.me?' class="me"':'')+'><td class="rk">'+(i+1)+'</td><td class="nm">'+esc(r.name)+'</td><td class="tot">0</td></tr>').join("")
    +'</tbody></table></div><p class="empty">Standings go live after Week 1 is scored.</p>';
  let h='<div class="stand"><table><thead><tr><th class="rk">#</th><th class="nm">Player</th><th>W</th><th>Last</th><th class="tot">Pts</th></tr></thead><tbody>';
  for(const r of list){
    h+='<tr data-x="'+esc(r.slug)+'"'+(r.slug===S.me?' class="me"':'')+'><td class="rk">'+r.rank+'</td><td class="nm">'+esc(r.name)+'</td><td class="mono">'+r.wins+'</td><td class="mono">'+(r.last==null?'&ndash;':r.last)+'</td><td class="tot">'+r.pts+'</td></tr>';
    h+='<tr class="detail" hidden data-d="'+esc(r.slug)+'"><td colspan="5">'+weeksScored.map(w=>'W'+w+': <b>'+(r.weeks[w]!=null?r.weeks[w]:0)+'</b>').join(' &middot; ')+' &middot; tiebreak miss: '+r.err+'</td></tr>';
  }
  return h+'</tbody></table></div><p class="empty">Tap a row for the week-by-week line. W = weekly wins &#9733;</p>';
}

/* ---------- events ---------- */
function showTab(){
  if(S.tab==="board") refreshWeeks([S.week]);
  else if(S.tab==="standings") refreshWeeks(finalWeeks());
}
function changeWeek(w){
  if(pendingChanges()){ clearTimeout(saveTimer); doSave(); }
  S.week=w; loadMine(); showTab();
}
function wire(){
  app.querySelectorAll("[data-nav]").forEach(b=>b.onclick=()=>changeWeek(Math.min(18,Math.max(1,S.week+Number(b.dataset.nav)))));
  app.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{ S.tab=b.dataset.tab; render(); showTab(); });
  const who=document.getElementById("who");
  if(who) who.onchange=()=>{ if(pendingChanges()){ clearTimeout(saveTimer); doSave(); } S.me=who.value; ls.set("pickem26-me",S.me); loadMine(); };
  app.querySelectorAll(".teambtn:not([disabled])").forEach(b=>b.onclick=()=>{
    const id=b.dataset.g, side=b.dataset.s; S.local[id]=S.local[id]===side?null:side; S.touched.add(id);
    if(S.save!=="saving") S.save="idle";
    saveDraft(); render(); queueSave();
  });
  const guess=document.getElementById("guess");
  if(guess) guess.oninput=()=>{ S.localGuess=guess.value.trim(); S.guessTouched=true; if(S.save!=="saving") S.save="idle"; saveDraft(); queueSave(1200); };
  if(guess) guess.onchange=()=>{ queueSave(0); };
  const rt=document.getElementById("retry"); if(rt) rt.onclick=()=>{ S.save="idle"; if(!S.saved.picks||S.error) loadMine(); else queueSave(0); };
  app.querySelectorAll(".stand tbody tr[data-x]").forEach(r=>r.onclick=()=>{ const d=app.querySelector('[data-d="'+r.dataset.x+'"]'); if(d) d.hidden=!d.hidden; });
}

/* ---------- init ---------- */
async function loadStatic(){
  const [schedule, players, results]=await Promise.all([json("data/schedule.json"), json("data/players.json"), json("data/results.json")]);
  S.schedule={}; schedule.forEach(w=>{ S.schedule[w.week]=w; });
  S.players=players.slice().sort((a,b)=>a.name.localeCompare(b.name));
  S.results=results||{};
}
(async function init(){
  if(!configured()) return render();
  try{ await loadStatic(); }catch(e){ S.error="Couldn't load the schedule ("+e.message+"). Refresh to try again."; return render(); }
  S.week=currentWeek();
  S.me=ls.get("pickem26-me")||"";
  if(S.me&&!S.players.some(p=>p.slug===S.me)) S.me="";
  loadMine();
  let sig=lockSig();
  setInterval(()=>{ const s=lockSig(); if(s!==sig){ sig=s; delete S.weeks[S.week]; render(); showTab(); } }, 30000); // re-evaluate locks
  document.addEventListener("visibilitychange", async()=>{
    if(document.visibilityState!=="visible") return;
    try{ await loadStatic(); }catch(e){}
    if(!pendingChanges() && S.save!=="saving") loadMine(); else render();
    showTab();
  });
  window.addEventListener("pagehide", ()=>{ if(pendingChanges()) doSave(); });
})();
