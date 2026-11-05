const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = {
  console,
  Utilities: {formatDate: value => new Date(value).toISOString().replace('T',' ').slice(0,19)}
};
vm.createContext(context);
for (const path of ['GoogleAppsScript.gs', 'AIQueueMerge.gs'])
  vm.runInContext(fs.readFileSync(path,'utf8'),context);

class FakeSheet {
  constructor(rows=[]) {this.rows=rows.map(r=>r.slice());}
  getLastRow() {return this.rows.length;}
  getRange(r,c,h=1,w=1) {
    const sh=this;
    return {
      getValues:()=>Array.from({length:h},(_,i)=>
        Array.from({length:w},(_,j)=>sh.rows[r+i-1]?.[c+j-1]??'')),
      setValues(values) {
        assert.equal(values.length,h);
        for(let i=0;i<h;i++) {
          assert.equal(values[i].length,w);
          while(sh.rows.length<r+i) sh.rows.push([]);
          for(let j=0;j<w;j++) sh.rows[r+i-1][c+j-1]=values[i][j];
        }
      }
    };
  }
  deleteRows(r,n) {assert(r>1);this.rows.splice(r-1,n);}
  setFrozenRows(){}
}
const headers=['Skupina','Rozhodnutí','Datum','Ponechat klíč',
  'Připojit klíče (JSON)','Prohozené týmy (JSON)','Řádky při analýze',
  'Zápasy ve skupině','Důvod','Stav','Výsledek','Čas analýzy'];
