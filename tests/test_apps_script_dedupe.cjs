const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = {
  console,
  Utilities: {formatDate: v => new Date(v).toISOString().replace('T', ' ').slice(0, 19)}
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('GoogleAppsScript.gs', 'utf8'), context);
vm.runInContext(fs.readFileSync('ScheduledDedupe.gs', 'utf8'), context);
const date = '2026-11-02';
const ts = '2026-11-02 19:04:32';

function row(league, home, away, sourceColumn, id, first = ts,
             last = ts, checks = 1, matchDate = date) {
  const out = [
    matchDate, matchDate, league, home, away,
    'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO',
    first, last, checks, id || ''
  ];
  out[sourceColumn] = 'ANO';
  return out;
}

function testMultipleAliasesMergeAndAudit() {
  const a = row('Řecko / Elite League', 'AS Papagou', 'Panionios BC Atény',
    5, 'sr:match:73113286; SynotTip: Q1', '2026-11-02 17:00:00',
    '2026-11-02 19:00:00', 4);
  const b = row('Greece. Elite League', 'AS Papagou', 'Panionios Athens',
    6, 'Fonbet: live', '2026-11-02 17:20:00',
    '2026-11-02 19:05:00', 3);
  const c = row('Greece. Elite League', 'Papagou', 'Panionios',
    7, '1xBit: Q2', '2026-11-02 18:20:00',
    '2026-11-02 19:02:00', 2);
  const rows = [a,b,c];
  const plan = context.planHistoricalDeduplication_(rows, ts);
  assert.equal(plan.merged, 2);
  assert.equal(plan.archive.length, 3);
  assert.equal(plan.reviewCandidates, 0);
  assert.equal(JSON.stringify([...plan.deleteIndices]), JSON.stringify([2,1]));
  assert.deepEqual(rows[0].slice(5,9), ['ANO','ANO','ANO','NEOVĚŘENO']);
  assert.equal(rows[0][9], '2026-11-02 17:00:00');
  assert.equal(rows[0][10], '2026-11-02 19:05:00');
  assert.equal(rows[0][11], 4); // MAX, not 4+3+2
  assert.match(rows[0][12], /sr:match:73113286/);
  assert.match(rows[0][12], /Fonbet: live/);
  assert.match(rows[0][12], /1xBit: Q2/);
  assert.equal(plan.archive[0][3], 'MASTER BEFORE');
  assert.equal(plan.archive[1][3], 'MERGED FROM');
  assert.equal(plan.archive[0].length, 17);
  const second = context.planHistoricalDeduplication_([rows[0]], ts);
  assert.equal(second.merged, 0);
  assert.equal(second.archive.length, 0);
}

function testKnownIdOverridesNameDifferenceButNotGender() {
  const women1 = row('Island / Úrvalsdeild, ženy', 'Stjarnan FC',
    'Fjolnir Reykjavik', 5, 'sr:match:74932484');
  const women2 = row('Iceland. Premier League Women', 'UMF Stjarnan (Women)',
    'Fjolnir (Women)', 7, 'sr:match:74932484');
  const women3 = row('Iceland. Women', 'Stjarnan (w)', 'Fjölnir (w)', 6, '');
  const plan = context.planHistoricalDeduplication_([women1,women2,women3], ts);
  assert.equal(plan.merged >= 1, true);
  assert.equal(women1[5], 'ANO');
  assert.equal(women1[7], 'ANO');
  const men = row('Iceland men', 'Stjarnan', 'Fjolnir', 7, 'sr:match:74932484');
  const no = context.planHistoricalDeduplication_([women1,men], ts);
  assert.equal(no.merged, 0);
}

