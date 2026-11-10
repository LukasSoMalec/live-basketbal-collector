/**
 * Připojit jako Google Apps Script ke stávajícímu dokumentu Google Sheets.
 * Script Properties: INGEST_KEY = silný náhodný tajný klíč (64 hex znaků).
 * Deploy -> Web App -> Execute as: Me, Who has access: Anyone.
 * Nikdy sem nevkládej cookies nebo token ze SynotTipu.
 */
const SPREADSHEET_ID = '1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI';
const SOURCES = ['SynotTip', 'Fonbet', '1xBit', 'Football.com'];
const COL_BY_SOURCE = { 'SynotTip': 5, 'Fonbet': 6, '1xBit': 7, 'Football.com': 8 }; // zero-based

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = String(body.action || '');
    const isMerge = ['autoMerge.preview', 'autoMerge.apply',
      'aiMerge.preview', 'aiMerge.apply'].includes(action);
    // A separate, purpose-limited key prevents exposing the ingest key
    // in Tampermonkey. Do not reuse SHEETS_INGEST_KEY for the browser UI.
    const property = isMerge ? 'MERGE_KEY' : 'INGEST_KEY';
    const requiredKey = PropertiesService.getScriptProperties().getProperty(property);
    if (!requiredKey || !body.key || body.key !== requiredKey) {
      return json_({ok: false, error: 'Unauthorized'});
    }
    if (!lock.tryLock(25000)) return json_({ok: false, error: 'Locked; retry next run'});
    if (action === 'autoMerge.preview') return json_(autoMergePreview_());
    if (action === 'autoMerge.apply') return json_(autoMergeApply_(body.ids));
    if (action === 'aiMerge.preview') return json_(aiMergeQueuePreview_());
    if (action === 'aiMerge.apply') return json_(aiMergeQueueApply_());
    return json_(saveSnapshot_(body));
  } catch (err) {
    return json_({ok: false, error: String(err.message || err).slice(0, 300)});
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function doGet() {
  return json_({ok: true, service: 'LIVE basketball ingest', note: 'POST requires key'});
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
}

// Identifies one feed row containing multiple different fixtures (teams
// separated by / in BOTH columns). Single slash in a club name is not enough.
function multipleFixtureListing_(home, away) {
  const parts = value => String(value || '').split('/')
    .map(v => v.trim()).filter(Boolean);
  const h = parts(home), a = parts(away);
  return h.length >= 2 && a.length >= 2 && h.length === a.length &&
    h.every(v => v.length >= 3) && a.every(v => v.length >= 3);
}

function norm_(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normTeam_(text) {
  let n = norm_(text);
  n = n.replace(/\bpetrohrad\b/g, 'saint petersburg')
    .replace(/\bgrantorino\b/g, 'gran torino')
    .replace(/\belion\b/g, 'elyon')
    .replace(/\bness\b/g, 'nes')
    .replace(/\bvrilissiakos\b/g, 'vrilisiakos')
    .replace(/\bcornhuskers\b/g, 'huskers')
    .replace(/\bateny\b/g, 'athens')
    .replace(/\bathina\b/g, 'athens')
    .replace(/\bzene\b/g, 'women')
    .replace(/\bada blois basket 41\b/g, 'ada blois')
    .replace(/\bsao jose state\b/g, 'san jose state')
    .replace(/\bsan jose state spartans\b/g, 'san jose state');
  const generic = new Set([
    'as', 'bc', 'bk', 'kk', 'sk', 'jk', 'fc', 'ac', 'ao', 'asc',
    'kfum', 'basket', 'baskets', 'basketball', 'club', 'draft', 'allianz'
  ]);
  return n.split(' ').filter(t => t && !generic.has(t)).join(' ');
}

function fixtureClass_(league, home, away) {
  const label = norm_([league, home, away].join(' '));
  const age = label.match(/\bu(?:1[3-9]|2[0-3])\b/)?.[0] || 'adult';
  // WNBL is intrinsically a women's league even when team names omit (Women).
  const gender = /\b(wnbl|women|woman|zene|zeny|w|wncaa)\b/.test(label)
    ? 'women' : /\b(men|muzi)\b/.test(label) ? 'men' : 'unspecified';
  return age + '|' + gender;
}

function teamWords_(name, ignoreWomen) {
  let tokens = normTeam_(name).split(' ').filter(Boolean);
  if (ignoreWomen) tokens = tokens.filter(t => !['w', 'women', 'woman'].includes(t));
  return tokens;
}

function teamCore_(name, ignoreWomen) {
  const parts = teamWords_(name, ignoreWomen);
  const citySuffix = new Set([
    'athens', 'moscow', 'saint', 'petersburg', 'chelyabinsk',
    'kursk', 'vratsa', 'doha', 'nicosia', 'kedainiai', 'aleksandrovac',
    'safed', 'le', 'tsion'
  ]);
  while (parts.length > 1 && citySuffix.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

function sameTeam_(a, b, ignoreWomen) {
  const x = teamWords_(a, ignoreWomen), y = teamWords_(b, ignoreWomen);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const protectedWords = new Set(['women', 'woman', 'w', 'men', 'u18', 'u19', 'u20',
    'u21', 'u22', 'u23', 'reserves', 'reserve', 'academy', 'junior', 'juniors',
    'ii', 'iii', 'b', '2']);
  const sig = tokens => tokens.filter(w => protectedWords.has(w)).sort().join('|');
  if (sig(x) !== sig(y)) return false;
  return teamCore_(a, ignoreWomen) === teamCore_(b, ignoreWomen);
}

function normLeague_(text) {
  return norm_(text).replace(/\brecko\b/g, 'greece')
    .replace(/\bfrancie\b/g, 'france')
    .replace(/\bzene\b/g, 'women');
}

// Provider-specific short name: in Australian WNBL "Perth (w)" refers to
// Perth Lynx. Never apply this to men's NBL or unrelated regional leagues.
function fixtureTeamAlias_(team, competition) {
  if (/\bwnbl\b/.test(normLeague_(competition)) &&
      /^perth(?:\s+(?:w|women))?$/.test(normTeam_(team)))
    return 'Perth Lynx';
  return team;
}

function sameFixture_(date, home, away, competition, row, incomingId) {
  if (matchDateKey_(date) !== matchDateKey_(row[1])) return false;
  const existingId = eventId_(row[12]);
  if (incomingId && existingId && incomingId !== existingId) return false;
  const incomingClass = fixtureClass_(competition, home, away);
  const oldClass = fixtureClass_(row[2], row[3], row[4]);
  if (incomingClass !== oldClass) return false;

  const ignoreWomen = incomingClass.endsWith('|women');
  // An alias must be validated by both competition labels, not just one.
  const bothWnbl = /\bwnbl\b/.test(normLeague_(competition)) &&
    /\bwnbl\b/.test(normLeague_(row[2]));
  const h = bothWnbl ? fixtureTeamAlias_(home, competition) : home;
  const a = bothWnbl ? fixtureTeamAlias_(away, competition) : away;
  const rh = bothWnbl ? fixtureTeamAlias_(row[3], row[2]) : row[3];
  const ra = bothWnbl ? fixtureTeamAlias_(row[4], row[2]) : row[4];
  const forward = sameTeam_(h, rh, ignoreWomen) &&
    sameTeam_(a, ra, ignoreWomen);
  const reverse = sameTeam_(h, ra, ignoreWomen) &&
    sameTeam_(a, rh, ignoreWomen);
  if (!forward && !reverse) return false;

  const leagueA = normLeague_(competition);
  const leagueB = normLeague_(row[2]);
  if (!leagueA || !leagueB) return false;

  // Trust two equal, distinctive team identities on the same date, even if
  // providers translate competition names or reverse team order.
  const hCore = teamCore_(h, ignoreWomen);
  const aCore = teamCore_(a, ignoreWomen);
  const rHCore = teamCore_(rh, ignoreWomen);
  const rACore = teamCore_(ra, ignoreWomen);
  const identicalPairs = forward && hCore === rHCore && aCore === rACore;
  const reversePairs = reverse && hCore === rACore && aCore === rHCore;
  if (identicalPairs || reversePairs) return true;
  return leagueA === leagueB;
}

function chooseMatch_(rows, date, home, away, competition, incomingId,
                      aliases = null, source = '') {
  const candidates = [];
  for (let ix = 0; ix < rows.length; ix++) {
    if (sameFixture_(date, home, away, competition, rows[ix], incomingId) ||
        sameLearnedAliasFixture_(aliases, source, date, home, away,
          competition, rows[ix], incomingId))
      candidates.push(ix);
  }
  if (!candidates.length) return -1;
  const ids = new Set(candidates.map(ix => eventId_(rows[ix][12])).filter(Boolean));
  if (ids.size > 1) return -1;
  if (incomingId && ids.size && !ids.has(incomingId)) return -1;
  const withId = candidates.filter(ix => eventId_(rows[ix][12]));
  if (withId.length) return withId[0];
  // If several different candidates have no verified ID, do not arbitrarily
  // pick one that could represent a second match on the same date.
  const exactLeague = candidates.filter(ix =>
    normLeague_(rows[ix][2]) === normLeague_(competition));
  if (exactLeague.length === 1) return exactLeague[0];
  return candidates.length === 1 ? candidates[0] : -1;
}

function eventId_(text) {
  const m = String(text || '').match(/(?:sr:match:|ExternalID\s*[:=]?\s*['"]?)(\d{5,})/i);
  return m ? 'sr:match:' + m[1] : '';
}

// BSKT CUP runs many actual basketball games. Repeated opponents on a single
// day must not be treated as the same match merely from their names.
function rapidRepeatLeague_(name) {
  return /\bbskt\s+cup\b/i.test(String(name || ''));
}

function footballOpaqueId_(text) {
  const value = String(text || '').trim();
  if (!/^sr:match:[a-zA-Z0-9|_-]{6,120}$/.test(value)) return '';
  return /^sr:match:\d+$/.test(value) ? '' : value;
}

function rowFootballOpaqueId_(notes) {
  const match = String(notes || '').match(/football:event:(sr:match:[a-zA-Z0-9|_-]{6,120})/);
  return match ? match[1] : '';
}

function matchDateKey_(value) {
  // getValues() returns Date objects for date-formatted Sheets cells, even
  // when the API originally wrote an ISO string such as '2026-11-02'.
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Europe/Prague', 'yyyy-MM-dd');
  }
  return String(value || '').trim().slice(0, 10);
}

function exactKey_(date, home, away) {
  return `${matchDateKey_(date)}|${normTeam_(home)}|${normTeam_(away)}`;
}


// Conservative retrospective deduplication. This runs on every successful
// ingestion, so matches no longer present in any LIVE feed can still be fixed.
// A match with different trustworthy Sportradar IDs is NEVER auto-merged.
function sameHistoricalFixture_(a, b) {
  if (matchDateKey_(a[1]) !== matchDateKey_(b[1])) return false;
  const aId = eventId_(a[12]), bId = eventId_(b[12]);
  if (aId && bId && aId !== bId) return false;
  if (rapidRepeatLeague_(a[2]) || rapidRepeatLeague_(b[2])) {
    const aOpaque = rowFootballOpaqueId_(a[12]);
    const bOpaque = rowFootballOpaqueId_(b[12]);
    return Boolean((aId && bId && aId === bId) ||
      (aOpaque && bOpaque && aOpaque === bOpaque));
  }
  const aClass = fixtureClass_(a[2], a[3], a[4]);
  if (aClass !== fixtureClass_(b[2], b[3], b[4])) return false;
  if (aId && bId && aId === bId) return true;
  return sameFixture_(a[1], a[3], a[4], a[2], b, aId);
}

function comparableStamp_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime()))
    return Utilities.formatDate(value, 'Europe/Prague', 'yyyy-MM-dd HH:mm:ss');
  return String(value || '');
}

function joinHistoricalNotes_(notes) {
  const unique = new Set();
  for (const note of notes) {
    for (const part of String(note || '').split(/\s*;\s*/)) {
      const trimmed = part.trim();
      if (trimmed && !trimmed.startsWith('ZKONTROLOVAT DUPLIKAT'))
        unique.add(trimmed);
    }
  }
  return [...unique].join('; ');
}

function possibleHistoricalDuplicate_(a, b) {
  if (rapidRepeatLeague_(a[2]) || rapidRepeatLeague_(b[2])) return false;
  if (matchDateKey_(a[1]) !== matchDateKey_(b[1])) return false;
  if (fixtureClass_(a[2], a[3], a[4]) !== fixtureClass_(b[2], b[3], b[4]))
    return false;
  const aw = fixtureClass_(a[2], a[3], a[4]).endsWith('|women');
  const paired = (sameTeam_(a[3], b[3], aw) && sameTeam_(a[4], b[4], aw)) ||
    (sameTeam_(a[3], b[4], aw) && sameTeam_(a[4], b[3], aw));
  // Two very similar teams and a distinct Sportradar ID are suspicious,
  // but never evidence that the ID is wrong.
  return paired;
}

function chooseHistoricalMaster_(rows, members) {
  return members.slice().sort((a, b) => {
    const x = rows[a], y = rows[b];
    const xHasId = eventId_(x[12]) ? 1 : 0;
    const yHasId = eventId_(y[12]) ? 1 : 0;
    if (xHasId !== yHasId) return yHasId - xHasId;
    const xt = comparableStamp_(x[9]), yt = comparableStamp_(y[9]);
    if (xt !== yt) return xt < yt ? -1 : 1;
    return a - b;
  })[0];
}

// A cheap, conservative lookup key for the exact team-equivalence rules used
// by sameTeam_(). All candidates are still revalidated by sameHistoricalFixture_.
// WNBL aliases are indexed only as additional possible candidates; the final
// comparison validates that BOTH competitions really are WNBL.
function historicalTeamKey_(team, league, ignoreWomen, allowAlias = true) {
  const value = allowAlias && /\bwnbl\b/.test(normLeague_(league))
    ? fixtureTeamAlias_(team, league) : team;
  const words = teamWords_(value, ignoreWomen);
  const protectedWords = new Set(['women', 'woman', 'w', 'men', 'u18',
    'u19', 'u20', 'u21', 'u22', 'u23', 'reserves', 'reserve', 'academy',
    'junior', 'juniors', 'ii', 'iii', 'b', '2']);
  const sig = words.filter(w => protectedWords.has(w)).sort().join('|');
  return teamCore_(value, ignoreWomen) + '#' + sig;
}

function historicalPairKeys_(row) {
  const cls = fixtureClass_(row[2], row[3], row[4]);
  const isWomen = cls.endsWith('|women');
  const keys = [true, false].map(alias => [
    historicalTeamKey_(row[3], row[2], isWomen, alias),
    historicalTeamKey_(row[4], row[2], isWomen, alias)
  ].sort().join('||'));
  return [...new Set(keys)];
}

function planHistoricalDeduplication_(rows, stamp, explicitLinks = new Map(), limits = {}) {
  // Group only within the same match day and youth/women category.
  const buckets = new Map();
  rows.forEach((r, ix) => {
    if (!r[1] || !r[3] || !r[4]) return;
    const key = matchDateKey_(r[1]) + '|' + fixtureClass_(r[2], r[3], r[4]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ix);
  });
  const groups = [];
  const flagged = new Set();
  // Index likely matches by canonical team pair or exact event ID.
  // Previously every row scanned every other group, then every remaining
  // pair was rechecked. Historical weeks with hundreds of games became slow.
  for (const indices of buckets.values()) {
    const bucketGroups = [];
    const byPair = new Map(), bySrId = new Map(), byOpaqueId = new Map();
    const pairByIndex = new Map();
    function register(map, key, group) {
      if (!key) return;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(group);
    }
    for (const ix of indices) {
      const r = rows[ix];
      const pairs = historicalPairKeys_(r);
      const srid = eventId_(r[12]);
      const opaque = rowFootballOpaqueId_(r[12]);
      pairByIndex.set(ix, pairs);
      const candidates = new Set([
        ...pairs.flatMap(pair => [...(byPair.get(pair) || [])]),
        ...(srid ? bySrId.get(srid) || [] : []),
        ...(opaque ? byOpaqueId.get(opaque) || [] : [])
      ]);
      const matching = [...candidates].filter(g =>
        g.every(j => sameHistoricalFixture_(r, rows[j]) &&
                     sameHistoricalFixture_(rows[j], r)));
      let group;
      if (matching.length === 1) {
        group = matching[0];
        group.push(ix);
      } else {
        if (matching.length > 1) {
          flagged.add(ix);
          matching.forEach(g => g.forEach(j => flagged.add(j)));
        }
        group = [ix];
        bucketGroups.push(group);
      }
      // Register the entire growing group for all of its members. This
      // includes groups linked through equal ID but different team labels.
      for (const pair of pairs) register(byPair, pair, group);
      register(bySrId, srid, group);
      register(byOpaqueId, opaque, group);
    }
    groups.push(...bucketGroups);
    // Potentially conflicting IDs should be flagged, but only equal canonical
    // team pairs could satisfy possibleHistoricalDuplicate_().
    const groupsByPair = new Map();
    for (const group of bucketGroups) {
      const keys = new Set(group.flatMap(ix => pairByIndex.get(ix)));
      for (const pair of keys) register(groupsByPair, pair, group);
    }
    const seenPairs = new Set();
    for (const candidateGroups of groupsByPair.values()) {
      const list = [...candidateGroups];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = bucketGroups.indexOf(list[i]);
          const b = bucketGroups.indexOf(list[j]);
          const key = a + ':' + b;
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          if (list[i].some(ai => list[j].some(bi =>
              possibleHistoricalDuplicate_(rows[ai], rows[bi])))) {
            list[i].forEach(ix => flagged.add(ix));
            list[j].forEach(ix => flagged.add(ix));
          }
        }
      }
    }
  }

  // Honor historic MANUAL MERGED FROM decisions, even across different
  // provider league names, gender labels and other heuristic buckets.
  const pinnedMaster = new Map();
  for (const [from, desiredMaster] of explicitLinks.entries()) {
    if (from === desiredMaster || !rows[from] || !rows[desiredMaster]) continue;
    if (matchDateKey_(rows[from][1]) !== matchDateKey_(rows[desiredMaster][1]))
      continue;
    const oldId = eventId_(rows[from][12]);
    const masterId = eventId_(rows[desiredMaster][12]);
    if (oldId && masterId && oldId !== masterId) continue;
    const oldOpaque = rowFootballOpaqueId_(rows[from][12]);
    const masterOpaque = rowFootballOpaqueId_(rows[desiredMaster][12]);
    if (oldOpaque && masterOpaque && oldOpaque !== masterOpaque) continue;
    if (rapidRepeatLeague_(rows[from][2]) ||
        rapidRepeatLeague_(rows[desiredMaster][2])) continue;
    const a = groups.find(g => g.includes(from));
    const b = groups.find(g => g.includes(desiredMaster));
    if (!a || !b || a === b) {
      if (a && a === b) pinnedMaster.set(a, desiredMaster);
      continue;
    }
    const combined = [...a, ...b];
    const ids = new Set(combined.map(ix => eventId_(rows[ix][12])).filter(Boolean));
    const opaque = new Set(combined.map(ix => rowFootballOpaqueId_(rows[ix][12])).filter(Boolean));
    if (ids.size > 1 || opaque.size > 1) continue;
    b.push(...a);
    groups.splice(groups.indexOf(a), 1);
    pinnedMaster.set(b, desiredMaster);
  }

  const deleteIndices = [];
  const modified = new Set();
  const archive = [];
  const masterByIndex = new Map(rows.map((_, ix) => [ix, ix]));
  let merged = 0;
  let mergedGroups = 0;
  let deferredGroups = 0;
  const maxDeleted = Number.isFinite(limits.maxDeleted) ? limits.maxDeleted : Infinity;
  const maxGroups = Number.isFinite(limits.maxGroups) ? limits.maxGroups : Infinity;
  for (const group of groups) {
    if (group.length < 2) continue;
    if (group.length - 1 > maxDeleted) {
      // Too large for one safe batch: escalate for human review, not an endless retry.
      group.forEach(ix => flagged.add(ix));
      continue;
    }
    if (merged + group.length - 1 > maxDeleted || mergedGroups >= maxGroups) {
      deferredGroups++;
      continue;
    }
    const ids = new Set(group.map(ix => eventId_(rows[ix][12])).filter(Boolean));
    if (ids.size > 1) {
      group.forEach(ix => flagged.add(ix));
      continue;
    }
    const preferred = pinnedMaster.get(group);
    const master = Number.isInteger(preferred) && group.includes(preferred)
      ? preferred : chooseHistoricalMaster_(rows, group);
    const original = group.map(ix => rows[ix].slice());
    for (let i = 0; i < group.length; i++) {
      const ix = group[i];
      archive.push([stamp, rows[master][0], ix + 2, ix === master ? 'MASTER BEFORE' : 'MERGED FROM',
                    ...original[i]]);
      masterByIndex.set(ix, master);
    }
    const target = rows[master];
    for (const ix of group) {
      if (ix === master) continue;
      const other = rows[ix];
      for (let col = 5; col <= 8; col++) {
        // Never lose a confirmed YES; never turn an unverified source into NO.
        if (other[col] === 'ANO') target[col] = 'ANO';
        else if (target[col] !== 'ANO' && other[col] === 'NE') target[col] = 'NE';
      }
      if (comparableStamp_(other[9]) &&
          (!comparableStamp_(target[9]) || comparableStamp_(other[9]) < comparableStamp_(target[9])))
        target[9] = other[9];
      if (comparableStamp_(other[10]) > comparableStamp_(target[10]))
        target[10] = other[10];
      // The same polling run may have counted both rows, so summing would
      // inflate this field. MAX is a conservative count, with original
      // counters preserved in the archive.
      target[11] = Math.max(Number(target[11]) || 0, Number(other[11]) || 0);
      deleteIndices.push(ix);
      merged++;
    }
    target[12] = joinHistoricalNotes_(original.map(r => r[12]));
    if (ids.size === 1 && !eventId_(target[12]))
      target[12] = [...ids][0] + (target[12] ? '; ' + target[12] : '');
    modified.add(master);
    mergedGroups++;
  }
  const deleted = new Set(deleteIndices);
  let reviewCandidates = 0;
  for (const ix of flagged) {
    if (deleted.has(ix)) continue;
    const note = String(rows[ix][12] || '');
    if (!note.includes('ZKONTROLOVAT DUPLIKAT')) {
      rows[ix][12] = note + (note.trim() ? '; ' : '') +
        'ZKONTROLOVAT DUPLIKAT (nejasna shoda, ponechano oddelene)';
      modified.add(ix);
    }
    reviewCandidates++;
  }
  return {
    deleteIndices: deleteIndices.sort((a, b) => b - a),
    modified, masterByIndex, archive, merged, reviewCandidates, deferredGroups
  };
}

function archiveHistoricalDuplicates_(ss, archive) {
  if (!archive.length) return;
  let sheet = ss.getSheetByName('Archiv duplicit');
  if (!sheet) sheet = ss.insertSheet('Archiv duplicit');
  const headers = ['Čas sloučení', 'Klíč zachovaného zápasu', 'Původní řádek', 'Role',
    'Klíč zápasu', 'Datum utkání', 'Soutěž', 'Domácí', 'Hosté',
    'SynotTip', 'Fonbet', '1xBit', 'Football.com', 'Poprvé', 'Naposledy',
    'Počet kontrol', 'Poznámka'];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, archive.length, headers.length)
    .setValues(archive);
}

