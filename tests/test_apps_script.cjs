const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Run the exact file used by the deployed Apps Script; tests do not call its
// Google APIs. The isolate keeps these unit tests self-contained.
const context = { console };
vm.createContext(context);
vm.runInContext(fs.readFileSync('GoogleAppsScript.gs', 'utf8'), context);

function row(date, league, home, away, id = '') {
  const cells = Array(13).fill('');
  cells[1] = date;
  cells[2] = league;
  cells[3] = home;
  cells[4] = away;
  cells[12] = id;
  return cells;
}
function same(leagueA, homeA, awayA, leagueB, homeB, awayB, expected = true) {
  const old = row('2026-11-02', leagueB, homeB, awayB);
  const actual = context.sameFixture_('2026-11-02', homeA, awayA, leagueA, old, '');
  assert.equal(actual, expected,
    [leagueA, homeA, awayA, leagueB, homeB, awayB].join(' / '));
}

same('Řecko / Elite League', 'AS Papagou', 'Panionios BC Atény',
  'Greece. Elite League', 'Papagou', 'Panionios');
same('FIBA Europe Cup', 'Wurzburg', 'Tartu Ulikool',
  'Mezinárodní / Evropský pohár', 'Würzburg Baskets', 'Tartu Ulikool');
same('VTB League Cup', 'Zenit Saint-Petersburg', 'KK Igokea',
  'Mezinárodní / United Cup', 'Zenit Petrohrad', 'KK Igokea Aleksandrovac');
same('Israel. Superleague', 'Hapoel Galil Elyon', 'Ironi Nes Ziona',
  'Izrael / Superliga', 'Hapoel Galil Elion Safed', 'Ironi Ness Ziona');
same('Israel. Superleague', 'Hapoel Holon', 'Maccabi Rishon-le-Tsion',
  'Izrael / Superliga', 'Hapoel Holon BC', 'Maccabi Rishon');
same('Sweden. Basketligan', 'KFUM Uppsala', 'Boras',
  'Švédsko / SBL', 'Uppsala', 'Boras Basket');
same('French Cup', 'ADA Blois Basket 41', 'Denain ASC Voltaire',
  'Francie / Pohár', 'ADA Blois', 'Denain Voltaire');
same('Italy Championship U19', 'Gran Torino Basketball Draft U19', 'Allianz Derthona U19',
  'Itálie / Eccellenza, U19', 'Grantorino Basketball Draft U19', 'Derthona Basket U19');
same('Greece. Regional League A1', 'Pkao Amilla', 'Vrilissiakos',
  'Eskana A1', 'Pkao Amilla', 'AO Vrilisiakos');
same('WNCAA', 'Nebraska Cornhuskers (Women)', 'Sao Jose State (Women)',
  'USA / NCAA, ženy', 'Nebraska Huskers', 'San Jose State Spartans');

// Safety: different divisions, youth and dates must never be merged.
same('Greece. Elite League', 'Papagou U19', 'Panionios',
  'Greece. Elite League', 'AS Papagou', 'Panionios Athens', false);
same('Greece. Elite League', 'Papagou (Women)', 'Panionios (Women)',
  'Greece. Elite League', 'AS Papagou', 'Panionios Athens', false);
same('Greece. Elite League', 'Papagou', 'Different Club',
  'Greece. Elite League', 'AS Papagou', 'Panionios Athens', false);

const conflict = row('2026-11-02', 'Greece. Elite League', 'AS Papagou', 'Panionios Athens',
  'sr:match:11111111');
assert.equal(context.sameFixture_('2026-11-02', 'Papagou', 'Panionios',
  'Greece. Elite League', conflict, 'sr:match:22222222'), false);
assert.equal(context.sameFixture_('2026-11-03', 'Papagou', 'Panionios',
  'Greece. Elite League', conflict, ''), false);

console.log('Apps Script matching tests passed (15 cases)');