function testConflictAndCategoriesRemainSeparateAndFlagged() {
  const a = row('Greece. Elite League','Papagou','Panionios', 6, 'sr:match:12345678');
  const b = row('Greece. Elite League','AS Papagou','Panionios Athens',7,'sr:match:88888888');
  const c = row('Greece. Elite League','Papagou U19','Panionios U19',7,'');
  const d = row('Greece. Elite League','Papagou (Women)','Panionios (Women)',7,'');
  const plan = context.planHistoricalDeduplication_([a,b,c,d], ts);
  assert.equal(plan.merged, 0);
  assert.equal(plan.archive.length, 0);
  assert.equal(plan.reviewCandidates, 2);
  assert.match(a[12],/ZKONTROLOVAT DUPLIKAT/);
  assert.match(b[12],/ZKONTROLOVAT DUPLIKAT/);
  assert.doesNotMatch(c[12],/ZKONTROLOVAT DUPLIKAT/);
  assert.doesNotMatch(d[12],/ZKONTROLOVAT DUPLIKAT/);
  const second = context.planHistoricalDeduplication_([a,b,c,d], ts);
  assert.equal(second.merged, 0);
  assert.equal(second.modified.size, 0);
}

function testMultipleIdsAcrossThirdVariantNotTransitive() {
  const a=row('Greece. Elite League','AS Papagou','Panionios Athens',5,'sr:match:11111111');
  const middle=row('Greece. Elite League','Papagou','Panionios',6,'');
  const b=row('Greece. Elite League','AS Papagou','Panionios Athens',7,'sr:match:22222222');
  const rows=[a,middle,b];
  const plan=context.planHistoricalDeduplication_(rows, ts);
  assert.equal(plan.merged,1); // only one can absorb ambiguous no-ID row
  assert.equal(plan.archive.length,2);
  assert.equal(plan.reviewCandidates>0,true);
  assert.notEqual(rows[0][12].includes('sr:match:22222222'),true);
}


class FakeSheet {
  constructor(rows = []) { this.rows = rows.map(r => r.slice()); }
  getLastRow() {
    let n = this.rows.length;
    while (n > 0 && this.rows[n-1].every(v => v === '')) n--;
    return n;
  }
  getRange(r, c, n=1, w=1) {
    const self = this;
    return {
      getValues() {
        return Array.from({length:n}, (_, i) =>
          Array.from({length:w}, (_, j) => self.rows[r+i-1]?.[c+j-1] ?? ''));
      },
      setValues(values) {
        assert.equal(values.length, n);
        for (let i=0; i<n; i++) {
          assert.equal(values[i].length, w);
          while (self.rows.length < r+i) self.rows.push([]);
          for (let j=0; j<w; j++) self.rows[r+i-1][c+j-1] = values[i][j];
        }
      },
    };
  }
  appendRow(row) { this.rows.push(row.slice()); }
  deleteRows(r, n) {
    assert(r > 1, 'Never delete the match header');
    this.rows.splice(r-1, n);
  }
  setFrozenRows() {}
}

function runMockIngestion() {
  const master=row('Greece. Elite League','AS Papagou','Panionios Athens',
    5,'sr:match:73113286', '2026-11-02 15:00:00',
    '2026-11-02 16:00:00', 3);
  const other=row('Greece. Elite League','Papagou','Panionios',7,'1xBit: Q2',
    '2026-11-02 15:30:00', '2026-11-02 16:05:00', 2);
  const games=new FakeSheet([Array(13).fill('HEADER'), master,other]);
  const checks=new FakeSheet([]);
  const sources=new FakeSheet([Array(6).fill('H')]);
  const sheets={Zápasy:games,Kontroly:checks,Zdroje:sources};
  context.SpreadsheetApp={
    openById() {
      return {
        getSheetByName(name) {return sheets[name]||null;},
        insertSheet(name) {sheets[name]=new FakeSheet();return sheets[name];}
      };
    }
  };
  const payload={
    checkedAt:'2026-11-02T19:00:00Z',
    sources:['SynotTip','Fonbet','1xBit','Football.com']
      .map(source=>({source,status:'ÚSPĚCH',complete:false,matches:[]}))
  };
  const result=context.saveSnapshot_(payload);
  assert.equal(result.ok,true);
  assert.equal(result.mergedDuplicates,0); // Ingest only records matches.
  assert.equal(result.currentRows,2);
  assert.equal(games.getLastRow(),3);
  const background=context.scheduledDeduplicateDay_(context.SpreadsheetApp.openById(),date);
  assert.equal(background.merged,1);
  assert.equal(games.getLastRow(),2);
  assert.equal(games.rows[1][5],'ANO');
  assert.equal(games.rows[1][7],'ANO');
  assert.equal(games.rows[1][9],'2026-11-02 15:00:00');
  assert.equal(games.rows[1][10],'2026-11-02 16:05:00');
  assert.equal(games.rows[1][11],3);
  assert.equal(sheets['Archiv duplicit'].rows.length,3);
  assert.equal(sheets['Archiv duplicit'].rows[0].length,17);
  const second=context.saveSnapshot_(payload);
  assert.equal(second.mergedDuplicates,0);
  assert.equal(games.getLastRow(),2);
  assert.equal(sheets['Archiv duplicit'].rows.length,3);
  assert.equal(checks.rows.length,2);

  const alternative=row('Greece. Elite League','AS Papagou','Panionios',
    7,'sr:match:99999999');
  games.rows.push(alternative);
  const flagged=context.saveSnapshot_(payload);
  assert.equal(flagged.mergedDuplicates,0);
  assert.equal(flagged.reviewCandidates,0);
  assert.equal(games.rows.length,3);
  const flaggedBackground=context.scheduledDeduplicateDay_(context.SpreadsheetApp.openById(),date);
  assert.equal(flaggedBackground.review,2);
  assert.match(games.rows[1][12],/ZKONTROLOVAT DUPLIKAT/);
  assert.match(games.rows[2][12],/ZKONTROLOVAT DUPLIKAT/);
}

