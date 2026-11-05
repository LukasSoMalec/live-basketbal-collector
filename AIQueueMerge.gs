/**
 * AIQueueMerge.gs
 * Apply ChatGPT-reviewed fixture groups from tab "AI sloučení".
 * Uses stable fixture keys from Zápasy!A, never mutable row numbers.
 * Requires GoogleAppsScript.gs and its existing archive helpers.
 * @author LM
 * @license MIT
 */

const AI_MERGE_SHEET = 'AI sloučení';
const AI_MERGE_COLS = 12;
const AI_MERGE_HEADERS = [
  'Skupina', 'Rozhodnutí', 'Datum', 'Ponechat klíč',
  'Připojit klíče (JSON)', 'Prohozené týmy (JSON)',
  'Řádky při analýze', 'Zápasy ve skupině', 'Důvod',
  'Stav', 'Výsledek', 'Čas analýzy'
];

function aiMergeQueueRead_(ss) {
  const sh = ss.getSheetByName(AI_MERGE_SHEET);
  if (!sh) throw new Error('Záložka AI sloučení neexistuje.');
  const n = sh.getLastRow();
  if (n < 1) throw new Error('AI sloučení nemá hlavičku.');
  const head = sh.getRange(1, 1, 1, AI_MERGE_COLS).getValues()[0];
  if (String(head[0]) !== AI_MERGE_HEADERS[0] ||
      String(head[3]) !== AI_MERGE_HEADERS[3])
    throw new Error('Záložka AI sloučení má nečekaný formát.');
  return {sh, rows:n > 1 ? sh.getRange(2, 1, n-1, AI_MERGE_COLS).getValues() : []};
}

function aiMergeQueueDecode_(plan) {
  const key = String(plan[3] || '').trim();
  let others, reversals;
  try {
    others = JSON.parse(String(plan[4] || '[]'));
    reversals = JSON.parse(String(plan[5] || '[]'));
  } catch {
    throw new Error('Neplatný JSON seznam klíčů/prohození.');
  }
  if (!key || key.length > 500 || !Array.isArray(others) ||
      others.length < 1 || others.length > 12 ||
      others.some(v => typeof v !== 'string' || !v || v.length > 500) ||
      new Set([key, ...others]).size !== others.length+1 ||
      !Array.isArray(reversals) || reversals.length !== others.length ||
      reversals.some(v => typeof v !== 'boolean'))
    throw new Error('Neplatné klíče zápasů nebo orientace.');
  return {key, others, reversals};
}

function aiMergeAllIds_(note) {
  return [...new Set(String(note || '').match(/sr:match:\d{5,}/gi) || [])]
    .map(x => x.toLowerCase());
}

function aiMergeAllFootballIds_(note) {
  return [...new Set(Array.from(
    String(note || '').matchAll(/football:event:(sr:match:[a-zA-Z0-9|_-]{6,120})/g),
    m => m[1]
  ))];
}

// A combined listing contains 2+ real fixtures in one bookmaker record.
// Only delete the legacy rows that were observed solely at 1xBit and have
// no verified event identifier. Always archive them first.
function aiMergeRemovableComposite_(row) {
  return multipleFixtureListing_(row[3], row[4]) &&
    row[7] === 'ANO' &&
    [row[5],row[6],row[8]].every(v => v !== 'ANO') &&
    !aiMergeAllIds_(row[12]).length &&
    !aiMergeAllFootballIds_(row[12]).length;
}

