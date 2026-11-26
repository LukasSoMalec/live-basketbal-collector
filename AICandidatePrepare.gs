/**
 * Read-only fixture candidate preparation for hourly AI review.
 * Install alongside GoogleAppsScript.gs and AIQueueMerge.gs.
 * @author LM
 * @license MIT
 */
const AI_CANDIDATE_SHEET = 'AI kandidáti';
function aiCandidateStamp_(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') {
    const wall = new Date((v - 25569) * 86400000);
    return aiCandidateStamp_(wall.toISOString().slice(0,19));
  }
  const s = String(v || '').trim();
  if (!s) return NaN;
  try {
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s))
      return Utilities.parseDate(s.replace('T',' '), 'Europe/Prague', 'yyyy-MM-dd HH:mm:ss').getTime();
    return Date.parse(s);
  } catch (_) { return NaN; }
}
function aiCandidateWords_(s, women) {
  return normTeam_(s).split(' ').filter(t => t && (!women || !['w','women','woman'].includes(t)));
}
function aiCandidateProtected_(s) {
  return norm_(s).split(' ').filter(t => /^(?:u\d{2}|reserve[s]?|academy|junior[s]?|ii|iii|iv|b|c|2|3)$/.test(t)).sort().join('|');
}
function aiCandidateDice_(a,b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = a.replace(/ /g,''), y = b.replace(/ /g,'');
  if (x.length < 3 || y.length < 3) return 0;
  const counts = new Map();
  for(let i=0;i<x.length-1;i++){
    const k=x.slice(i,i+2);counts.set(k,(counts.get(k)||0)+1);
  }
  let hit=0;
  for(let i=0;i<y.length-1;i++){
    const k=y.slice(i,i+2), n=counts.get(k)||0;
    if(n){hit++;counts.set(k,n-1);}
  }
  return 2*hit/(x.length+y.length-2);
}
function aiCandidateTeamScore_(a,b) {
  let score=0;
  for(const x of a) for(const y of b){
    score=Math.max(score,aiCandidateDice_(x,y));
    const p=x.split(' '),q=y.split(' ');
    if(p.some(t=>t.length>=4 && q.includes(t))) score=Math.max(score,.62);
  }
  return score;
}
function aiCandidateRead_(ss,name,width) {
  const sh=ss.getSheetByName(name);
  if(!sh) throw new Error('Missing sheet: '+name);
  const n=sh.getLastRow();
  return n>1?sh.getRange(2,1,n-1,width).getValues():[];
}
function aiCandidatePrepare() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(25000)) throw new Error('Candidate preparation: lock unavailable');
  try {
    const ss=SpreadsheetApp.openById(SPREADSHEET_ID);
    const now=new Date(), cutoff=now.getTime()-36*3600000;
    const rows=aiCandidateRead_(ss,'Zápasy',13);
    const aliases=aiCandidateRead_(ss,'Aliasy týmů',8);
    const queue=aiCandidateRead_(ss,'AI sloučení',12);
    const sameQueue=aiCandidateRead_(ss,'AI STEJNÉ KLÍČE',ss.getSheetByName('AI STEJNÉ KLÍČE').getLastColumn());
    const archive=aiCandidateRead_(ss,'Archiv duplicit',17);
    const excluded=new Set();
    for(const r of queue){
      if(r[3]) excluded.add(String(r[3]));
      if(!r[4]) continue;
      const keys=JSON.parse(String(r[4]));
      if(!Array.isArray(keys)) throw new Error('Invalid queue JSON');
      keys.forEach(k=>excluded.add(String(k)));
    }
    for(const r of archive)
      if(/^(?:(?:MANUAL|AUTO) MERGED FROM(?: REVERSED)?|MERGED FROM)$/.test(String(r[3]))) excluded.add(String(r[4]));
    const sameExcluded=new Set(sameQueue.flat().map(String));
    const dict=new Map(), scopes=new Map();
    for(const r of aliases){
      if(String(r[7]).trim().toUpperCase()!=='ANO'||!r[0]||!r[1]||!r[2]||!r[3]||!r[4]||!r[5])continue;
      const k=teamAliasKey_(r[0],r[1],r[2],r[4]), value=normTeam_(r[3]), scope=normLeague_(r[5]);
      if(dict.has(k)&&JSON.stringify(dict.get(k))!==JSON.stringify([value,scope]))dict.set(k,null);
      else if(!dict.has(k))dict.set(k,[value,scope]);
      const l=normLeague_(r[1]);
      if(scopes.has(l)&&scopes.get(l)!==scope)scopes.set(l,'');
      else if(!scopes.has(l))scopes.set(l,scope);
    }
    const byKey=new Map(), active=[], candidates=[];
    let latest=0, unknown=0;
    const dateFloor=Utilities.formatDate(new Date(cutoff),'Europe/Prague','yyyy-MM-dd');
    rows.forEach((r,i)=>{
      const key=String(r[0]||'');if(!key)return;
      const stamps=[aiCandidateStamp_(r[9]),aiCandidateStamp_(r[10])].filter(Number.isFinite);
      const t=stamps.length?Math.max(...stamps):NaN;
      if(Number.isFinite(t))latest=Math.max(latest,t);
      const date=matchDateKey_(r[1]);
      if(!Number.isFinite(t))unknown++;
      const item={r,n:i+2,key,date,t,active:Number.isFinite(t)?t>=cutoff:date>=dateFloor};
      if(!byKey.has(key))byKey.set(key,[]);
      byKey.get(key).push(item);
      if(item.active)active.push(item);
    });
    const pack=x=>[x.n,x.key,x.date,String(x.r[2]),String(x.r[3]),String(x.r[4]),x.r.slice(5,9),comparableStamp_(x.r[9]),comparableStamp_(x.r[10]),String(x.r[12]||'')];
    for(const [key,items] of byKey){
      if(items.length>1&&items.some(x=>x.active)&&!sameExcluded.has(key))
        candidates.push(['SAME_KEY',key,JSON.stringify(items.map(pack)),'','Physical repeated key']);
    }
    const eligible=active.filter(x=>!excluded.has(x.key)&&byKey.get(x.key).length===1&&x.r[3]&&x.r[4]&&/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&!multipleFixtureListing_(x.r[3],x.r[4]));
    for(const x of eligible){
      const r=x.r;
      x.cls=fixtureClass_(r[2],r[3],r[4]);
      x.scope=scopes.has(normLeague_(r[2]))?scopes.get(normLeague_(r[2])):normLeague_(r[2]);
      x.ids=aiMergeAllIds_(r[12]);x.opaque=aiMergeAllFootballIds_(r[12]);
      const names=team=>{
        const w=x.cls.endsWith('|women'), result=new Set([aiCandidateWords_(team,w).join(' ')]);
        const targets=new Set();
        for(const source of SOURCES){
          const a=dict.get(teamAliasKey_(source,r[2],team,x.cls));
          if(a&&a[1]===x.scope)targets.add(a[0]);
        }
        if(targets.size===1)result.add(aiCandidateWords_([...targets][0],w).join(' '));
        return [...result].filter(Boolean);
      };
      x.home=names(r[3]);x.away=names(r[4]);
      x.ph=aiCandidateProtected_(r[3]);x.pa=aiCandidateProtected_(r[4]);
    }
    const shared=(a,b)=>a.some(v=>b.includes(v)&&!v.includes('11111111'));
    for(let i=0;i<eligible.length;i++)for(let j=i+1;j<eligible.length;j++){
      const a=eligible[i],b=eligible[j];
      if(a.cls!==b.cls)continue;
      const delta=Math.abs(Date.parse(a.date)-Date.parse(b.date))/86400000;
      if(delta>1)continue;
      if(new Set([...a.ids,...b.ids]).size>1||new Set([...a.opaque,...b.opaque]).size>1)continue;
      const id=shared(a.ids,b.ids)||shared(a.opaque,b.opaque);
      if((rapidRepeatLeague_(a.r[2])||rapidRepeatLeague_(b.r[2]))&&!id)continue;
      const f=a.ph===b.ph&&a.pa===b.pa?[aiCandidateTeamScore_(a.home,b.home),aiCandidateTeamScore_(a.away,b.away)]:[0,0];
      const v=a.ph===b.pa&&a.pa===b.ph?[aiCandidateTeamScore_(a.home,b.away),aiCandidateTeamScore_(a.away,b.home)]:[0,0];
      const score=Math.max(Math.min(...f),Math.min(...v));
      const strong=Math.max(...f,...v);
      if(!id&&!(score>=.48&&(a.scope===b.scope&&a.scope||strong>=.8)))continue;
      if(delta===0&&aiMergeSafety_([a.r,b.r],a.r[1]))continue;
      const evidence=JSON.stringify({sharedRealId:id,forward:f,reverse:v,leagueScopeEqual:!!a.scope&&a.scope===b.scope,aliasNames:[a.home,a.away,b.home,b.away],dateDifference:delta});
      candidates.push([delta?'DATE_REVIEW':'PAIR',a.key,JSON.stringify(pack(a)),JSON.stringify(pack(b)),evidence]);
    }
    const sh=ss.getSheetByName(AI_CANDIDATE_SHEET)||ss.insertSheet(AI_CANDIDATE_SHEET);
    const generation=Utilities.getUuid();
    const metadata={generation,status:'READY',prepared:now.toISOString(),cutoff:new Date(cutoff).toISOString(),read:rows.length,active:active.length,eligible:eligible.length,aliases:aliases.length,queue:queue.length,sameQueue:sameQueue.length,archive:archive.length,unknownTimestamps:unknown,latestScrape:latest?new Date(latest).toISOString():null,candidates:candidates.length};
    const data=[['META',generation,JSON.stringify(metadata),'',''],['Type','Key A','Fixture A JSON','Fixture B JSON','Evidence'],...candidates];
    if(sh.getMaxRows()<data.length)sh.insertRowsAfter(sh.getMaxRows(),data.length-sh.getMaxRows());
    const old=sh.getLastRow();
    // Invalidate previous generation before replacing it.
    sh.getRange(1,1,1,5).setValues([['BUILDING',generation,'','','']]);
    SpreadsheetApp.flush();
    if(old>data.length)sh.getRange(data.length+1,1,old-data.length,5).clearContent();
    sh.getRange(2,1,data.length-1,5).setValues(data.slice(1));
    SpreadsheetApp.flush();
    sh.getRange(1,1,1,5).setValues([data[0]]);
    SpreadsheetApp.flush();
    return metadata;
  } finally {lock.releaseLock();}
}
function aiCandidateInstall() {
  // Run manually once; authorizes the trigger and produces the first snapshot.
  const result=aiCandidatePrepare();
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='aiCandidatePrepare').forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('aiCandidatePrepare').timeBased().everyMinutes(10).create();
  return result;
}