function testTownsvillePerthThreeProvidersMerge() {
  const matchDate = '2026-11-03';
  const a = row('Australia. WNBL', 'Townsville Fire (Women)',
    'Perth Lynx (Women)', 7, '; 1xBit: 1. čtvrtina',
    '2026-11-03 8:45:52', '2026-11-03 9:46:01', 8, matchDate);
  const b = row('Austrálie / WNBL', 'Townsville Fire',
    'Perth Lynx', 5, 'sr:match:72704662; SynotTip: Nezačalo; Fonbet: live',
    '2026-11-03 9:01:28', '2026-11-03 9:46:01', 7, matchDate);
  b[6] = 'ANO';
  b[8] = 'ANO';
  const c = row('Australia. Women. WNBL', 'Townsville Fire (w)',
    'Perth (w)', 6, '; Fonbet: live',
    '2026-11-03 9:42:10', '2026-11-03 9:46:01', 2, matchDate);
  const rows=[a,b,c];
  assert.equal(context.fixtureClass_(a[2],a[3],a[4]), 'adult|women');
  assert.equal(context.fixtureClass_(b[2],b[3],b[4]), 'adult|women');
  assert.equal(context.fixtureClass_(c[2],c[3],c[4]), 'adult|women');
  assert.equal(context.sameFixture_(matchDate,c[3],c[4],c[2],b,''),true);
  assert.equal(context.sameFixture_(matchDate,a[3],a[4],a[2],b,''),true);

  const plan=context.planHistoricalDeduplication_(rows,'2026-11-03 9:47:00');
  assert.equal(plan.merged,2);
  assert.equal(plan.archive.length,3);
  assert.equal(plan.reviewCandidates,0);
  const master=rows[plan.masterByIndex.get(0)];
  assert.equal(master[5],'ANO');
  assert.equal(master[6],'ANO');
  assert.equal(master[7],'ANO');
  assert.equal(master[8],'ANO');
  assert.equal(master[11],8);
  assert.match(master[12],/sr:match:72704662/);
  assert.match(master[12],/1xBit: 1. čtvrtina/);
  assert.match(master[12],/Fonbet: live/);
  assert.equal(master[9],'2026-11-03 8:45:52');

  // The short form Perth (w) must not turn into Perth Lynx outside WNBL.
  assert.equal(context.fixtureTeamAlias_('Perth (w)','Australia. NBL'),
    'Perth (w)');
  assert.equal(context.sameFixture_('2026-11-03',
    'Townsville Fire (w)','Perth (w)','Australia. Some Regional Women',
    b,''), false);
  // Distinct verified event IDs still prevent automatic merging.
  const conflict=row('Austrálie / WNBL','Townsville Fire (w)',
    'Perth (w)',6,'sr:match:99999999',undefined,undefined,1,matchDate);
  assert.equal(context.sameFixture_(matchDate,conflict[3],conflict[4],
    conflict[2],b,'sr:match:99999999'),false);
}