function aiMergeSafety_(members, planDate) {
  if (members.some(r => !r[0] || !r[3] || !r[4]))
    return 'Některý zápas je neúplný.';
  if (members.some(r => multipleFixtureListing_(r[3], r[4])))
    return 'Jeden řádek obsahuje několik různých zápasů.';
  const dates = new Set(members.map(r => matchDateKey_(r[1])));
  if (dates.size !== 1 || !dates.has(String(planDate)))
    return 'Neshoduje se datum utkání.';
  const classes = new Set(members.map(r=>fixtureClass_(r[2],r[3],r[4])));
  if (classes.size !== 1)
    return 'Neshoduje se kategorie žen/mužů/mládeže.';
  const ids = new Set(members.flatMap(r=>aiMergeAllIds_(r[12])));
  if (ids.size > 1) return 'Konfliktní SportRadar ID.';
  const opaque = new Set(members.flatMap(r=>aiMergeAllFootballIds_(r[12])));
  if (opaque.size > 1) return 'Konfliktní Football.com ID.';
  const verifiedEqual = ids.size === 1 &&
    members.every(r=>aiMergeAllIds_(r[12]).includes([...ids][0])) ||
    opaque.size === 1 &&
    members.every(r=>aiMergeAllFootballIds_(r[12]).includes([...opaque][0]));

  if (members.some(r=>rapidRepeatLeague_(r[2])) && !verifiedEqual)
    return 'Soutěž s více zápasy stejných soupeřů v jednom dni.';

  for (let i=0; i<members.length; i++) {
    for (let j=i+1; j<members.length; j++) {
      // Two records from the SAME source are suspicious unless they both
      // contain exactly the same independently verified event identity.
      const overlap = SOURCES.some((_,k)=>
        members[i][5+k] === 'ANO' && members[j][5+k] === 'ANO');
      if (overlap && !verifiedEqual)
        return 'Jeden zdroj už označuje oba řádky jako ANO.';
    }
  }
  return '';
}

function aiMergeQueuePreview_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const q = aiMergeQueueRead_(ss);
  let auto=0, review=0, done=0, blocked=0;
  for (const r of q.rows) {
    if (String(r[9] || '').trim()) {
      done++;
      continue;
    }
    if (String(r[1] || '').trim() === 'SLOUČIT') auto++;
    else if (String(r[1] || '').trim() === 'PROVĚŘIT') review++;
    else if (r[0]) blocked++;
  }
  const games=ss.getSheetByName('Zápasy');
  const count=games ? games.getLastRow() : 0;
  const legacy=count>1 ? games.getRange(2,1,count-1,13).getValues() : [];
  const removable=legacy.filter(aiMergeRemovableComposite_).length;
  return {ok:true, auto, review, processed:done, other:blocked,
    removable, message:'Pro sloučení se používají klíče, nikoli čísla řádků.'};
}