function row(key,home,away,source,notes='',date='2026-11-05') {
  const r=[key,date,'USA / NCAA',home,away,'NEOVĚŘENO',
    'NEOVĚŘENO','NEOVĚŘENO','NEOVĚŘENO',
    '2026-11-05 10:00:00','2026-11-05 10:15:00',3,notes];
  r[source]='ANO';return r;
}
const plan=(name,keys,reversed,decision='SLOUČIT')=>[
  name,decision,'2026-11-05',keys[0],JSON.stringify(keys.slice(1)),
  JSON.stringify(reversed),'2,3','Test cases','AI evaluation','','','2026-11-05'
];
function mock(rows,plans) {
  const sheets={
    'Zápasy':new FakeSheet([Array(13).fill('HEADER'),...rows]),
    'AI sloučení':new FakeSheet([headers,...plans])
  };
  context.SpreadsheetApp={
    openById:()=>({
      getSheetByName:name=>sheets[name]||null,
      insertSheet:name=>(sheets[name]=new FakeSheet())
    })
  };
  return sheets;
}
function testStableKeyTripleAndArchive() {
  const sh=mock([
    row('unrelated','Brown Bears','Yale Bulldogs',5),
    row('a','Saint Josephs Hawks','Longwood Lancers',5,'sr:match:74064538'),
    row('other','Texas Tech Red Raiders','Arkansas Razorbacks',5),
    row('b','Saint Josephs Hawks (stud)','Longwood Lancers (stud)',6),
    row('c',"Saint Joseph's Hawks",'Longwood Lancers',7)
  ],[plan('g1',['a','b','c'],[false,false])]);
  assert.equal(context.aiMergeQueuePreview_().auto,1);
  const r=context.aiMergeQueueApply_();
  assert.equal(r.mergedGroups,1);
  assert.equal(r.removedRows,2);
  assert.equal(r.removedComposites,0);
  assert.equal(sh.Zápasy.rows.length,4);
  assert.equal(sh.Zápasy.rows[2][0],'a');
  assert.equal(sh.Zápasy.rows[2][5],'ANO');
  assert.equal(sh.Zápasy.rows[2][6],'ANO');
  assert.equal(sh.Zápasy.rows[2][7],'ANO');
  assert.equal(sh['AI sloučení'].rows[1][9],'SLOUČENO');
  assert.equal(sh['Archiv duplicit'].rows.length,4);
  assert.equal(context.aiMergeQueueApply_().mergedGroups,0);
}
function testReversedAlias() {
  const sh=mock([
    row('a','Boston College Eagles','Wagner Seahawks',5,'sr:match:73138576'),
    row('b','Wagner Seahawks','Boston College',7)
  ],[plan('g2',['a','b'],[true])]);
  const result=context.aiMergeQueueApply_();
  assert.equal(result.mergedGroups,1);
  assert.equal(sh['Archiv duplicit'].rows[2][3],'AUTO MERGED FROM REVERSED');
  const aliases=context.manualArchiveLinks_({
    getSheetByName:name=>sh[name]||null
  },sh.Zápasy.rows.slice(1)).teamAliases;
  const learned=aliases.find(x=>x.source==='1xBit'&&x.team==='Wagner Seahawks');
  assert(learned);
  assert.equal(learned.canonical,'Wagner Seahawks');
}
function testConflictingIdsAndDatesBlocked() {
  const sh=mock([
    row('a','Boston College Eagles','Wagner Seahawks',5,'sr:match:73138576'),
    row('b','Wagner Seahawks','Boston College',7,'sr:match:99999999'),
    row('c','Wagner Seahawks','Boston College',7,'','2026-11-06')
  ],[
    plan('g1',['a','b'],[true]),
    plan('g2',['a','c'],[true]),
    plan('g3',['a','b'],[true],'PROVĚŘIT')
  ]);
  const r=context.aiMergeQueueApply_();
  assert.equal(r.mergedGroups,0);
  assert.equal(r.blocked,2);
  assert.equal(sh.Zápasy.rows.length,4);
  assert.equal(sh['AI sloučení'].rows[1][9],'BLOKOVÁNO');
  assert.equal(sh['AI sloučení'].rows[2][9],'BLOKOVÁNO');
  assert.equal(sh['AI sloučení'].rows[3][9],'');
}
function testSlashCompositeArchivedDeletedOnlyOnApply() {
  const composite=row('multi',
    'Utah Jazz/Cleveland Cavaliers',
    'New Orleans Pelicans/Oklahoma City Thunder',7);
  const real=row('real','Utah Jazz','New Orleans Pelicans',5,'sr:match:11111111');
  const legitSlash=row('clubSlash','ABC/DEF University','Wyoming',7);
  const sheets=mock([real,composite,legitSlash],[]);
  const before=context.aiMergeQueuePreview_();
  assert.equal(before.removable,1);
  assert.equal(sheets.Zápasy.rows.length,4);
  const result=context.aiMergeQueueApply_();
  assert.equal(result.removedComposites,1);
  assert.equal(result.removedRows,1);
  assert.equal(sheets.Zápasy.rows.length,3);
  assert.equal(sheets.Zápasy.rows[1][0],'real');
  assert.equal(sheets.Zápasy.rows[2][0],'clubSlash');
  assert.equal(sheets['Archiv duplicit'].rows[1][3],'REMOVED MULTI-FIXTURE');
  assert.equal(context.aiMergeQueuePreview_().removable,0);
}
function testSourceOverlapBlocksMergeAndCompositeFilter() {
  const sh=mock([
    row('a','Boston College Eagles','Wagner Seahawks',7),
    row('b','Boston College','Wagner Seahawks',7)
  ],[plan('g',['a','b'],[false])]);
  assert.equal(context.aiMergeQueueApply_().mergedGroups,0);
  assert.equal(sh['AI sloučení'].rows[1][9],'BLOKOVÁNO');
  assert.equal(context.multipleFixtureListing_('A/B','C/D'),false);
  assert.equal(context.multipleFixtureListing_('Lakers/Bulls','Jazz/Celtics'),true);
  assert.equal(context.multipleFixtureListing_('ABC/DEF','Bulls'),false);
}
testStableKeyTripleAndArchive();
testReversedAlias();
testConflictingIdsAndDatesBlocked();
testSlashCompositeArchivedDeletedOnlyOnApply();
testSourceOverlapBlocksMergeAndCompositeFilter();
console.log('AI queue: 5 grouped merge, archived delete and safety tests passed');