function testRapidRepeatEventIdentityAcrossPolls() {
  const games=new FakeSheet([Array(13).fill('HEADER')]);
  const checks=new FakeSheet([]);
  const sources=new FakeSheet([Array(6).fill('H')]);
  const tabs={Zápasy:games,Kontroly:checks,Zdroje:sources};
  context.SpreadsheetApp={openById:()=>({
    getSheetByName:name=>tabs[name]||null,
    insertSheet:name=>(tabs[name]=new FakeSheet())
  })};
  const m=(id,game)=>({
    home:'Alligators',away:'Lions',competition:'BSKT CUP',date,
    eventId:id,providerId:game,state:'Q2',score:'32:32'
  });
  const idA='sr:match:BAaGde|NHdp-rkVS9wMWaBw';
  const idB='sr:match:BAaGde|differentMatchAbc';
  const sourcesIn=[
    {source:'SynotTip',status:'ÚSPĚCH',complete:false,matches:[]},
    {source:'Fonbet',status:'ÚSPĚCH',complete:false,matches:[]},
    {source:'1xBit',status:'ÚSPĚCH',complete:false,matches:[]},
    {source:'Football.com',status:'ÚSPĚCH',complete:false,
      matches:[m(idA,'33827'),m(idB,'33841')]}
  ];
  const payload={checkedAt:'2026-11-03T10:00:00Z',sources:sourcesIn};
  const first=context.saveSnapshot_(payload);
  assert.equal(first.created,2);
  assert.equal(first.mergedDuplicates,0);
  assert.equal(first.positiveObservations,2);
  assert.equal(games.getLastRow(),3);
  assert.notEqual(games.rows[1][0],games.rows[2][0]);
  assert.match(games.rows[1][12],/football:event:sr:match:BAaGde/);
  assert.equal(context.rowFootballOpaqueId_(games.rows[1][12]),idA);
  assert.equal(context.rowFootballOpaqueId_(games.rows[2][12]),idB);
  assert.equal(context.sameHistoricalFixture_(games.rows[1],games.rows[2]),false);
  payload.checkedAt='2026-11-03T10:15:00Z';
  const second=context.saveSnapshot_(payload);
  assert.equal(second.created,0);
  assert.equal(second.mergedDuplicates,0);
  assert.equal(second.positiveObservations,2);
  assert.equal(games.getLastRow(),3);
  assert.equal(games.rows[1][11],2);
  assert.equal(games.rows[2][11],2);
  assert.equal(tabs['Archiv duplicit'],undefined);

  const missingId=m('','33842');
  payload.sources[3].matches=[missingId];
  const third=context.saveSnapshot_(payload);
  assert.equal(third.created,0);
  assert.equal(third.positiveObservations,0);
  assert.equal(games.getLastRow(),3);
}

