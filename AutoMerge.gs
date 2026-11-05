/**
 * AutoMerge.gs — doplněk ke stávajícímu GoogleAppsScript.gs.
 * Vyhodnocuje možné duplicity a provádí jen výslovně potvrzená sloučení.
 * Autor: LM; licence MIT.
 */
function autoMergeBigrams_(value) {
  const s = normTeam_(value).replace(/\s+/g, '');
  const parts = new Set();
  for (let i = 0; i < s.length - 1; i++) parts.add(s.slice(i, i + 2));
  return parts;
}

function autoMergeSimilarity_(left, right, ignoreWomen) {
  if (sameTeam_(left, right, ignoreWomen)) return 1;
  const a = autoMergeBigrams_(left), b = autoMergeBigrams_(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return 2 * shared / (a.size + b.size);
}

function autoMergeIdentity_(row, team, aliases) {
  const cls = fixtureClass_(row[2], row[3], row[4]);
  const options = new Set();
  for (let i = 0; i < SOURCES.length; i++) {
    if (String(row[5 + i]) !== 'ANO') continue;
    const x = canonicalTeamAlias_(aliases, SOURCES[i], row[2], team, cls);
    if (x && x.canonical) options.add(x.canonical);
  }
  if (options.size > 1) return ''; // Conflict: disable matching.
  return options.size ? [...options][0] : normTeam_(team);
}

function autoMergeLeague_(row, aliases) {
  const label = normLeague_(row[2]);
  if (!label) return '';
  return aliases.leagueGroups.has(label) ? aliases.leagueGroups.get(label) : label;
}

function autoMergeEvaluate_(a, b, aliases) {
  if (matchDateKey_(a[1]) !== matchDateKey_(b[1])) return null;
  const cls = fixtureClass_(a[2], a[3], a[4]);
  if (cls !== fixtureClass_(b[2], b[3], b[4])) return null;
  const aId = eventId_(a[12]), bId = eventId_(b[12]);
  if (aId && bId && aId !== bId) return null;
  const aFootball = rowFootballOpaqueId_(a[12]);
  const bFootball = rowFootballOpaqueId_(b[12]);
  if (aFootball && bFootball && aFootball !== bFootball) return null;

  const sameVerifiedId = Boolean((aId && aId === bId) ||
    (aFootball && aFootball === bFootball));
  if ((rapidRepeatLeague_(a[2]) || rapidRepeatLeague_(b[2])) && !sameVerifiedId)
    return null;

  const left = [autoMergeIdentity_(a, a[3], aliases),
    autoMergeIdentity_(a, a[4], aliases)];
  const right = [autoMergeIdentity_(b, b[3], aliases),
    autoMergeIdentity_(b, b[4], aliases)];
  if ([...left, ...right].some(x => !x)) return null;
  const ignoreWomen = cls.endsWith('|women');
  const sims = [
    [
      autoMergeSimilarity_(left[0], right[0], ignoreWomen),
      autoMergeSimilarity_(left[1], right[1], ignoreWomen)
    ],
    [
      autoMergeSimilarity_(left[0], right[1], ignoreWomen),
      autoMergeSimilarity_(left[1], right[0], ignoreWomen)
    ]
  ];
  const averages = sims.map(v => (v[0] + v[1]) / 2);
  const reversed = averages[1] > averages[0];
  const best = sims[reversed ? 1 : 0];
  const mean = averages[reversed ? 1 : 0];
  const min = Math.min(...best);
  const aLeague = autoMergeLeague_(a, aliases), bLeague = autoMergeLeague_(b, aliases);
  const leagueMatch = Boolean(aLeague && bLeague && aLeague === bLeague);
  const sharedSource = SOURCES.some((_, i) =>
    a[5 + i] === 'ANO' && b[5 + i] === 'ANO');

  // Verified identity is necessary but not sufficient if gender/age disagrees.
  // Name-based auto merging needs both teams + compatible league + no
  // evidence of two matches from the same sportsbook.
  if (sameVerifiedId) return {level:'safe', score:1,
    reason:'Shodné ověřené ID', reversed};
  if (leagueMatch && min === 1 && !sharedSource &&
      (aId || bId || aFootball || bFootball))
    return {level:'safe', score:1,
      reason:'Oba týmy sedí přesně nebo podle aliasů', reversed};
  if ((leagueMatch || (min >= 0.97 && !sharedSource)) &&
      mean >= 0.79 && min >= 0.65)
    return {level:'review', score:Math.round(mean * 100) / 100,
      reason:'Podobné názvy – ověřit ručně', reversed};
  return null;
}

function autoMergePlan_(rows, aliases) {
  if (rows.length > 3000) throw new Error('Příliš mnoho řádků (maximum 3000)');
  const buckets = new Map();
  rows.forEach((r, i) => {
    const key = matchDateKey_(r[1]) + '|' +
      fixtureClass_(r[2], r[3], r[4]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  const result = [];
  for (const indices of buckets.values()) {
    for (let j = 0; j < indices.length; j++) {
      for (let k = j + 1; k < indices.length; k++) {
        const i = indices[j], n = indices[k];
        const evalResult = autoMergeEvaluate_(rows[i], rows[n], aliases);
        if (!evalResult) continue;
        const master = chooseHistoricalMaster_(rows, [i,n]);
        const removed = master === i ? n : i;
        const m = rows[master], d = rows[removed];
        if (!m[0] || !d[0] || String(m[0]) === String(d[0])) continue;
        result.push({
          id: [String(m[0]), String(d[0])].join('\n'),
          masterKey: String(m[0]), removedKey: String(d[0]),
          masterRow: master + 2, removedRow: removed + 2,
          date: matchDateKey_(m[1]), league: String(m[2]),
          master: String(m[3]) + ' – ' + String(m[4]),
          duplicate: String(d[3]) + ' – ' + String(d[4]),
          otherLeague: String(d[2]), reversed:evalResult.reversed,
          level:evalResult.level, score:evalResult.score,
          reason:evalResult.reason
        });
      }
    }
  }
  // Multiple candidate masters are review-only: never auto-select them.
  const collisions = new Map();
  for (const c of result) {
    collisions.set(c.removedKey, (collisions.get(c.removedKey) || 0) + 1);
  }
  for (const c of result) {
    if (collisions.get(c.removedKey) > 1 && c.level === 'safe') {
      c.level = 'review';
      c.reason = 'Více možných cílových řádků';
    }
  }
  return result.sort((a, b) => a.level === b.level ?
    b.score - a.score : a.level === 'safe' ? -1 : 1).slice(0, 250);
}

function autoMergePreview_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('Zápasy');
  if (!sh) throw new Error('Nenalezena záložka Zápasy');
  const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, 13).getValues() : [];
  const manual = manualArchiveLinks_(ss, rows);
  const aliases = readTeamAliases_(ss, manual.teamAliases);
  const proposals = autoMergePlan_(rows, aliases);
  return {ok:true, totalRows:rows.length,
    safe:proposals.filter(x => x.level === 'safe').length,
    review:proposals.filter(x => x.level === 'review').length,
    proposals};
}

function autoMergeApply_(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 60 ||
      ids.some(id => typeof id !== 'string' || id.length > 700))
    throw new Error('Vyber 1 až 60 návrhů');
  if (new Set(ids).size !== ids.length) throw new Error('Opakované návrhy');
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('Zápasy');
  if (!sh) throw new Error('Nenalezena záložka Zápasy');
  const count = sh.getLastRow();
  const rows = count > 1 ? sh.getRange(2, 1, count - 1, 13).getValues() : [];
  const manual = manualArchiveLinks_(ss, rows);
  const aliases = readTeamAliases_(ss, manual.teamAliases);
  const allowed = new Map(autoMergePlan_(rows, aliases).map(x => [x.id, x]));
  const selected = ids.map(id => allowed.get(id));
  if (selected.some(x => !x))
    throw new Error('Zápasy se mezitím změnily. Obnov náhled a zkus to znovu.');

  const index = new Map();
  rows.forEach((r, i) => {
    const key = String(r[0] || '');
    if (index.has(key)) index.set(key, -1);
    else index.set(key, i);
  });
  const removedKeys = new Set(selected.map(x => x.removedKey));
  const deleted = new Set();
  const archive = [];
  const updated = new Set();
  const stamp = Utilities.formatDate(new Date(), 'Europe/Prague',
    'yyyy-MM-dd HH:mm:ss');
  for (const item of selected) {
    if (removedKeys.has(item.masterKey))
      throw new Error('Řetězené sloučení. Vyber jen jeden cílový řádek.');
    const mi = index.get(item.masterKey), di = index.get(item.removedKey);
    if (mi === undefined || di === undefined || mi < 0 || di < 0 ||
        mi === di || deleted.has(di))
      throw new Error('Nejednoznačné nebo opakované klíče zápasů.');
    const master = rows[mi], duplicate = rows[di];
    // Re-validate for safety, even when another merge in this batch changed
    // the master row in memory.
    if (!autoMergeEvaluate_(master, duplicate, aliases))
      throw new Error('Sloučení již není bezpečně ověřitelné.');
    archive.push([stamp, master[0], mi+2, 'MASTER BEFORE', ...master.slice()]);
    archive.push([stamp, master[0], di+2,
      item.reversed ? 'AUTO MERGED FROM REVERSED' : 'AUTO MERGED FROM',
      ...duplicate.slice()]);
    for (let col = 5; col <= 8; col++) {
      const values = [master[col], duplicate[col]];
      master[col] = values.includes('ANO') ? 'ANO' :
        values.includes('NE') ? 'NE' : 'NEOVĚŘENO';
    }
    if (comparableStamp_(duplicate[9]) &&
        (!comparableStamp_(master[9]) ||
          comparableStamp_(duplicate[9]) < comparableStamp_(master[9])))
      master[9] = duplicate[9];
    if (comparableStamp_(duplicate[10]) >
        comparableStamp_(master[10])) master[10] = duplicate[10];
    master[11] = Math.max(Number(master[11]) || 0,
      Number(duplicate[11]) || 0);
    const combined = new Set(String(master[12] || '').split(/;\s*/)
      .concat(String(duplicate[12] || '').split(/;\s*/))
      .map(s => s.trim()).filter(Boolean));
    master[12] = [...combined].join('; ');
    deleted.add(di);
    updated.add(mi);
  }

  // Archive comes before any deletion; originals are recoverable.
  archiveHistoricalDuplicates_(ss, archive);
  for (const i of updated)
    sh.getRange(i+2, 1, 1, 13).setValues([rows[i]]);
  deleteHistoricalDuplicateRows_(sh, [...deleted].sort((a,b) => b-a));
  return {ok:true, merged:deleted.size, archived:archive.length,
    remaining:rows.length - deleted.size};
}