function deleteHistoricalDuplicateRows_(sheet, indices) {
  // The sheet has a header in row 1, hence array index + 2 = sheet row.
  // All indices are original (pre-deletion) and sorted highest first.
  let start = -1, end = -1;
  function flush() {
    if (start !== -1) sheet.deleteRows(end + 2, start - end + 1);
  }
  for (const ix of indices) {
    if (start < 0) start = end = ix;
    else if (ix === end - 1) end = ix;
    else {
      flush();
      start = end = ix;
    }
  }
  flush();
}

// Read-only audit of the LIVE fixtures rejected by Python filters.
// One record per source + normalized league + reason (no duplicate rows on each poll).
function updateRejectedLeagues_(ss, sourceMap, stamp) {
  let sheet = ss.getSheetByName('Vyřazené soutěže');
  if (!sheet) sheet = ss.insertSheet('Vyřazené soutěže');
  const headers = [
    'Zdroj', 'Soutěž', 'Důvod', 'Poprvé', 'Naposledy',
    'Kontrol s výskytem', 'Součet výskytů', 'V poslední kontrole', 'Příklad zápasu'
  ];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  const lastRow = sheet.getLastRow();
  const rows = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  const index = new Map();
  const keyOf = (source, competition, reason) =>
    [source, norm_(competition), norm_(reason)].join('|');
  rows.forEach((r, i) => {
    if (r[0] && r[1] && r[2])
      index.set(keyOf(String(r[0]), String(r[1]), String(r[2])), i);
  });
  const safeText = text => {
    const raw = String(text || '').trim().slice(0, 160);
    // Don't interpret externally supplied league names as Sheets formulas.
    return /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw;
  };
  let total = 0;
  let distinct = 0;
  for (const source of SOURCES) {
    const info = sourceMap.get(source);
    if (!info || !['ÚSPĚCH', 'ČÁSTEČNĚ'].includes(info.status)) continue;
    const filtered = info.rejectedCompetitions;
    if (!Array.isArray(filtered)) continue;
    // Merge repeated names/reasons within one API snapshot, even if the
    // producer sends duplicate grouped objects.
    const perPoll = new Map();
    for (const item of filtered.slice(0, 250)) {
      if (!item || typeof item !== 'object') continue;
      const competition = safeText(item.competition);
      const reason = safeText(item.reason);
      const example = safeText(item.example);
      const count = Number(item.count);
      if (!competition || !reason || !Number.isSafeInteger(count) ||
          count < 1 || count > 3000) continue;
      const key = keyOf(source, competition, reason);
      const prev = perPoll.get(key);
      perPoll.set(key, {competition: prev?.competition || competition,
        reason: prev?.reason || reason, example: prev?.example || example,
        count: (prev?.count || 0) + count});
    }
    for (const [key, entry] of perPoll.entries()) {
      total += entry.count;
      distinct++;
      let ix = index.get(key);
      if (ix === undefined) {
        ix = rows.length;
        index.set(key, ix);
        rows.push([source, entry.competition, entry.reason, stamp, stamp,
          1, entry.count, entry.count, entry.example]);
        continue;
      }
      const row = rows[ix];
      const samePoll = comparableStamp_(row[4]) === stamp;
      const previousLastCount = Number(row[7]) || 0;
      row[4] = stamp;
      if (!samePoll) row[5] = (Number(row[5]) || 0) + 1;
      row[6] = (Number(row[6]) || 0) +
        (samePoll ? entry.count - previousLastCount : entry.count);
      row[7] = entry.count;
      if (entry.example) row[8] = entry.example;
    }
  }
  if (rows.length)
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return {total, distinct};
}