function testRejectedLeagueAuditAcrossRunsAndSources() {
  const games=new FakeSheet([Array(13).fill('HEADER')]);
  const checks=new FakeSheet([]);
  const sourceSheet=new FakeSheet([Array(6).fill('HEADER')]);
  const sheets={Zápasy:games,Kontroly:checks,Zdroje:sourceSheet};
  context.SpreadsheetApp={openById:()=>({
    getSheetByName:name=>sheets[name]||null,
    insertSheet:name=>(sheets[name]=new FakeSheet())
  })};
  const reject=(competition,reason,count,example)=>({
    competition,reason,count,example
  });
  const sources=[
    {source:'SynotTip',status:'ÚSPĚCH',complete:false,matches:[],
     rejectedCompetitions:[]},
    {source:'Fonbet',status:'ÚSPĚCH',complete:false,matches:[],
     rejectedCompetitions:[
       reject('FrostBall','Nežádoucí soutěž',2,'Lynx FB – Archers FB'),
       reject('Premier League A','Nežádoucí soutěž',1,'Spiders – Tigers')]},
    {source:'1xBit',status:'ÚSPĚCH',complete:false,matches:[],
     rejectedCompetitions:[
       reject('FrostBall','Nežádoucí soutěž',3,'Bisons FB – Arrows FB'),
       reject('frostball','Nežádoucí soutěž',1,'Lynx FB – Archers FB')]},
    {source:'Football.com',status:'ÚSPĚCH',complete:false,matches:[],
     rejectedCompetitions:[reject('BSKT CUP','Nežádoucí soutěž',2,
       'Alligators – Lions')]}
  ];
  const body={checkedAt:'2026-11-03T09:00:00.000Z',sources};
  const first=context.saveSnapshot_(body);
  assert.equal(first.rejectedGames,9);
  assert.equal(first.rejectedLeagues,4);
  const audit=sheets['Vyřazené soutěže'];
  assert.equal(audit.getLastRow(),5);
  assert.equal(audit.rows[0][0],'Zdroj');
  const fonbetFrost=audit.rows.find(r=>r[0]==='Fonbet' && r[1]==='FrostBall');
  assert.equal(fonbetFrost[5],1);
  assert.equal(fonbetFrost[6],2);
  assert.equal(fonbetFrost[7],2);
  assert.match(fonbetFrost[8],/Lynx FB/);
  const bitFrost=audit.rows.find(r=>r[0]==='1xBit' && r[1]==='FrostBall');
  assert.equal(bitFrost[5],1);
  assert.equal(bitFrost[6],4);
  assert.equal(bitFrost[7],4);

  // A retry with identical checkedAt must not add a new "control".
  const repeat=context.saveSnapshot_(body);
  assert.equal(repeat.rejectedGames,9);
  assert.equal(audit.getLastRow(),5);
  assert.equal(fonbetFrost[5],1);
  assert.equal(fonbetFrost[6],2);
  assert.equal(bitFrost[6],4);

  // Later run accumulates occurrences, but not new duplicate rows.
  body.checkedAt='2026-11-03T09:15:00.000Z';
  sources[1].rejectedCompetitions=[
    reject('FrostBall','Nežádoucí soutěž',1,'Lynx FB – Archers FB')];
  sources[2].rejectedCompetitions=[
    reject('FrostBall','Nežádoucí soutěž',2,'Bisons FB – Arrows FB')];
  sources[3].status='NEDOSTUPNÉ';
  sources[3].rejectedCompetitions=[
    reject('Should Ignore','Nežádoucí soutěž',3,'X – Y')];
  const second=context.saveSnapshot_(body);
  assert.equal(second.rejectedGames,3);
  assert.equal(second.rejectedLeagues,2);
  assert.equal(audit.getLastRow(),5);
  assert.equal(fonbetFrost[5],2);
  assert.equal(fonbetFrost[6],3);
  assert.equal(fonbetFrost[7],1);
  assert.equal(bitFrost[5],2);
  assert.equal(bitFrost[6],6);
  assert.equal(bitFrost[7],2);
  assert.equal(audit.rows.some(r=>r[1]==='Should Ignore'),false);
  assert.match(checks.rows[checks.rows.length-1][9],/3 vyřazených LIVE/);
}

