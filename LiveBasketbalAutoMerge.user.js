// ==UserScript==
// @name         LIVE basketbal - kontrola a sloučení duplicit
// @namespace    live-basketbal-collector
// @version      1.1.1
// @author       LM
// @license      MIT
// @description  Bezpečný náhled a potvrzené sloučení duplicit v Google Sheets.
// @match        https://docs.google.com/spreadsheets/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  if (!location.pathname.includes('/d/1LWy7tTceA-kP_OMSlNRm1cLrzxAx0hMq4DI4pbzYOwI/')) return;
  if (document.getElementById('lm-auto-merge')) return;
  const style = document.createElement('style');
  style.textContent = [
    '#lm-auto-merge{position:fixed;right:18px;bottom:19px;z-index:999999;font:13px Arial,sans-serif;color:#f4f4f5}',
    '#lm-auto-merge *{box-sizing:border-box}',
    '#lm-auto-merge button{cursor:pointer;border:1px solid #52525b;border-radius:7px;padding:8px 12px;background:#27272a;color:#fafafa;font:inherit}',
    '#lm-auto-merge button:hover{background:#3f3f46}',
    '#lm-auto-merge button:disabled{opacity:.5;cursor:default}',
    '#lm-auto-merge .launch{background:#166534;border-color:#15803d;font-weight:700}',
    '#lm-auto-merge .panel{width:min(640px,calc(100vw - 36px));max-height:78vh;overflow:auto;background:#18181b;border:1px solid #52525b;border-radius:10px;box-shadow:0 8px 32px #0007;padding:15px;margin-bottom:10px}',
    '#lm-auto-merge .head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}',
    '#lm-auto-merge .head strong{font-size:15px}',
    '#lm-auto-merge .item{display:flex;gap:10px;border-top:1px solid #3f3f46;padding:10px 0;line-height:1.4}',
    '#lm-auto-merge .item input{flex:none;margin-top:3px}',
    '#lm-auto-merge .muted{color:#a1a1aa;font-size:12px}',
    '#lm-auto-merge .actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}',
    '#lm-auto-merge .good{color:#86efac}',
    '#lm-auto-merge .warn{color:#fcd34d}'
  ].join('');
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'lm-auto-merge';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.display = 'none';
  const launch = document.createElement('button');
  launch.className = 'launch';
  launch.textContent = '🔗 AUTO SPOJENÍ';
  root.append(panel, launch);
  document.body.appendChild(root);
  let proposals = [];
  let busy = false;

  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (label, onClick) => {
    const b = el('button', label);
    b.addEventListener('click', onClick);
    return b;
  };
  const validUrl = value => /^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(value);
  function configure() {
    const oldUrl = GM_getValue('webapp_url', '');
    const url = prompt('URL stávající Apps Script webové aplikace (končí /exec):', oldUrl);
    if (url === null) return false;
    const cleanUrl = url.trim();
    if (!validUrl(cleanUrl)) {
      alert('Neplatná /exec URL webové aplikace.');
      return false;
    }
    const oldKey = GM_getValue('merge_key', '');
    const key = prompt('MERGE_KEY (samostatný klíč ze Script Properties; NE INGEST_KEY):', oldKey);
    if (key === null) return false;
    if (key.trim().length < 32) {
      alert('MERGE_KEY musí mít alespoň 32 znaků.');
      return false;
    }
    GM_setValue('webapp_url', cleanUrl);
    GM_setValue('merge_key', key.trim());
    return true;
  }
  function request(action, ids = [], attempt = 0) {
    const url = GM_getValue('webapp_url', '');
    const key = GM_getValue('merge_key', '');
    if (!validUrl(url) || !key) {
      if (!configure()) return Promise.reject(new Error('Chybí nastavení'));
      return request(action, ids, attempt);
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {'Content-Type': 'text/plain;charset=utf-8'},
        data: JSON.stringify({action, key, ids}),
        timeout: 65000,
        onload(r) {
          try {
            const data = JSON.parse(r.responseText);
            // Jedině tento výsledek potvrzuje, že server sloučení vůbec
            // nezačal. Proto je opakování bezpečné i pro akci apply.
            if (data?.ok === false &&
                /^Locked; retry next run$/i.test(String(data.error || '').trim()) &&
                attempt < 3) {
              setTimeout(() => resolve(request(action, ids, attempt + 1)),
                3500 * (attempt + 1));
              return;
            }
            if (r.status >= 400 || data.ok !== true)
              throw new Error(data.error || 'HTTP ' + r.status);
            resolve(data);
          } catch (e) {
            reject(new Error('Apps Script: ' + e.message));
          }
        },
        onerror: () => reject(new Error('Síťová chyba při spojení s Apps Scriptem')),
        ontimeout: () => reject(new Error('Apps Script neodpověděl včas'))
      });
    });
  }
  function header() {
    panel.replaceChildren();
    const h = el('div', '', 'head');
    h.append(el('strong', 'Párování LIVE basketbalu'),
      button('🤖 AI fronta', aiPreview),
      button('Pravidla', preview),
      button('Nastavení', () => configure()),
      button('✕', () => { panel.style.display = 'none'; }));
    panel.append(h);
  }
  function status(message, cls = 'muted') {
    const node = el('div', message, cls);
    panel.append(node);
    return node;
  }
  async function aiPreview() {
    if (busy) return;
    busy = true;
    panel.style.display = '';
    header();
    status('Načítám AI frontu z listu AI sloučení…');
    try {
      const data = await request('aiMerge.preview');
      header();
      status('AI připravila ' + data.auto + ' jistějších skupin ke sloučení. ' +
        data.review + ' skupin čeká na tvoji kontrolu. ' +
        data.processed + ' již vyřízeno. ' +
        (data.removable || 0) + ' kombinovaných řádků s / k odstranění.');
      status('Čísla řádků se nepoužívají – při sloučení se hledá podle klíčů. ' +
        'Neplatné, ztracené nebo konfliktní skupiny se přeskočí.');
      const actions = el('div', '', 'actions');
      const merge = button('🤖 Sloučit jisté (' + data.auto +
        ') + vyřadit kombinované (' + (data.removable || 0) + ')', async () => {
        if (busy || (!data.auto && !data.removable)) return;
        if (!confirm('Spojit ' + data.auto + ' skupin označených AI jako SLOUČIT ' +
          'a vyřadit ' + (data.removable || 0) + ' kombinovaných zápisů s lomítky? ' +
          'Sporné skupiny zůstanou k prověření. Všechny původní řádky se archivují.')) return;
        busy = true;
        merge.disabled = true;
        try {
          const res = await request('aiMerge.apply');
          alert('AI sloučení: ' + res.mergedGroups + ' skupin, odstraněno ' +
            res.removedRows + ' řádků (z toho kombinovaných ' +
            (res.removedComposites || 0) + '). Zablokováno: ' + res.blocked +
            '. V listu AI sloučení najdeš výsledky a sporné případy.');
          busy = false;
          await aiPreview();
        } catch (e) {
          alert('Sloučení selhalo: ' + e.message);
        } finally {
          busy = false;
          merge.disabled = false;
        }
      });
      merge.disabled = !data.auto && !data.removable;
      actions.append(merge, button('Aktualizovat frontu', aiPreview));
      panel.append(actions);
    } catch (e) {
      header();
      status(e.message, 'warn');
      panel.append(button('Znovu načíst AI frontu', aiPreview));
    } finally {
      busy = false;
    }
  }
  async function preview() {
    if (busy) return;
    busy = true;
    panel.style.display = '';
    header();
    status('Načítám návrhy…');
    try {
      const data = await request('autoMerge.preview');
      proposals = data.proposals || [];
      header();
      status('V tabulce: ' + data.totalRows + ' zápasů. Bezpečné shody: ' +
        data.safe + ', k prověření: ' + data.review + '.');
      if (!proposals.length) {
        status('Nic k sloučení. 😊', 'good');
        return;
      }
      const selected = new Set(proposals.filter(x => x.level === 'safe').map(x => x.id));
      const actionBar = el('div', '', 'actions');
      const apply = button('Sloučit vybrané (' + selected.size + ')', async () => {
        if (busy || !selected.size) return;
        if (!confirm('Opravdu sloučit ' + selected.size +
          ' návrhů? Původní řádky zůstanou v Archivu duplicit.')) return;
        busy = true;
        apply.disabled = true;
        try {
          const result = await request('autoMerge.apply', [...selected]);
          alert('Sloučeno: ' + result.merged + ' řádků. Archivováno: ' +
            result.archived + ' záznamů.');
          await previewAfterApply();
        } catch (e) {
          alert(e.message);
        } finally {
          busy = false;
          apply.disabled = false;
        }
      });
      const update = () => {
        apply.textContent = 'Sloučit vybrané (' + selected.size + ')';
        apply.disabled = !selected.size;
      };
      actionBar.append(apply, button('Znovu načíst', preview));
      panel.append(actionBar);
      for (const p of proposals) {
        const line = el('label', '', 'item');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(p.id);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(p.id);
          else selected.delete(p.id);
          update();
        });
        const desc = el('div');
        desc.append(el('div', (p.level === 'safe' ? '✅ JISTĚJŠÍ ' : '⚠️ OVĚŘIT ') +
          'ř. ' + p.masterRow + ' ← ' + p.removedRow +
          (p.reversed ? ' (prohozené týmy)' : ''),
          p.level === 'safe' ? 'good' : 'warn'));
        desc.append(el('div', p.master));
        desc.append(el('div', p.duplicate + ' (' + p.otherLeague + ')', 'muted'));
        desc.append(el('div', p.reason + ' • ' + p.date, 'muted'));
        line.append(cb, desc);
        panel.append(line);
      }
      update();
    } catch (e) {
      header();
      status(e.message, 'warn');
      panel.append(button('Znovu načíst', preview));
    } finally {
      busy = false;
    }
  }
  async function previewAfterApply() {
    busy = false;
    await preview();
  }
  launch.addEventListener('click', () => {
    if (panel.style.display === 'none') preview();
    else panel.style.display = 'none';
  });
})();