// Manually merged aliases are already preserved in Archiv duplicit.
// Read them on EVERY ingest so deleted variants never respawn, including
// manual merges made before this feature was added. Resolve alias chains.
function manualArchiveLinks_(ss, rows) {
  const empty = {byIncoming: new Map(), byExisting: new Map(), teamAliases: []};
  const archive = ss.getSheetByName('Archiv duplicit');
  if (!archive || archive.getLastRow() < 2) return empty;
  const history = archive.getRange(2, 1, archive.getLastRow() - 1, 17).getValues();
  const forwards = new Map();
  const records = [];
  const conflict = new Set();
  const current = new Map();
  rows.forEach((row, ix) => {
    const key = String(row[0] || '');
    if (!key) return;
    if (current.has(key)) current.set(key, -1); // Duplicate key = ambiguous.
    else current.set(key, ix);
  });

  for (const h of history) {
    const role = String(h[3] || '');
    if (!/^(?:(?:MANUAL|AUTO) MERGED FROM(?: REVERSED)?|MERGED FROM)$/.test(role)) continue;
    const targetKey = String(h[1] || '');
    const oldKey = String(h[4] || '');
    const date = matchDateKey_(h[5]);
    if (!targetKey || !oldKey || !date || !h[6] || !h[7] || !h[8] ||
        rapidRepeatLeague_(h[6])) continue;
    if (forwards.has(oldKey) && forwards.get(oldKey) !== targetKey)
      conflict.add(oldKey);
    else forwards.set(oldKey, targetKey);
    records.push({
      key: oldKey,
      fingerprint: [date, norm_(h[6]), normTeam_(h[7]), normTeam_(h[8])].join('|'),
      date, league: String(h[6]), home: String(h[7]), away: String(h[8]),
      reversed: role.endsWith(' REVERSED'),
      sources: SOURCES.filter((_, i) => h[9 + i] === 'ANO')
    });
  }

  function resolve(key) {
    const visited = new Set();
    let k = key;
    while (forwards.has(k)) {
      if (conflict.has(k) || visited.has(k)) return -1;
      visited.add(k);
      const next = forwards.get(k);
      if (!next || next === k) return -1;
      k = next;
    }
    const ix = current.get(k);
    return Number.isInteger(ix) && ix >= 0 ? ix : -1;
  }

  const byIncoming = new Map();
  const byExisting = new Map();
  const teamAliases = [];
  for (const entry of records) {
    const target = resolve(entry.key);
    if (target < 0 || matchDateKey_(rows[target][1]) !== entry.date) continue;
    const from = current.get(entry.key);
    if (Number.isInteger(from) && from >= 0 && from !== target)
      byExisting.set(from, target);
    // User-confirmed home/home and away/away equivalences can be
    // reused on OTHER DATES, unlike the fixture-specific alias above.
    const master = rows[target];
    if (!rapidRepeatLeague_(master[2])) {
      const category = fixtureClass_(master[2], master[3], master[4]);
      for (const source of entry.sources) {
        teamAliases.push({source, league: entry.league,
          team: entry.home, canonical: String(master[entry.reversed ? 4 : 3]),
          category, scope: String(master[2]), origin: 'Potvrzené sloučení'});
        teamAliases.push({source, league: entry.league,
          team: entry.away, canonical: String(master[entry.reversed ? 3 : 4]),
          category, scope: String(master[2]), origin: 'Potvrzené sloučení'});
      }
    }
    for (const source of entry.sources) {
      const key = source + '|' + entry.fingerprint;
      if (byIncoming.has(key) && byIncoming.get(key) !== target)
        byIncoming.set(key, -1); // Never choose between two manual destinations.
      else if (!byIncoming.has(key))
        byIncoming.set(key, target);
    }
  }
  return {byIncoming, byExisting, teamAliases};
}