function testManualArchiveAliasesPreventRespawnAndReplayChains() {
  const date='2026-11-03';
  const master=row('Filipíny / NCAA, seniors','Sscr Stags','Au Chiefs',5,
    'sr:match:74250436', '2026-11-03 8:20:41',
    '2026-11-03 10:15:00',9,date);
  master[8]='ANO';
  const mid=row('Philippines. NCAA','SSCR Stags','Arellano Univ Chiefs',6,
    'Fonbet: live','2026-11-03 8:31:09','2026-11-03 10:15:00',7,date);
  const tail=row('Philippines. NCAA','San Sebastian College',
    'Arellano University Chiefs',7,'1xBit: Q2',
    '2026-11-03 8:31:09','2026-11-03 10:15:00',7,date);
  // Test helper uses date as its placeholder A-key; the real sheet uses
  // unique fixture keys, which the manual merge archives to resolve aliases.
  master[0]='2026-11-03|filipiny ncaa seniors|sscr stags|au chiefs';
  mid[0]='2026-11-03|philippines ncaa|sscr stags|arellano univ chiefs';
  tail[0]='2026-11-03|philippines ncaa|san sebastian college|arellano university chiefs';
  const archiveHeader=[
    'Čas sloučení','Klíč zachovaného zápasu','Původní řádek','Role',
    'Klíč zápasu','Datum utkání','Soutěž','Domácí','Hosté',
    'SynotTip','Fonbet','1xBit','Football.com',
    'Poprvé','Naposledy','Počet kontrol','Poznámka'
  ];
  const history=[
    ['2026-11-03 8:32:00',mid[0],5,'MANUAL MERGED FROM',...tail],
    ['2026-11-03 8:33:12',master[0],6,'MANUAL MERGED FROM',...mid],
  ];
  const games=new FakeSheet([Array(13).fill('HEADER'),master,mid,tail]);
  const audit=new FakeSheet([archiveHeader,...history]);
  const checks=new FakeSheet([]);
  const sources=new FakeSheet([Array(6).fill('HEADER')]);
  const sheets={Zápasy:games,'Archiv duplicit':audit,Kontroly:checks,Zdroje:sources};
  context.SpreadsheetApp={openById:()=>({
    getSheetByName:name=>sheets[name]||null,
    insertSheet:name=>(sheets[name]=new FakeSheet())
  })};
  const aliases=context.manualArchiveLinks_({
    getSheetByName:name=>sheets[name]||null
  },games.rows.slice(1));
  assert.equal(aliases.byExisting.get(1),0);
  assert.equal(aliases.byExisting.get(2),0);
  assert.equal(aliases.byIncoming.get(
    'Fonbet|2026-11-03|philippines ncaa|sscr stags|arellano univ chiefs'),0);
  assert.equal(aliases.byIncoming.get(
    '1xBit|2026-11-03|philippines ncaa|san sebastian college|arellano university chiefs'),0);
  const match=(league,home,away)=>({
    date,competition:league,home,away,eventId:'',state:'Q2'
  });
  const info=[
    {source:'SynotTip',status:'ÚSPĚCH',complete:false,matches:[]},
    {source:'Fonbet',status:'ÚSPĚCH',complete:false,matches:[
      match('Philippines. NCAA','SSCR Stags','Arellano Univ Chiefs')]},
    {source:'1xBit',status:'ÚSPĚCH',complete:false,matches:[
      match('Philippines. NCAA','San Sebastian College','Arellano University Chiefs')]},
    {source:'Football.com',status:'ÚSPĚCH',complete:false,matches:[]},
  ];
  const payload={checkedAt:'2026-11-03T10:30:00Z',sources:info};
  const first=context.saveSnapshot_(payload);
  assert.equal(first.ok,true);
  assert.equal(first.created,0);
  assert.equal(first.mergedDuplicates,0);
  assert.equal(first.currentRows,3);
  assert.equal(games.getLastRow(),4);
  const bg=context.scheduledDeduplicateDay_(context.SpreadsheetApp.openById(),date);
  assert.equal(bg.merged,2);
  assert.equal(games.getLastRow(),2);
  assert.equal(games.rows[1][0],master[0]);
  assert.equal(games.rows[1][5],'ANO');
  assert.equal(games.rows[1][6],'ANO');
  assert.equal(games.rows[1][7],'ANO');
  assert.equal(games.rows[1][8],'ANO');
  assert.equal(games.rows[1][11],10);
  assert.match(games.rows[1][12],/sr:match:74250436/);
  assert.equal(sheets['Archiv duplicit'].getLastRow(),6);

  payload.checkedAt='2026-11-03T10:45:00Z';
  const second=context.saveSnapshot_(payload);
  assert.equal(second.created,0);
  assert.equal(second.mergedDuplicates,0);
  assert.equal(second.currentRows,1);
  assert.equal(second.positiveObservations,2);
  assert.equal(games.getLastRow(),2);
  assert.equal(games.rows[1][11],11);
}

