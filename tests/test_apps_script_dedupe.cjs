const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = {
  console,
  Utilities: {formatDate: v => new Date(v).toISOString().replace('T', ' ').slice(0, 19)}
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('GoogleAppsScript.gs', 'utf8'), context);
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

testMultipleAliasesMergeAndAudit();
testKnownIdOverridesNameDifferenceButNotGender();
testConflictAndCategoriesRemainSeparateAndFlagged();
testMultipleIdsAcrossThirdVariantNotTransitive();
console.log('Historical duplicate detection, merge, audit and conflict tests passed');
