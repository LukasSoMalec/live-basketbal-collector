const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = {
  console,
  Utilities: {formatDate: value => new Date(value).toISOString().replace('T', ' ').slice(0, 19)}
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('GoogleAppsScript.gs', 'utf8'), context);
vm.runInContext(fs.readFileSync('AutoMerge.gs', 'utf8'), context);

class Sheet {
  constructor(rows=[]) {this.rows=rows.map(r=>r.slice());}
  getLastRow() {return this.rows.length;}
  getRange(r,c,n=1,w=1) {
    const sh=this;
    return {
      getValues:()=>Array.from({length:n},(_,i)=>
        Array.from({length:w},(_,j)=>sh.rows[r+i-1]?.[c+j-1]??'')),
      setValues(values) {
        assert.equal(values.length,n);
        for(let i=0;i<n;i++) {
          assert.equal(values[i].length,w);
          while(sh.rows.length<r+i) sh.rows.push([]);
          for(let j=0;j<w;j++) sh.rows[r+i-1][c+j-1]=values[i][j];
        }
      }
    };
  }
  deleteRows(row,count) {assert(row>1);this.rows.splice(row-1,count);}
  setFrozenRows() {}
}
const base = (key, league, home, away, date, sourceCol, note, first='2026-11-05 10:00:00') => {
  const r=[key,date,league,home,away,'NEOVĚŘENO','NEOVĚŘENO',
    'NEOVĚŘENO','NEOVĚŘENO',first,first,2,note||''];
  r[sourceCol]='ANO';return r;
};
function mockSheet(rows,aliases=[]) {
  const sheets={
    Zápasy:new Sheet([Array(13).fill('header'),...rows]),
    'Aliasy týmů':new Sheet([Array(8).fill('header'),...aliases])
  };
  const ss={
    getSheetByName:name=>sheets[name]||null,
    insertSheet:name=>(sheets[name]=new Sheet())
  };
  context.SpreadsheetApp={openById:()=>ss};
  return sheets;
}

function testVerifiedReversalAndArchive() {
  const date='2026-11-05';
  const x=base('a','USA / NCAA','Boston College Eagles','Wagner Seahawks',
    date,5,'sr:match:88888888');
  const y=base('b','NCAA','Wagner Seahawks','Boston College',
    date,7,'sr:match:88888888','2026-11-05 10:10:00');
  const sheets=mockSheet([x,y]);
  const preview=context.autoMergePreview_();
  assert.equal(preview.safe,1);
  assert.equal(preview.review,0);
  assert.equal(preview.proposals[0].reversed,true);
  const result=context.autoMergeApply_([preview.proposals[0].id]);
  assert.equal(result.merged,1);
  assert.equal(sheets.Zápasy.getLastRow(),2);
  const final=sheets.Zápasy.rows[1];
  assert.equal(final[0],'a');
  assert.equal(final[5],'ANO');
  assert.equal(final[7],'ANO');
  assert.equal(final[11],2);
  assert.equal(sheets['Archiv duplicit'].rows[2][3],
    'AUTO MERGED FROM REVERSED');
  const learned=context.manualArchiveLinks_(sheetsToSs(sheets),
    sheets.Zápasy.rows.slice(1));
  const aliases=learned.teamAliases;
  const flip=aliases.find(z=>z.team==='Wagner Seahawks' && z.source==='1xBit');
  assert(flip);
  assert.equal(flip.canonical,'Wagner Seahawks');
  assert.equal(context.autoMergePreview_().proposals.length,0);
  assert.throws(()=>context.autoMergeApply_([preview.proposals[0].id]),
    /Zápasy se mezitím změnily/);
}
function sheetsToSs(sheets) {
  return {getSheetByName:name=>sheets[name]||null};
}
function testNoConflictingIdsGenderOrDates() {
  const a=base('a','USA / NCAA','Boston College Eagles','Wagner Seahawks',
    '2026-11-05',5,'sr:match:88888888');
  const conflict=base('b','USA / NCAA','Wagner Seahawks','Boston College Eagles',
    '2026-11-05',7,'sr:match:99999999');
  const differentDay=base('c','USA / NCAA','Boston College Eagles','Wagner Seahawks',
    '2026-11-06',7,'sr:match:88888888');
  const women=base('d','USA / WNCAA','Boston College Eagles Women','Wagner Seahawks Women',
    '2026-11-05',7,'sr:match:88888888');
  mockSheet([a,conflict,differentDay,women]);
  const preview=context.autoMergePreview_();
  assert.equal(preview.proposals.length,0);
}
function testAliasSafetyAndConfirmedFixture() {
  const aliases=[
    ['1xBit','Philippines. NCAA','San Sebastian College',
      'Sscr Stags','adult|unspecified','Filipíny / NCAA, seniors',
      'Ruční sloučení','ANO'],
    ['1xBit','Philippines. NCAA','Mapua Cardinals',
      'Mapua Cardinals','adult|unspecified','Filipíny / NCAA, seniors',
      'Ruční sloučení','ANO']
  ];
  const date='2026-11-07';
  const a=base('a','Filipíny / NCAA, seniors','Sscr Stags','Mapua Cardinals',
    date,5,'sr:match:77777777');
  const b=base('b','Philippines. NCAA','San Sebastian College','Mapua Cardinals',
    date,7,'');
  mockSheet([a,b],aliases);
  const preview=context.autoMergePreview_();
  assert.equal(preview.safe,1);
  assert.equal(preview.proposals[0].reversed,false);
  const res=context.autoMergeApply_([preview.proposals[0].id]);
  assert.equal(res.merged,1);
}
function testDangerousSimilarGamesRequireReview() {
  const a=base('a','USA / NCAA','Arizona Wildcats','Arizona State Sun Devils',
    '2026-11-05',5,'');
  const b=base('b','USA / NCAA','Arizona Wildcats','Arizona State Sun Devils',
    '2026-11-05',5,'');
  const sheets=mockSheet([a,b]);
  const p=context.autoMergePreview_();
  assert.equal(p.safe,0);
  assert.equal(p.review,1);
  assert.equal(sheets.Zápasy.getLastRow(),3);
}
function testInvalidInputCannotModifyRows() {
  const a=base('a','USA / NCAA','A','B','2026-11-05',5,'');
  const sheets=mockSheet([a]);
  assert.throws(()=>context.autoMergeApply_([]),/Vyber/);
  assert.equal(sheets.Zápasy.getLastRow(),2);
}
testVerifiedReversalAndArchive();
testNoConflictingIdsGenderOrDates();
testAliasSafetyAndConfirmedFixture();
testDangerousSimilarGamesRequireReview();
testInvalidInputCannotModifyRows();
console.log('AutoMerge: 5 preview, safety, archive and learning tests passed.');