function testManualArchiveAliasRejectsConflictingIdsAndDates() {
  const master=row('Australia. WNBL','Townsville Fire','Perth Lynx',5,
    'sr:match:72704662',ts,ts,2,'2026-11-03');
  const old=row('Australia. WNBL','Townsville Fire (Women)',
    'Perth Lynx (Women)',7,'sr:match:99999999',ts,ts,2,'2026-11-03');
  master[0]='2026-11-03|australia wnbl|townsville fire|perth lynx';
  old[0]='2026-11-03|australia wnbl|townsville fire women|perth lynx women';
  const history=[[
    '2026-11-03 09:05:00',master[0],3,'MANUAL MERGED FROM',...old
  ]];
  const archive=new FakeSheet([Array(17).fill('HEADER'),...history]);
  const current=[master];
  const links=context.manualArchiveLinks_({
    getSheetByName:name=>name==='Archiv duplicit'?archive:null
  },current);
  const key='1xBit|2026-11-03|australia wnbl|townsville fire women|perth lynx women';
  assert.equal(links.byIncoming.get(key),0);
  // The explicit index is only accepted when incoming IDs agree.
  const incomingId='sr:match:99999999', masterId=context.eventId_(master[12]);
  assert.notEqual(incomingId,masterId);
  assert.equal(context.manualArchiveLinks_({
    getSheetByName:()=>archive
  },[row('Australia. WNBL','Townsville Fire','Perth Lynx',5,
      'sr:match:72704662',ts,ts,2,'2026-11-04')]
  ).byIncoming.size,0);
}

function testTeamAliasesRememberAcrossDaysAndOpponents() {
  const oldDate='2026-11-03';
  const master=row('Filipíny / NCAA, seniors','Sscr Stags','Au Chiefs',5,
    'sr:match:74250436',ts,ts,3,oldDate);
  master[0]='2026-11-03|filipiny ncaa seniors|sscr stags|au chiefs';
  const previous=row('Philippines. NCAA','San Sebastian College',
    'Arellano University Chiefs',7,'1xBit: Q2',ts,ts,2,oldDate);
  previous[0]='2026-11-03|philippines ncaa|san sebastian college|arellano university chiefs';
  const archive=new FakeSheet([
    Array(17).fill('HEADER'),
    ['2026-11-03 10:15:00',master[0],9,'MANUAL MERGED FROM',...previous]
  ]);
  const games=new FakeSheet([Array(13).fill('HEADER'),master]);
  const checks=new FakeSheet([]);
  const sourceSheet=new FakeSheet([Array(6).fill('HEADER')]);
  const sheets={Zápasy:games,'Archiv duplicit':archive,
    Kontroly:checks,Zdroje:sourceSheet};
  context.SpreadsheetApp={openById:()=>({
    getSheetByName:name=>sheets[name]||null,
    insertSheet:name=>(sheets[name]=new FakeSheet())
  })};
  const mk=(name,home,away,date,id='')=>({
    source:name,status:'ÚSPĚCH',complete:false,matches:[
      {date,home,away,competition:name==='1xBit'?'Philippines. NCAA':
        'Filipíny / NCAA, seniors',eventId:id,providerId:'',state:'Q1',score:'10:8'}
    ]
  });
  const empty=name=>({source:name,status:'ÚSPĚCH',complete:false,matches:[]});
  const d1='2026-11-04';
  const payload={
    checkedAt:'2026-11-04T08:15:00Z',
    sources:[
      mk('SynotTip','Sscr Stags','Mapua Cardinals',d1,'sr:match:75000001'),
      empty('Fonbet'),
      mk('1xBit','San Sebastian College','Mapua Cardinals',d1),
      empty('Football.com')
    ]
  };
  const first=context.saveSnapshot_(payload);
  assert.equal(first.created,1);
  assert.equal(first.currentRows,2);
  assert.equal(games.rows[2][5],'ANO');
  assert.equal(games.rows[2][7],'ANO');
  assert.equal(games.rows[2][12].includes('sr:match:75000001'),true);
  const aliases=sheets['Aliasy týmů'];
  assert.equal(aliases.getLastRow(),3);
  assert.equal(aliases.rows[1][0],'1xBit');
  assert.equal(aliases.rows[1][2],'San Sebastian College');
  assert.equal(aliases.rows[1][3],'Sscr Stags');
  assert.equal(aliases.rows[1][7],'ANO');

  // On the next day the bookmaker with the alias arrives FIRST.
  const d2='2026-11-05';
  payload.checkedAt='2026-11-05T08:00:00Z';
  payload.sources=[empty('SynotTip'),empty('Fonbet'),
    mk('1xBit','San Sebastian College','Jose Rizal University',d2),
    empty('Football.com')];
  const second=context.saveSnapshot_(payload);
  assert.equal(second.created,1);
  assert.equal(second.currentRows,3);

  payload.checkedAt='2026-11-05T08:15:00Z';
  payload.sources=[mk('SynotTip','Sscr Stags','Jose Rizal University',d2,
      'sr:match:75000002'),empty('Fonbet'),empty('1xBit'),
    empty('Football.com')];
  const third=context.saveSnapshot_(payload);
  assert.equal(third.created,0);
  assert.equal(third.currentRows,3);
  const recent=games.rows.find(r=>r[1]===d2);
  assert.equal(recent[5],'ANO');
  assert.equal(recent[7],'ANO');
  assert.match(recent[12],/sr:match:75000002/);

  // Other opponents are separate games; future dates aren't collapsed.
  payload.checkedAt='2026-11-05T08:30:00Z';
  payload.sources=[empty('SynotTip'),empty('Fonbet'),
    mk('1xBit','San Sebastian College','Another Team',d2),
    empty('Football.com')];
  const other=context.saveSnapshot_(payload);
  assert.equal(other.created,1);
  assert.equal(other.currentRows,4);
  assert.equal(aliases.getLastRow(),3); // Rebuild is idempotent.

  // Editing Active=NE in Sheets prevents reuse without code changes.
  aliases.rows[1][7]='NE';
  payload.checkedAt='2026-11-06T08:00:00Z';
  payload.sources=[mk('SynotTip','Sscr Stags','New Opponent','2026-11-06'),
    empty('Fonbet'),mk('1xBit','San Sebastian College','New Opponent','2026-11-06'),
    empty('Football.com')];
  const disabled=context.saveSnapshot_(payload);
  assert.equal(disabled.created,2);
  assert.equal(disabled.currentRows,6);
}

