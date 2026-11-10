/**
 * ScheduledDedupe.gs
 * Background historical cleanup for the LIVE basketball sheet.
 * Add to the SAME Apps Script project as GoogleAppsScript.gs.
 * Run installScheduledDedupe() ONCE in Apps Script editor after deploying.
 * @author LM
 * @license MIT
 */
const HIST_DEDUPE_CURSOR = 'HIST_DEDUPE_LAST_DATE';
const HIST_DEDUPE_MAX_DELETES = 30;
const HIST_DEDUPE_MAX_GROUPS = 15;

// Approx. once an hour around :40 Prague time; Google may shift the minute.
// Running installation again replaces only THIS function's old triggers.
function installScheduledDedupe() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'runScheduledDedupe') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('runScheduledDedupe').timeBased()
    .everyHours(1).nearMinute(40).inTimezone('Europe/Prague').create();
  Logger.log('Hodinový trigger deduplikace vytvořen.');
}

// Safe to run manually after deploying. Does not call GitHub or ingest endpoints.
function runScheduledDedupe() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Přeskočeno: sběr nebo jiný cleanup drží zámek.');
    return {ok:true, skipped:'locked'};
  }
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sh = ss.getSheetByName('Zápasy');
    if (!sh || sh.getLastRow() < 2) return {ok:true, skipped:'empty'};
    const dates = [...new Set(sh.getRange(2, 2, sh.getLastRow()-1, 1)
      .getValues().map(r=>matchDateKey_(r[0])).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    if (!dates.length) return {ok:true, skipped:'no-dates'};
    const props = PropertiesService.getScriptProperties();
    const last = props.getProperty(HIST_DEDUPE_CURSOR) || '';
    const day = dates.find(d=>d > last) || dates[0];
    const result = scheduledDeduplicateDay_(ss, day);
    if (!result.more) props.setProperty(HIST_DEDUPE_CURSOR, day);
    Logger.log(JSON.stringify(result));
    return {ok:true,...result};
  } finally {
    lock.releaseLock();
  }
}

// Process ONE whole match date (across every category) per run so matches
// cannot be missed merely because recovery rows are far apart in the sheet.
function scheduledDeduplicateDay_(ss, day) {
  const started = Date.now();
  const sheet = ss.getSheetByName('Zápasy');
  if (!sheet) throw new Error('Chybí list Zápasy.');
  const total = sheet.getLastRow()-1;
  if (total < 1) return {day, merged:0, more:false};
  const all = sheet.getRange(2, 1, total, 13).getValues();
  const readMs = Date.now() - started;
  const localToGlobal = [];
  const localRows = [];
  for (let i=0; i<all.length; i++) {
    if (matchDateKey_(all[i][1]) === day) {
      localToGlobal.push(i);
      localRows.push(all[i].slice());
    }
  }
  if (!localRows.length) return {day, merged:0, more:false};

  // Preserve explicit historical merge decisions, including chains.
  const toLocal = new Map(localToGlobal.map((global,local)=>[global,local]));
  const globalLinks = manualArchiveLinks_(ss, all).byExisting;
  const localLinks = new Map();
  for (const [from, target] of globalLinks) {
    if (toLocal.has(from) && toLocal.has(target))
      localLinks.set(toLocal.get(from), toLocal.get(target));
  }
  const linksMs = Date.now() - started - readMs;
  const stamp = Utilities.formatDate(new Date(),'Europe/Prague','yyyy-MM-dd HH:mm:ss');
  const plan = planHistoricalDeduplication_(localRows, stamp, localLinks,
    {maxDeleted:HIST_DEDUPE_MAX_DELETES,maxGroups:HIST_DEDUPE_MAX_GROUPS});
  const analysisMs = Date.now() - started - readMs - linksMs;
  // Fail before ANY write if matching took too long.
  if (Date.now()-started > 210000)
    throw new Error('Deduplikace ' + day + ': bezpečný limit 210 s. ' +
      'Čtení ' + readMs + ' ms, historické vazby ' + linksMs +
      ' ms, párování ' + analysisMs + ' ms.');

  // Use original sheet coordinates before deletion. Never delete by guessed
  // fixture names or mutable "Řádky při analýze" from the AI queue.
  const archive = plan.archive.map(r=>{
    const copy = r.slice();
    copy[2] = localToGlobal[Number(r[2])-2]+2;
    return copy;
  });
  const deleted = new Set(plan.deleteIndices);
  const writes = [...plan.modified].filter(i=>!deleted.has(i))
    .sort((a,b)=>localToGlobal[a]-localToGlobal[b]);

  // Archive originals first. This is append-only; do not remove that sheet.
  if (archive.length) archiveHistoricalDuplicates_(ss, archive);

  // Group physically adjacent changed rows into a single setValues call.
  for (let k=0; k<writes.length;) {
    let next = k+1;
    while (next<writes.length &&
      localToGlobal[writes[next]] === localToGlobal[writes[next-1]]+1) next++;
    const first = localToGlobal[writes[k]];
    sheet.getRange(first+2, 1, next-k, 13)
      .setValues(writes.slice(k,next).map(ix=>localRows[ix]));
    k = next;
  }
  const absoluteDeletes = plan.deleteIndices.map(ix=>localToGlobal[ix])
    .sort((a,b)=>b-a);
  if (absoluteDeletes.length) deleteHistoricalDuplicateRows_(sheet, absoluteDeletes);
  // A group cap can be reached with fewer than 30 deleted rows.
  // Stay on this date until all deferred groups are handled.
  const more = plan.deferredGroups > 0;
  return {day, checked:localRows.length, merged:plan.merged,
    review:plan.reviewCandidates, archived:archive.length,
    deferredGroups:plan.deferredGroups, more, milliseconds:Date.now()-started,
    readMs, linksMs, analysisMs, writeMs:Date.now()-started-readMs-linksMs-analysisMs};
}
