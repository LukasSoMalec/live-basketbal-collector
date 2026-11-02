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
    const requiredKey = PropertiesService.getScriptProperties().getProperty('INGEST_KEY');
    if (!requiredKey || !body.key || body.key !== requiredKey) {
      return json_({ok: false, error: 'Unauthorized'});
    }
    if (!lock.tryLock(25000)) return json_({ok: false, error: 'Locked; retry next run'});
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
  const gender = /\b(women|woman|zene|zeny|w|wncaa)\b/.test(label)
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

function sameFixture_(date, home, away, competition, row, incomingId) {
  if (matchDateKey_(date) !== matchDateKey_(row[1])) return false;
  const existingId = eventId_(row[12]);
  if (incomingId && existingId && incomingId !== existingId) return false;
  const incomingClass = fixtureClass_(competition, home, away);
  const oldClass = fixtureClass_(row[2], row[3], row[4]);
  if (incomingClass !== oldClass) return false;

  const ignoreWomen = incomingClass.endsWith('|women');
  const forward = sameTeam_(home, row[3], ignoreWomen) &&
    sameTeam_(away, row[4], ignoreWomen);
  const reverse = sameTeam_(home, row[4], ignoreWomen) &&
    sameTeam_(away, row[3], ignoreWomen);
  if (!forward && !reverse) return false;

  const leagueA = normLeague_(competition);
  const leagueB = normLeague_(row[2]);
  if (!leagueA || !leagueB) return false;

  // Trust two equal, distinctive team identities on the same date, even if
  // providers translate competition names or reverse team order.
  const hCore = teamCore_(home, ignoreWomen);
  const aCore = teamCore_(away, ignoreWomen);
  const rHCore = teamCore_(row[3], ignoreWomen);
  const rACore = teamCore_(row[4], ignoreWomen);
  const identicalPairs = forward && hCore === rHCore && aCore === rACore;
  const reversePairs = reverse && hCore === rACore && aCore === rHCore;
  if (identicalPairs || reversePairs) return true;
  return leagueA === leagueB;
}

function chooseMatch_(rows, date, home, away, competition, incomingId) {
  const candidates = [];
  for (let ix = 0; ix < rows.length; ix++) {
    if (sameFixture_(date, home, away, competition, rows[ix], incomingId))
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
  const idIndex = new Map();
  const nameIndex = new Map();
  rows.forEach((r, index) => {
    const id = eventId_(r[12]);
    if (id) idIndex.set(id, index);
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
      const srid = eventId_(m.eventId);
      const nameKey = exactKey_(m.date, m.home, m.away);
      let ix = srid && idIndex.has(srid) ? idIndex.get(srid) : -1;
      if (ix === -1) {
        // Handles AS Papagou = Papagou, Panionios BC Atény = Panionios Athens,
        // and old duplicate rows. A conflicting existing SportRadar ID blocks
        // any automatic merge; same-date and league context are required.
        ix = chooseMatch_(rows, m.date, m.home, m.away, m.competition, srid);
      }
      if (ix === -1) {
        const key = [m.date, norm_(m.competition), normTeam_(m.home), normTeam_(m.away)].join('|');
        const initial = [key, m.date, m.competition || '', m.home, m.away,
          'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO', 'NEOVĚŘENO', stamp, stamp, 0,
          (srid ? srid : '') + (m.state ? '; ' + source + ': ' + m.state : '')];
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

  function summaryStatus(source) {
    const entry = sourceMap.get(source);
    if (!entry) return {status: 'NEDOSTUPNÉ', count: ''};
    const valid = ['ÚSPĚCH', 'ČÁSTEČNĚ', 'NEDOSTUPNÉ'].includes(entry.status);
    const status = valid ? entry.status : 'NEDOSTUPNÉ';
    return {status, count: status === 'NEDOSTUPNÉ' ? '' : (entry.matches || []).length};
  }
  const counts = SOURCES.map(summaryStatus);
  checksSheet.appendRow([stamp, counts[0].status, counts[0].count, counts[1].status, counts[1].count,
    counts[2].status, counts[2].count, counts[3].status, counts[3].count,
    `${created} nových zápasů, ${addedObservations} dostupností; zdroje s neověřenou úplností nejsou použity k označení NE`]);
  srcSheet.getRange(2, 3, 4, 4).setValues(SOURCES.map((name, i) => {
    const s = sourceMap.get(name) || {};
    return [stamp, counts[i].status, counts[i].count, String(s.error || '').slice(0, 450)];
  }));
  return {ok: true, created, currentRows: rows.length, positiveObservations: addedObservations,
    sources: SOURCES.map((name, i) => ({name, ...counts[i]}))};
}