// A persistent, editable team dictionary. Rows come from confirmed manual
// merges, not fuzzy name similarity. Different bookmakers may call a club
// by entirely different names; confirmed identities survive into future days.
function teamAliasKey_(source, league, team, category) {
  return [String(source), normLeague_(league), normTeam_(team),
    String(category)].join('|');
}

function readTeamAliases_(ss, suggested) {
  let sheet = ss.getSheetByName('Aliasy týmů');
  if (!sheet) sheet = ss.insertSheet('Aliasy týmů');
  const headers = ['Zdroj', 'Soutěž u zdroje', 'Název týmu u zdroje',
    'Odpovídající tým', 'Kategorie', 'Soutěž cílového týmu',
    'Původ', 'Aktivní'];
  if (!sheet.getLastRow()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  const last = sheet.getLastRow();
  const rows = last > 1 ? sheet.getRange(2, 1, last - 1, 8).getValues() : [];
  const existing = new Set();
  for (const r of rows) {
    if (r[0] && r[1] && r[2] && r[4])
      existing.add(teamAliasKey_(r[0], r[1], r[2], r[4]));
  }
  const staged = new Map();
  const conflicts = new Set();
  for (const suggestion of suggested) {
    if (!SOURCES.includes(suggestion.source) ||
        !suggestion.league || !suggestion.team || !suggestion.canonical ||
        !suggestion.category || !suggestion.scope) continue;
    const key = teamAliasKey_(suggestion.source, suggestion.league,
      suggestion.team, suggestion.category);
    if (existing.has(key)) continue;
    const target = normTeam_(suggestion.canonical) + '|' +
      normLeague_(suggestion.scope);
    if (staged.has(key) && staged.get(key).target !== target) {
      conflicts.add(key);
    } else if (!staged.has(key)) {
      staged.set(key, {target, value: suggestion});
    }
  }
  const additions = [];
  for (const [key, x] of staged) {
    if (conflicts.has(key)) continue; // Ambiguous history requires review.
    const v = x.value;
    additions.push([v.source, v.league, v.team, v.canonical,
      v.category, v.scope, v.origin, 'ANO']);
  }
  if (additions.length) {
    sheet.getRange(last + 1, 1, additions.length, 8).setValues(additions);
    rows.push(...additions);
  }

  // Duplicate keys with conflicting targets are disabled, not overwritten.
  const dictionary = new Map();
  const leagueGroups = new Map();
  for (const r of rows) {
    if (String(r[7] || '').trim().toUpperCase() !== 'ANO') continue;
    if (!SOURCES.includes(r[0]) || !r[1] || !r[2] || !r[3] ||
        !r[4] || !r[5]) continue;
    const key = teamAliasKey_(r[0], r[1], r[2], r[4]);
    const canonical = normTeam_(r[3]);
    const scope = normLeague_(r[5]);
    const value = canonical + '|' + scope;
    if (dictionary.has(key) && dictionary.get(key).value !== value)
      dictionary.set(key, {conflict:true});
    else if (!dictionary.has(key))
      dictionary.set(key, {canonical, scope, value, conflict:false});

    // A stored row may have been created by any sportsbook; recognize
    // its league alias only if the canonical league is unambiguous.
    const lk = normLeague_(r[1]);
    if (leagueGroups.has(lk) && leagueGroups.get(lk) !== scope)
      leagueGroups.set(lk, '');
    else if (!leagueGroups.has(lk))
      leagueGroups.set(lk, scope);
  }
  return {dictionary, leagueGroups};
}

function canonicalTeamAlias_(aliases, source, league, team, category) {
  const v = aliases.dictionary.get(teamAliasKey_(source, league, team, category));
  return v && !v.conflict ? v : null;
}

function sameLearnedAliasFixture_(aliases, source, date, home, away,
                                  competition, row, incomingId) {
  if (!aliases || !source || rapidRepeatLeague_(competition) ||
      rapidRepeatLeague_(row[2])) return false;
  if (matchDateKey_(date) !== matchDateKey_(row[1])) return false;
  const oldId = eventId_(row[12]);
  if (incomingId && oldId && incomingId !== oldId) return false;
  const cls = fixtureClass_(competition, home, away);
  if (cls !== fixtureClass_(row[2], row[3], row[4])) return false;
  const left = canonicalTeamAlias_(aliases, source, competition, home, cls);
  const right = canonicalTeamAlias_(aliases, source, competition, away, cls);
  const rowLeague = normLeague_(row[2]);
  const rawGroup = aliases.leagueGroups.has(rowLeague)
    ? aliases.leagueGroups.get(rowLeague) : rowLeague;
  if (!rawGroup || (left && left.scope !== rawGroup) ||
      (right && right.scope !== rawGroup)) return false;

  function storedIdentity(team) {
    // The existing fixture may have arrived from the aliased bookmaker
    // FIRST, so matching must work in both arrival orders.
    const original = normTeam_(team);
    const mapped = new Set();
    for (const bookmaker of SOURCES) {
      const found = canonicalTeamAlias_(aliases, bookmaker, row[2], team, cls);
      if (found && found.scope === rawGroup) mapped.add(found.canonical);
    }
    if (mapped.size > 1) return {name:'', mapped:true};
    return {name:mapped.size ? [...mapped][0] : original,
      mapped:mapped.size > 0};
  }
  const bh = storedIdentity(row[3]), ba = storedIdentity(row[4]);
  if (!left && !right && !bh.mapped && !ba.mapped) return false;
  const ah = left ? left.canonical : normTeam_(home);
  const aa = right ? right.canonical : normTeam_(away);
  if (!ah || !aa || !bh.name || !ba.name) return false;
  return (ah === bh.name && aa === ba.name) ||
    (ah === ba.name && aa === bh.name);
}

function saveSnapshot_(body) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const gamesSheet = ss.getSheetByName('Zápasy');
  const checksSheet = ss.getSheetByName('Kontroly');
  const srcSheet = ss.getSheetByName('Zdroje');
  if (!gamesSheet || !checksSheet || !srcSheet) throw new Error('Missing expected sheet tab');
  if (!Array.isArray(body.sources)) throw new Error('Missing sources');
  const checkedDate = new Date(body.checkedAt);
  if (isNaN(checkedDate.getTime())) throw new Error('Invalid checkedAt');
  const stamp = Utilities.formatDate(checkedDate, 'Europe/Prague', 'yyyy-MM-dd HH:mm:ss');
  const lastRow = gamesSheet.getLastRow();
  const originalRows = lastRow > 1 ? gamesSheet.getRange(2, 1, lastRow - 1, 13).getValues() : [];
  const rows = originalRows.map(r => r.slice());
  const manualLinks = manualArchiveLinks_(ss, rows);
  const learnedAliases = readTeamAliases_(ss, manualLinks.teamAliases);
  const idIndex = new Map();
  const footballIndex = new Map();
  const nameIndex = new Map();
  rows.forEach((r, index) => {
    const id = eventId_(r[12]);
    if (id) idIndex.set(id, index);
    const footballId = rowFootballOpaqueId_(r[12]);
    if (footballId) footballIndex.set(footballId, index);
    const key = exactKey_(r[1], r[3], r[4]);
    if (!nameIndex.has(key)) nameIndex.set(key, []);
    nameIndex.get(key).push(index);
  });

  const sourceMap = new Map();
  for (const src of body.sources) {
    if (!SOURCES.includes(src.source) || sourceMap.has(src.source)) continue;
    sourceMap.set(src.source, src);
  }
  const touched = new Set();
  const newTouched = new Set();
  const seenThisPoll = new Map(SOURCES.map(src => [src, new Set()]));
  let created = 0;
  let addedObservations = 0;

  for (const source of SOURCES) {
    const info = sourceMap.get(source);
    if (!info || !Array.isArray(info.matches) || !['ÚSPĚCH', 'ČÁSTEČNĚ'].includes(info.status)) continue;
    if (info.matches.length > 3000) throw new Error('Unexpectedly large source list');
    for (const m of info.matches) {
      if (!m || !m.home || !m.away || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) continue;
      // Aggregated 1xBit titles like "Lakers/Bulls – Warriors/Celtics"
      // describe several independent matches, not a fixture. Never ingest.
      if (source === '1xBit' && multipleFixtureListing_(m.home, m.away)) continue;
      const srid = eventId_(m.eventId);
      const footballId = source === 'Football.com' ? footballOpaqueId_(m.eventId) : '';
      const rapidRepeat = rapidRepeatLeague_(m.competition);
      // Repeated same-day BSKT CUP fixtures require their unique event ID.
      if (rapidRepeat && !srid && !footballId) continue;
      const nameKey = exactKey_(m.date, m.home, m.away);
      let ix = -1;
      if (!rapidRepeat) {
        const fingerprint = [m.date, norm_(m.competition),
          normTeam_(m.home), normTeam_(m.away)].join('|');
        const manualIx = manualLinks.byIncoming.get(source + '|' + fingerprint);
        if (Number.isInteger(manualIx) && manualIx >= 0) {
          const existingId = eventId_(rows[manualIx][12]);
          const oldFootball = rowFootballOpaqueId_(rows[manualIx][12]);
          // Explicit manual identity can supersede a re-created old row,
          // but must NEVER override conflicting independent match IDs.
          if ((!srid || !existingId || srid === existingId) &&
              (!footballId || !oldFootball || footballId === oldFootball))
            ix = manualIx;
        }
      }
      if (ix === -1 && srid && idIndex.has(srid)) ix = idIndex.get(srid);
      if (ix === -1 && footballId && footballIndex.has(footballId))
        ix = footballIndex.get(footballId);
      if (ix === -1 && !rapidRepeat) {
        // Never use approximate names alone to pair two BSKT CUP games.
        ix = chooseMatch_(rows, m.date, m.home, m.away, m.competition, srid,
          learnedAliases, source);
      }
      if (ix === -1) {
        const key = [m.date, norm_(m.competition), normTeam_(m.home), normTeam_(m.away),
          footballId ? 'football=' + encodeURIComponent(footballId) : ''].filter(Boolean).join('|');
        const notes = [srid, footballId ? 'football:event:' + footballId : '',
          m.state ? source + ': ' + m.state : ''].filter(Boolean).join('; ');
        const initial = [key, m.date, m.competition || '', m.home, m.away,
          'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO', stamp, stamp, 0, notes];
        ix = rows.length;
        rows.push(initial);
        if (!nameIndex.has(nameKey)) nameIndex.set(nameKey, []);
        nameIndex.get(nameKey).push(ix);
        created++;
      }
      if (srid) {
        const old = eventId_(rows[ix][12]);
        if (!old) rows[ix][12] = (rows[ix][12] ? rows[ix][12] + '; ' : '') + srid;
        idIndex.set(srid, ix);
      }
      if (footballId) {
        if (!rowFootballOpaqueId_(rows[ix][12]))
          rows[ix][12] = (rows[ix][12] ? rows[ix][12] + '; ' : '') +
            'football:event:' + footballId;
        footballIndex.set(footballId, ix);
      }
      rows[ix][COL_BY_SOURCE[source]] = 'ANO';
      if (!seenThisPoll.get(source).has(ix)) {
        seenThisPoll.get(source).add(ix);
        addedObservations++;
      }
      rows[ix][10] = stamp;
      touched.add(ix);
      newTouched.add(ix);
    }
  }

  // Red means a proven absence, never failed extraction. This currently only
  // applies to a source explicitly verified as an exhaustive live feed.
  for (const source of SOURCES) {
    const info = sourceMap.get(source);
    if (!info || info.status !== 'ÚSPĚCH' || info.complete !== true) continue;
    const observed = seenThisPoll.get(source);
    for (const ix of newTouched) {
      if (!observed.has(ix) && rows[ix][COL_BY_SOURCE[source]] !== 'ANO') {
        rows[ix][COL_BY_SOURCE[source]] = 'NE';
        touched.add(ix);
      }
    }
  }
  for (const ix of newTouched) {
    rows[ix][11] = (Number(rows[ix][11]) || 0) + 1;
    touched.add(ix);
  }

  // Do NOT clean historic rows in a web-app ingest request: the caller has
  // a short HTTP timeout. runScheduledDedupe() now owns historical cleanup.
  // Normal incoming fixture matching and validated manual aliases still run.
  const cleanup = {merged:0, reviewCandidates:0, deleteIndices:[], archive:[],
    modified:new Set(), masterByIndex:new Map(rows.map((_, ix) => [ix, ix]))};
  const removedIndices = new Set(cleanup.deleteIndices);
  // Distinct source/fixture observations after merging; the same poll must
  // never be counted twice solely because the two sites used different names.
  const uniqueObservations = [...seenThisPoll.values()]
    .reduce((sum, indices) => sum +
      new Set([...indices].map(ix => cleanup.masterByIndex.get(ix))).size, 0);

  // Write adjacent touched rows in one operation instead of dozens of calls.
  // Leave untouched rows (and any formulas they may contain) unchanged.
  const oldCount = originalRows.length;
  const touchedExisting = [...touched].filter(ix => ix < oldCount).sort((a, b) => a - b);
  let segmentStart = -1;
  let segmentEnd = -1;
  function flushSegment_() {
    if (segmentStart === -1) return;
    gamesSheet.getRange(segmentStart + 2, 1, segmentEnd - segmentStart + 1, 13)
      .setValues(rows.slice(segmentStart, segmentEnd + 1));
  }
  for (const ix of touchedExisting) {
    if (segmentStart === -1) {
      segmentStart = segmentEnd = ix;
    } else if (ix === segmentEnd + 1) {
      segmentEnd = ix;
    } else {
      flushSegment_();
      segmentStart = segmentEnd = ix;
    }
  }
  flushSegment_();

  if (rows.length > oldCount) {
    gamesSheet.getRange(oldCount + 2, 1, rows.length - oldCount, 13)
      .setValues(rows.slice(oldCount));
  }

  if (cleanup.archive.length) {
    archiveHistoricalDuplicates_(ss, cleanup.archive);
    deleteHistoricalDuplicateRows_(gamesSheet, cleanup.deleteIndices);
  }

  function summaryStatus(source) {
    const entry = sourceMap.get(source);
    if (!entry) return {status: 'NEDOSTUPNÉ', count: ''};
    const valid = ['ÚSPĚCH', 'ČÁSTEČNĚ', 'NEDOSTUPNÉ'].includes(entry.status);
    const status = valid ? entry.status : 'NEDOSTUPNÉ';
    return {status, count: status === 'NEDOSTUPNÉ' ? '' : (entry.matches || []).length};
  }
  const counts = SOURCES.map(summaryStatus);
  const rejectionSummary = updateRejectedLeagues_(ss, sourceMap, stamp);
  checksSheet.appendRow([stamp, counts[0].status, counts[0].count, counts[1].status, counts[1].count,
    counts[2].status, counts[2].count, counts[3].status, counts[3].count,
    `${created - cleanup.deleteIndices.filter(ix => ix >= oldCount).length} nových zápasů, ${uniqueObservations} dostupností; ${cleanup.merged} sloučených duplicit, ${cleanup.reviewCandidates} k prověření; ${rejectionSummary.total} vyřazených LIVE ve ${rejectionSummary.distinct} soutěžích/zdrojích; zdroje s neověřenou úplností nejsou použity k označení NE`]);
  srcSheet.getRange(2, 3, 4, 4).setValues(SOURCES.map((name, i) => {
    const s = sourceMap.get(name) || {};
    return [stamp, counts[i].status, counts[i].count, String(s.error || '').slice(0, 450)];
  }));
  return {ok: true, created: created - cleanup.deleteIndices.filter(ix => ix >= oldCount).length,
    currentRows: rows.length - cleanup.merged, mergedDuplicates: cleanup.merged,
    reviewCandidates: cleanup.reviewCandidates, positiveObservations: uniqueObservations,
    rejectedGames: rejectionSummary.total, rejectedLeagues: rejectionSummary.distinct,
    sources: SOURCES.map((name, i) => ({name, ...counts[i]}))};
}