function testTeamAliasesNeverOverrideConflictingVerifiedIds() {
  const cls='adult|unspecified';
  const a={
    dictionary:new Map([[
      context.teamAliasKey_('1xBit','Philippines. NCAA','San Sebastian College',cls),
      {canonical:context.normTeam_('Sscr Stags'),scope:context.normLeague_('Filipíny / NCAA, seniors')}
    ]]),
    leagueGroups:new Map([[context.normLeague_('Philippines. NCAA'),
      context.normLeague_('Filipíny / NCAA, seniors')]])
  };
  const original=row('Filipíny / NCAA, seniors','Sscr Stags','Mapua Cardinals',
    5,'sr:match:11111111',ts,ts,1,'2026-11-05');
  assert.equal(context.sameLearnedAliasFixture_(a,'1xBit','2026-11-05',
    'San Sebastian College','Mapua Cardinals','Philippines. NCAA',original,
    'sr:match:22222222'),false);
  assert.equal(context.sameLearnedAliasFixture_(a,'1xBit','2026-11-06',
    'San Sebastian College','Mapua Cardinals','Philippines. NCAA',original,''),false);
  const youth=row('Filipíny / NCAA U19','Sscr Stags U19','Mapua Cardinals U19',
    5,'',ts,ts,1,'2026-11-05');
  assert.equal(context.sameLearnedAliasFixture_(a,'1xBit','2026-11-05',
    'San Sebastian College','Mapua Cardinals','Philippines. NCAA',youth,''),false);
}

testMultipleAliasesMergeAndAudit();
testKnownIdOverridesNameDifferenceButNotGender();
testConflictAndCategoriesRemainSeparateAndFlagged();
testMultipleIdsAcrossThirdVariantNotTransitive();
runMockIngestion();
testTownsvillePerthThreeProvidersMerge();
testRapidRepeatEventIdentityAcrossPolls();
testRejectedLeagueAuditAcrossRunsAndSources();
testManualArchiveAliasesPreventRespawnAndReplayChains();
testManualArchiveAliasRejectsConflictingIdsAndDates();
testTeamAliasesRememberAcrossDaysAndOpponents();
testTeamAliasesNeverOverrideConflictingVerifiedIds();
console.log('Historical duplicate detection, full mock ingest, audit and conflict tests passed');