function aiMergeQueueApply_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const matches = ss.getSheetByName('Zápasy');
  if (!matches) throw new Error('Chybí záložka Zápasy.');
  const q = aiMergeQueueRead_(ss);
  const original = matches.getLastRow()>1
    ? matches.getRange(2,1,matches.getLastRow()-1,13).getValues() : [];
  const index = new Map();
  for (let i=0; i<original.length; i++) {
    const key=String(original[i][0] || '');
    if (!key) continue;
    if (index.has(key)) index.set(key,-1);
    else index.set(key,i);
  }
  const plans = [];
  const outcomes = new Map();
  let checked = 0;
  for (let p=0; p<q.rows.length && checked<40; p++) {
    const row = q.rows[p];
    if (String(row[1] || '').trim()!=='SLOUČIT' ||
        String(row[9] || '').trim()) continue;
    checked++;
    try {
      const decoded=aiMergeQueueDecode_(row);
      const keys=[decoded.key,...decoded.others];
      const indices=keys.map(k=>index.get(k));
      if (indices.some(i=>i===undefined||i<0))
        throw new Error('Chybějící nebo nejednoznačný klíč – obnov AI analýzu.');
      const members=indices.map(i=>original[i]);
      const problem=aiMergeSafety_(members,row[2]);
      if (problem) throw new Error(problem);
      plans.push({planIndex:p,indices, members, reversed:decoded.reversals});
    } catch(e) {
      outcomes.set(p,['BLOKOVÁNO',String(e.message||e).slice(0,250)]);
    }
  }

  // Never apply overlapping groups within one batch.
  const countByIndex=new Map();
  for (const p of plans)
    for (const i of p.indices)
      countByIndex.set(i,(countByIndex.get(i)||0)+1);
  const safe=plans.filter(p=>{
    if (p.indices.every(i=>countByIndex.get(i)===1)) return true;
    outcomes.set(p.planIndex,['BLOKOVÁNO','Zápas se nachází ve více skupinách.']);
    return false;
  });
  const inMerge=new Set(safe.flatMap(p=>p.indices));
  const compositeIndices=original.map((r,i)=>aiMergeRemovableComposite_(r) &&
    !inMerge.has(i) ? i : -1).filter(i=>i>=0);
  if (safe.length || compositeIndices.length) {
    const rows=original.map(r=>r.slice());
    const archive=[];
    const changes=[];
    const deleted=[];
    const stamp=Utilities.formatDate(new Date(),'Europe/Prague','yyyy-MM-dd HH:mm:ss');
    for (const plan of safe) {
      const first=plan.indices[0], master=rows[first];
      const originalMaster=original[first];
      archive.push([stamp,master[0],first+2,'MASTER BEFORE',...originalMaster]);
      const group=plan.indices.map(i=>original[i]);
      for (let k=1; k<plan.indices.length; k++) {
        const ix=plan.indices[k];
        archive.push([stamp,master[0],ix+2,
          plan.reversed[k-1] ? 'AUTO MERGED FROM REVERSED':'AUTO MERGED FROM',
          ...original[ix]]);
        deleted.push(ix);
      }
      for (let col=5; col<=8; col++) {
        const flags=group.map(r=>r[col]);
        master[col]=flags.includes('ANO')?'ANO':
          flags.includes('NE')?'NE':'NEOVĚŘENO';
      }
      const firstStamps=group.map(r=>r[9]).filter(v=>comparableStamp_(v))
        .sort((a,b)=>comparableStamp_(a).localeCompare(comparableStamp_(b)));
      const lastStamps=group.map(r=>r[10]).filter(v=>comparableStamp_(v))
        .sort((a,b)=>comparableStamp_(a).localeCompare(comparableStamp_(b)));
      if (firstStamps.length) master[9]=firstStamps[0];
      if (lastStamps.length) master[10]=lastStamps[lastStamps.length-1];
      master[11]=Math.max(...group.map(r=>Number(r[11])||0));
      const notes=new Set();
      for (const r of group)
        for (const part of String(r[12]||'').split(/;\s*/)) {
          const val=part.trim();
          if (val && !val.startsWith('ZKONTROLOVAT DUPLIKAT')) notes.add(val);
        }
      master[12]=[...notes].join('; ');
      changes.push({i:first,values:master.slice(5,13)});
      outcomes.set(plan.planIndex,['SLOUČENO',
        'Připojeno '+(plan.indices.length-1)+' řádků; '+stamp]);
    }
    for (const ix of compositeIndices) {
      const row=original[ix];
      archive.push([stamp,String(row[0]||''),ix+2,
        'REMOVED MULTI-FIXTURE',...row]);
      deleted.push(ix);
    }
    // Exact original records must be in the archive before deletions.
    archiveHistoricalDuplicates_(ss,archive);
    for (const c of changes)
      matches.getRange(c.i+2,6,1,8).setValues([c.values]);
    deleteHistoricalDuplicateRows_(matches,deleted.sort((a,b)=>b-a));
  }
  // Status is written only after the corresponding operations have finished.
  for (const [p,value] of outcomes)
    q.sh.getRange(p+2,10,1,2).setValues([value]);
  return {ok:true,mergedGroups:safe.length,
    removedComposites:compositeIndices.length,
    removedRows:safe.reduce((n,p)=>n+p.indices.length-1,0) +
      compositeIndices.length,
    blocked:[...outcomes.values()].filter(x=>x[0]==='BLOKOVÁNO').length,
    remainingAuto:Math.max(0,q.rows.filter(r=>
      String(r[1]||'').trim()==='SLOUČIT' &&
      !String(r[9]||'').trim()).length-outcomes.size)};
}
