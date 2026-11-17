import * as db from './db.js';
import {
  newProject, upgradeProject, newExpense, uid, today, money, totals, round, validNumber, validateReceipt,
  isBillable, byDateTime, monthBounds, shiftMonth, taxInvoiceDeadline, compact, STATUS
} from './model.js';
import { renderInvoice, presets, escapeHTML as e } from './invoice.js';
import { compressImage, readReceiptFile, isReceiptFile, parseReceipt, parseTollStatement, checkBalanceChain, matchCategory } from './receipt.js';
import { BUILTIN_FORMATS, findFormat, isSheetFormat, fillPattern, checklist, exportFormat, importFormat, receiptFileNames } from './formats.js';
import { readCalendarFile, suggestShootDays, eventsInRange } from './schedule.js';
import { openBook, analyzeBook, fillWorkbook, renderBookHTML, renderBookCanvas, loadTemplate, bytesToBase64, SHEET_CSS, splitRef } from './sheet.js';
import {
  download, receiptFiles, expenseLogCSV, invoiceLines, sheetRowsForPaste, copyRich, zip, fileNames,
  submissionManifest, readSubmission, SUBMISSION_FILE, strToU8
} from './exports.js';

const $ = s => document.querySelector(s);
let state, projects = [], formats = [], events = [], images = new Map();
let tab = 'details', filter = 'all', saveChain = Promise.resolve(), revision = 0, busy = false, messageTimer = null;
let inspectingId = null, touchStartX = 0, touchStartY = 0;
const TABS = ['details', 'work', 'receipts', 'invoice'];

const style = document.createElement('style'); style.textContent = SHEET_CSS; document.head.append(style);

// ---- Small helpers --------------------------------------------------------------------------------
function message(text, persistent = false) {
  const toast = $('#hud-toast'), textEl = $('#hud-toast-text');
  clearTimeout(messageTimer);
  if (!text) { toast.classList.remove('is-visible', 'is-error'); return; }
  textEl.textContent = text;
  toast.classList.remove('is-error', 'is-visible');
  void toast.offsetWidth;                       // restart the animation so a repeated message still shows
  toast.classList.add('is-visible');
  if (!persistent) messageTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}
function fail(error) {
  console.error(error);
  const toast = $('#hud-toast');
  clearTimeout(messageTimer);
  $('#hud-toast-text').textContent = error.message || String(error);
  toast.classList.add('is-visible', 'is-error');
  messageTimer = setTimeout(() => toast.classList.remove('is-visible', 'is-error'), 5000);
}
const setting = key => { try { return localStorage.getItem(`wrapsheet.${key}`) || ''; } catch { return ''; } };
const setSetting = (key, value) => { try { value ? localStorage.setItem(`wrapsheet.${key}`, value) : localStorage.removeItem(`wrapsheet.${key}`); } catch { message('Settings could not be saved.'); } };
const getPath = path => path.split('.').reduce((o, k) => o?.[k], state);
function setPath(path, value) { const parts = path.split('.'); let o = state; for (const p of parts.slice(0, -1)) o = o[p]; o[parts.at(-1)] = value; }
const fmt = () => findFormat(formats, state.formatId);
const cur = () => state.project.currency;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortDate = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
function addDays(iso, days) { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + Number(days)); return d.toLocaleDateString('en-CA'); }
const TERMS = { due_receipt: 0, net_15: 15, net_30: 30, net_60: 60 };
const dueFrom = (invoiceDate, preset) => preset in TERMS ? addDays(invoiceDate, TERMS[preset]) : null;

// ---- Profile: one per device, shared by every invoice ---------------------------------------------
function loadProfile() {
  try { return JSON.parse(setting('profile') || setting('defaultContractor') || '{}'); } catch { return {}; }
}
function saveProfile(contractor) {
  const { logo, ...rest } = contractor;
  setSetting('profile', JSON.stringify(rest));
  if (logo !== undefined) setSetting('profileLogo', logo);
}
function applyProfile(s) {
  if (s.review) return s;                    // a crew submission keeps the sender's details
  s.contractor = { ...s.contractor, ...loadProfile(), logo: setting('profileLogo') || s.contractor.logo || '' };
  return s;
}

// ---- Saving ---------------------------------------------------------------------------------------
function setSaveStatus(text, color = 'var(--muted)') { const el = $('#save-status'); if (el) { el.textContent = text; el.style.color = color; } }
function save() {
  const snapshot = structuredClone(state), rev = ++revision;
  snapshot.updatedAt = Date.now();
  setSaveStatus('Saving…');
  saveChain = saveChain.catch(() => { }).then(() => db.put('projects', snapshot)).then(() => {
    if (rev === revision) setSaveStatus('Saved', 'var(--green)');
    const i = projects.findIndex(p => p.id === snapshot.id);
    if (i < 0) projects.push(snapshot); else projects[i] = snapshot;
    updatePicker();
  }).catch(error => { setSaveStatus('Not saved', '#f07c74'); fail(new Error(`Could not save: ${error.message}`)); });
  return saveChain;
}
const projectLabel = p => [p.project.invoiceNumber || p.project.defaultInvoiceNumber, p.project.projectTitle || 'Untitled', p.review ? '(review)' : ''].filter(Boolean).join(' · ');
function updatePicker() {
  const picker = $('#project-picker');
  if (!picker || !state) return;
  const sorted = [...projects].sort((a, b) => (b.project.shootEnd || '').localeCompare(a.project.shootEnd || '') || b.updatedAt - a.updatedAt);
  picker.innerHTML = sorted.map(p => `<option value="${p.id}" ${p.id === state.id ? 'selected' : ''}>${e(projectLabel(p.id === state.id ? state : p))}</option>`).join('');
}

// ---- Format, period and numbering ----------------------------------------------------------------
function invoiceNumberFromPattern() {
  const pattern = fmt().numbering?.pattern;
  if (pattern) state.project.invoiceNumber = fillPattern(pattern, state, fmt());
}
function setMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return;
  const { start, end } = monthBounds(month);
  Object.assign(state.project, { month, shootStart: start, shootEnd: end, invoiceDate: end });
  const due = dueFrom(end, state.project.termsPreset); if (due) state.project.dueDate = due;
  invoiceNumberFromPattern();
}
// full: switching to this format (take all its defaults). Otherwise only the rules it controls are refreshed.
function applyFormat(format, { full = false } = {}) {
  const p = state.project, d = format.defaults || {};
  state.formatId = format.id;
  for (const [k, v] of Object.entries(d)) if (k !== 'labor' && v !== undefined && (full || ['periodMode', 'taxType', 'taxRate', 'vatOnExpenses'].includes(k))) p[k] = v;
  if (format.crew) {
    const et = format.entityTypes?.[state.contractor.entityType] || format.entityTypes?.freelancer;
    if (et) Object.assign(p, { taxType: et.taxType, taxRate: et.taxRate });
  }
  // Lines a format filled in (and nobody edited) belong to that format; swap them when the format changes.
  if (full && state.labor.every(l => l.auto)) state.labor = (d.labor || []).map(l => ({ id: uid(), ...l, auto: true }));
  if (full && !p.projectTitle && format.kind === 'sheet') p.projectTitle = `${format.name.replace(/\s*\(.*\)$/, '')} ${p.month || ''}`.trim();
  if (p.periodMode === 'month') setMonth(p.month || today().slice(0, 7)); else invoiceNumberFromPattern();
  if (format.timeZone) p.timeZone = format.timeZone;
}

// ---- Summary sidebar ------------------------------------------------------------------------------
function summary() {
  if (!state) return;
  const t = totals(state), c = cur(), f = fmt();
  $('#summary-format').textContent = state.review ? `Reviewing · ${f.name}` : f.name;
  $('#summary-name').textContent = state.project.invoiceNumber || state.project.projectTitle || 'Untitled invoice';
  $('#labor-total').textContent = money(t.labor, c);
  $('#expense-label').textContent = `Expenses (${t.count})`;
  $('#expense-total').textContent = money(t.expenses, c);
  const mode = state.project.taxType;
  $('#tax-label').textContent = mode === 'withholding' ? `Withholding ${state.project.taxRate}%` : mode === 'none' ? 'No tax' : `VAT ${state.project.taxRate}%${state.project.vatOnExpenses ? ' (incl. expenses)' : ''}`;
  $('#tax-total').textContent = mode === 'none' ? '—' : `${t.isWithholding ? '−' : '+'}${money(t.tax, c)}`;
  $('#grand-total').textContent = money(t.total, c);

  const pending = state.expenses.filter(r => r.status === 'pending').length, check = state.expenses.filter(r => r.status === 'check').length;
  const pill = $('#receipt-status-pill');
  if (!state.expenses.length) pill.hidden = true;
  else {
    pill.hidden = false;
    pill.className = `status-indicator-pill ${pending || check ? 'pending' : 'verified'}`;
    pill.textContent = pending || check ? [pending && `${pending} to review`, check && `${check} flagged`].filter(Boolean).join(' · ') : 'All receipts reviewed';
    pill.onclick = pending || check ? () => { filter = pending ? 'pending' : 'check'; go('receipts'); } : null;
  }
  const btn = $('#primary-action-btn');
  btn.textContent = { details: 'Next: work', work: 'Next: receipts', receipts: 'Next: invoice', invoice: f.crew && !state.review ? 'Download submission .zip' : 'Download all files .zip' }[tab];
}

// ---- Form building blocks -------------------------------------------------------------------------
const val = path => e(getPath(path) ?? '');
const field = (label, path, type = 'text', extra = '') => `<label>${label}<input data-field="${path}" type="${type}" value="${val(path)}" ${extra}></label>`;
const area = (label, path, extra = '') => `<label class="full">${label}<textarea data-field="${path}" ${extra}>${val(path)}</textarea></label>`;
const select = (label, path, options, extra = '') => `<label>${label}<select data-field="${path}" ${extra}>${options.map(o => {
  const [v, t] = Array.isArray(o) ? o : [o, o];
  return `<option value="${e(v)}" ${String(getPath(path)) === String(v) ? 'selected' : ''}>${e(t)}</option>`;
}).join('')}</select></label>`;
const panel = (title, description, content, extraClass = '', action = '') => `<div class="panel ${extraClass}"><div class="section-head"><div><h2>${title}</h2>${description ? `<p>${description}</p>` : ''}</div>${action}</div>${content}</div>`;

// ---- 1. Details ------------------------------------------------------------------------------------
function detailsView() {
  const f = fmt(), p = state.project, sheet = isSheetFormat(f);
  const userFormats = formats.filter(x => x.kind === 'sheet');
  const formatPanel = panel('Billing format', '',
    `<div class="form-grid">
      <label class="full">Format
        <select data-field="formatId">
          <optgroup label="Built in">${BUILTIN_FORMATS.map(x => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${e(x.name)}</option>`).join('')}</optgroup>
          ${userFormats.length ? `<optgroup label="Client formats">${userFormats.map(x => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${e(x.name)}</option>`).join('')}</optgroup>` : ''}
        </select>
      </label>
    </div>
    ${sheet ? `<p class="hint">Based on ${e(f.sheet.fileName)}</p>` : f.description ? `<p class="hint">${e(f.description)}</p>` : ''}
    <div class="button-row">
      <label class="file-button" title="Choose a past invoice from the client (.xlsx), or a .wrapformat.json file">Add a client format<input id="format-input" type="file" accept=".xlsx,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
      ${sheet ? `<button data-action="edit-format">Edit format</button>` : ''}
    </div>

    ${f.crew ? `<div class="form-grid" style="margin-top:16px">
      ${select('You invoice as', 'contractor.entityType', Object.entries(f.entityTypes).map(([k, v]) => [k, v.label]))}
      </div><p class="hint">${e(f.entityTypes[state.contractor.entityType]?.note || '')}</p>` : ''}`);

  const periodFields = p.periodMode === 'month'
    ? `<label>Month<input data-field="project.month" type="month" value="${e(p.month)}"></label>`
    : `${field('Start date', 'project.shootStart', 'date')}${field('End date', 'project.shootEnd', 'date')}`;
  const hasPattern = Boolean(f.numbering?.pattern);
  const numberHelp = hasPattern && f.numbering.pattern.includes('{num}') ? field('Invoice sequence no.', 'project.sequence', 'number', 'min="1" max="9999" step="1"') : '';
  const detailsPanel = panel('Invoice details', '',
    `<div class="form-grid">
      ${field(f.crew ? 'Production / job' : 'Project title', 'project.projectTitle', 'text', 'maxlength="200" placeholder="e.g. Solo Leveling — November"')}
      ${sheet ? '' : field(f.crew ? 'Billed to' : 'Client', 'project.clientName', 'text', 'maxlength="200"')}
      ${select('Billing period', 'project.periodMode', [['month', 'Calendar month'], ['range', 'Dates']])}
      ${periodFields}
      ${field('Invoice number', 'project.invoiceNumber', 'text', `maxlength="100" placeholder="${e(p.defaultInvoiceNumber)}"`)}
      ${numberHelp}
      ${field('Invoice date', 'project.invoiceDate', 'date')}
      <label>Payment terms
        <span class="split-row">
          <select data-field="project.termsPreset">${[['due_receipt', 'Due on receipt'], ['net_15', 'Net 15'], ['net_30', 'Net 30'], ['net_60', 'Net 60'], ['custom', 'Custom date']].map(([v, t]) => `<option value="${v}" ${p.termsPreset === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <input data-field="project.dueDate" type="date" value="${e(p.dueDate)}" aria-label="Due date">
        </span>
      </label>
      ${!sheet || f.sheet.mapping.fields.location ? field('Location / site of services', 'project.location', 'text', 'maxlength="200" placeholder="e.g. Daejeon, Chuncheon"') : ''}
      ${sheet ? '' : select('Currency', 'project.currency', [['KRW', 'KRW'], ['USD', 'USD'], ['EUR', 'EUR']])}
      ${sheet ? '' : area(f.crew ? 'Address of the studio' : 'Client address', 'project.clientAddress')}
      ${sheet || f.crew ? '' : area('Notes on the invoice', 'project.notes')}
    </div>

    ${!state.contractor.name ? `<p class="notice">Add your name and bank details in <a data-action="open-profile">Profile</a>.</p>` : ''}`, '',
    p.periodMode === 'month' && !state.review ? '<button data-action="next-period" title="New invoice for the following month: same client and fee, next number">Start next month →</button>' : '');

  return formatPanel + detailsPanel;
}

// ---- 2. Work --------------------------------------------------------------------------------------
const laborTypes = ['Shoot day', 'Prep day', 'Travel day', 'Half day', 'Overtime (hours)', 'Monthly fee', 'Weekly rate', 'Flat fee', 'Kit & equipment rental', 'Assistant', 'Post-production', 'Other'];
function workView() {
  const step = cur() === 'KRW' ? '1000' : 'any', f = fmt(), mode = state.project.taxType;
  const rows = state.labor.length ? state.labor.map((r, i) => `
      <div class="row-card">
        <div class="row-top">
          <strong>${String(i + 1).padStart(2, '0')} · <span data-row-total="${i}">${money(round(r.rate * r.quantity, cur()), cur())}</span></strong>
          <button class="remove" data-action="remove-labor" data-id="${r.id}">Remove</button>
        </div>
        <div class="form-grid">
          ${field('Description', `labor.${i}.description`)}
          ${state.project.periodMode === 'month' ? '' : field('Date', `labor.${i}.date`, 'date')}
          ${select('Unit', `labor.${i}.unit`, ['day', 'hour', 'week', 'month', 'flat', 'item', 'km'])}
          ${field('Quantity', `labor.${i}.quantity`, 'number', 'min="0" max="1000000" step="0.5"')}
          ${field(`Rate (${cur()})`, `labor.${i}.rate`, 'number', `min="0" step="${step}"`)}
        </div>
        ${mode === 'none' ? '' : `<label class="check-pill"><input type="checkbox" data-field="labor.${i}.taxable" ${r.taxable ? 'checked' : ''}><span>${mode === 'withholding' ? 'Withholding applies' : 'VAT applies'}</span></label>`}
      </div>`).join('') : '<p class="empty">No work lines yet.</p>';
  const taxLocked = f.crew;
  return panel('Work', state.project.periodMode === 'month' ? 'Fees for this billing period.' : 'Day rates, fees and kit for this job.',
    `<div class="inline-action-row">
      <label>Add a line<select id="labor-kind">${laborTypes.map(t => `<option>${t}</option>`).join('')}</select></label>
      <button class="primary" data-action="add-labor">Add</button>
    </div>
    ${rows}`) +
    panel('Tax', taxLocked ? 'Set by how you invoice (Details tab).' : '',
      `<div class="form-grid">
        ${select('Tax', 'project.taxType', [['vat', 'VAT added to the total'], ['withholding', 'Withholding deducted (원천징수)'], ['none', 'No tax']], taxLocked ? 'disabled' : '')}
        ${mode === 'none' ? '' : field('Rate (%)', 'project.taxRate', 'number', `min="0" max="100" step="0.1" ${taxLocked ? 'disabled' : ''}`)}
      </div>
      ${mode === 'vat' ? `<label class="check-pill"><input type="checkbox" data-field="project.vatOnExpenses" ${state.project.vatOnExpenses ? 'checked' : ''} ${taxLocked ? 'disabled' : ''}><span>Also charge VAT on reimbursed expenses</span></label>` : ''}
`);
}

// ---- 3. Receipts ---------------------------------------------------------------------------------
const sortedExpenses = () => state.expenses.map((r, i) => ({ r, i })).sort((a, b) => byDateTime(a.r, b.r));
const shootSuggestions = r => suggestShootDays(events, r.date, r.time, fmt().returnLabel || 'return');

function statusButtons(r) {
  const b = (status, label, cls = '') => `<button class="${cls}" data-action="set-status" data-id="${r.id}" data-value="${status}">${label}</button>`;
  if (r.status === 'pending') return b('verified', 'Looks right', 'primary') + b('check', 'Flag') + b('excluded', "Don't bill");
  if (r.status === 'check') return b('verified', 'Looks right', 'primary') + b('excluded', "Don't bill") + b('pending', 'Edit');
  if (r.status === 'excluded') return b('pending', 'Bring back');
  return b('pending', 'Edit') + b('check', 'Flag');
}

function receiptCard(r, i, names) {
  const img = r.receiptId ? images.get(r.receiptId) : null;
  const suggestions = shootSuggestions(r);
  const noShoot = events.length && r.date && !suggestions.length;
  const locked = r.status === 'verified' || r.status === 'excluded';
  const dis = locked ? 'disabled' : '';
  const fileName = r.receiptId ? (names.get(r.receiptId) || img?.name || '') : '';
  return `
  <div class="row-card receipt-row status-${r.status}" id="exp-${r.id}">
    <div class="row-top">
      <span class="badge status-${r.status}">${STATUS[r.status]}</span>
      <span class="row-meta">${e(r.date ? shortDate(r.date) : 'No date')}${r.time ? ` ${e(r.time)}` : ''} · ${e(r.category || 'No category')} · ${money(Number(r.total) || 0, cur())}</span>
      <button class="remove" data-action="remove-receipt" data-id="${r.id}">Delete</button>
    </div>
    <div class="receipt-card">
      <div class="thumb-col">
        ${img ? `<img class="receipt-image" src="${e(img.imageThumbnail)}" alt="Receipt" data-inspect-id="${r.id}" title="Open full size">` : '<div class="thumb-empty">No file</div>'}
        ${fileName && isBillable(r) ? `<small class="file-name" title="File name in the receipts folder">${e(fileName)}</small>` : ''}
      </div>
      <div>
        <div class="form-grid three">
          ${field('Date', `expenses.${i}.date`, 'date', dis)}
          ${field('Time', `expenses.${i}.time`, 'time', dis)}
          ${field(`Amount (${cur()})`, `expenses.${i}.total`, 'number', `min="0" step="any" ${dis}`)}
          ${field('Vendor', `expenses.${i}.vendor`, 'text', dis)}
          <label>Category<input data-field="expenses.${i}.category" list="category-list" value="${e(r.category)}" ${dis}></label>
          <label>Paid by<input data-field="expenses.${i}.paidBy" list="card-list" value="${e(r.paidBy)}" placeholder="e.g. 현대카드 2608" ${dis}></label>
          ${field('Location', `expenses.${i}.location`, 'text', dis)}
          <label>Shoot day<input data-field="expenses.${i}.shootDay" list="sd-${r.id}" value="${e(r.shootDay)}" ${dis}>
            <datalist id="sd-${r.id}">${suggestions.map(s => `<option value="${e(s.label)}">`).join('')}</datalist></label>
          ${field('Notes', `expenses.${i}.notes`, 'text', `${dis} placeholder="${r.status === 'check' ? 'What needs confirming?' : ''}"`)}
        </div>
        ${!r.shootDay && suggestions.length && !locked ? `<div class="chip-row">${suggestions.map(s => `<button class="chip" data-action="apply-shootday" data-id="${r.id}" data-value="${e(s.label)}">${e(s.label)}</button>`).join('')}</div>` : ''}
        ${noShoot ? `<p class="notice">No shoot on this date.</p>` : ''}
        ${r.warning ? `<p class="notice">${e(r.warning)}</p>` : ''}
        ${state.review ? reviewLine(r) : ''}
        <div class="actions">${statusButtons(r)}${r.receiptId && !locked && setting('apiKey') ? `<button data-action="scan" data-id="${r.id}">Re-read</button>` : ''}</div>
      </div>
    </div>
  </div>`;
}

function tollPanel(trips) {
  if (!trips.length) return '';
  const chain = checkBalanceChain(trips.map(({ r }) => ({ date: r.date, time: r.time, amount: Number(r.total), balanceAfter: r.balanceAfter === '' ? '' : Number(r.balanceAfter) })));
  const billable = trips.filter(({ r }) => isBillable(r));
  const sum = billable.reduce((n, { r }) => n + Number(r.total || 0), 0);
  const notShoot = trips.filter(({ r }) => events.length && !shootSuggestions(r).length);
  const rows = trips.map(({ r, i }) => {
    const sugg = shootSuggestions(r);
    return `<tr class="status-${r.status}">
      <td>${e(r.date)} ${e(r.time)}</td>
      <td>${e(r.route || r.vendor)}</td>
      <td class="num">${money(Number(r.total) || 0, cur())}</td>
      <td class="num">${r.balanceAfter === '' ? '—' : Number(r.balanceAfter).toLocaleString()}</td>
      <td><input data-field="expenses.${i}.shootDay" list="sd-${r.id}" value="${e(r.shootDay)}" placeholder="${events.length && !sugg.length ? 'No shoot' : ''}" aria-label="Shoot day"><datalist id="sd-${r.id}">${sugg.map(s => `<option value="${e(s.label)}">`).join('')}</datalist></td>
      <td><select data-action-change="set-status" data-id="${r.id}" aria-label="Status">${['pending', 'verified', 'check', 'excluded'].map(s => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select></td>
    </tr>`;
  }).join('');
  const notes = chain.notes.map(n => n.kind === 'topup'
    ? `<li>Top-up of ${money(n.amount, cur())} before ${e(n.at.date)} ${e(n.at.time)}.</li>`
    : `<li class="warn">Balance does not continue between ${e(n.after.date)} ${e(n.after.time)} and ${e(n.at.date)} ${e(n.at.time)} (${money(-n.amount, cur())} unaccounted). A trip is missing here, or this is one you excluded.</li>`).join('');
  return panel('Hi-pass statement', `${plural(trips.length, 'trip')} · ${plural(billable.length, 'billed trip')} · ${money(sum, cur())}`,
    `<div class="table-scroll"><table class="data-table"><thead><tr><th>Date</th><th>Route</th><th class="num">Toll</th><th class="num">Balance after</th><th>Shoot day</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="check-block ${chain.ok ? 'ok' : 'warn'}">
      <strong>${chain.checked < 2 ? 'Balance check: not enough balances read.' : chain.ok ? 'Balance check: the balance column continues without gaps.' : 'Balance check: gaps found.'}</strong>
      ${notes ? `<ul>${notes}</ul>` : ''}
      ${notShoot.length ? `<p>${plural(notShoot.length, 'trip')} on days with no shoot in your calendar: ${notShoot.map(({ r }) => e(r.date)).filter((d, k, a) => a.indexOf(d) === k).join(', ')}. To leave them out, untick them on the Hi-pass site, print again and import the new statement.</p>` : ''}
    </div>
    <div class="button-row">
      <button data-action="verify-toll-shootdays">Approve shoot days</button>
      <button data-action="verify-toll-all">Approve all</button>
      <button class="remove" data-action="remove-toll">Remove</button>
    </div>`);
}

function receiptsView() {
  const f = fmt(), hasKey = Boolean(setting('apiKey'));
  const all = sortedExpenses(), counts = Object.fromEntries(Object.keys(STATUS).map(k => [k, all.filter(x => x.r.status === k).length]));
  const tolls = all.filter(x => x.r.source === 'hipass');
  const others = all.filter(x => x.r.source !== 'hipass' && (filter === 'all' || x.r.status === filter));
  const t = totals(state);
  const periodEvents = eventsInRange(events, state.project.shootStart, state.project.shootEnd);
  const names = receiptFileNames(state, f);
  const cards = (state.expenses.length ? others.map(({ r, i }) => receiptCard(r, i, names)).join('') : '') ||
    `<p class="empty">${state.expenses.length ? 'Nothing in this view.' : 'No receipts yet.'}</p>`;
  const cats = Object.entries(t.categories).map(([k, v]) => `${e(k)} ${v.count} · ${money(v.total, cur())}`).join('<span class="sep">|</span>');
  const usedCards = [...new Set(projects.flatMap(p => p.expenses.map(r => r.paidBy)).concat(state.expenses.map(r => r.paidBy)).filter(Boolean))];

  return panel('Receipts', 'Mark each receipt. "Looks right" and "Flag" put it on the invoice; "To review" and "Don\'t bill" leave it off.',
    `${hasKey ? '' : `<p class="notice">Add a Gemini key in <a data-action="open-settings">Settings</a> to read receipts automatically.</p>`}
    <div class="upload-box" id="receipt-dropzone">
      <div class="button-row">
        <label class="file-button primary">Upload receipts<input id="receipt-input" type="file" accept="image/*,application/pdf,.pdf" multiple></label>
        <label class="file-button mobile-only">Take photo<input id="camera-input" type="file" accept="image/*" capture="environment"></label>
        <button data-action="manual-receipt">Add by hand</button>
        <span class="hint inline">Receipts and Hi-pass statements · PDF or photo · or drop files here</span>
      </div>
    </div>
    <div class="calendar-line">
      <span>${events.length ? `Shoot calendar: ${plural(periodEvents.length, 'shoot day')} this period` : 'Upload your shoot calendar (.ics) to check expenses against shoot days.'}</span>
      <label class="file-button small">${events.length ? 'Update calendar' : 'Upload calendar'}<input id="ics-input" type="file" accept=".ics,text/calendar,.zip"></label>
      ${events.length ? `<button class="small" data-action="clear-calendar">Remove</button>` : ''}
    </div>
    <datalist id="category-list">${f.categories.map(c => `<option value="${e(c)}">`).join('')}</datalist>
    <datalist id="card-list">${usedCards.map(c => `<option value="${e(c)}">`).join('')}</datalist>`) +
    tollPanel(tolls) +
    `<div class="panel">
      <div class="filter-row">
        ${[['all', 'All', all.length - tolls.length], ...Object.entries(STATUS).map(([k, v]) => [k, v, all.filter(x => x.r.source !== 'hipass' && x.r.status === k).length])]
      .map(([k, label, n]) => `<button class="chip ${filter === k ? 'active' : ''}" data-action="filter" data-value="${k}">${label} <span>${n}</span></button>`).join('')}
      </div>
      ${cats ? `<p class="category-line">${cats}</p>` : ''}
      ${cards}
    </div>`;
}

// ---- 4. Invoice -----------------------------------------------------------------------------------
function invoiceView() {
  const f = fmt(), sheet = isSheetFormat(f), p = state.project, t = totals(state);
  const issues = checklist(state, f, { hasFile: id => images.has(id) });
  const blocks = issues.filter(i => i.level === 'block');
  const crewSubmit = f.crew && !state.review;
  const btn = (action, label, ext, primary = false, extra = '') => `<button class="${primary ? 'primary ' : ''}dl-btn" data-action="${action}" ${extra}>${label ? `${label} ` : ''}<span class="ext">${ext}</span></button>`;
  const deliver = sheet
    ? btn('download-all', 'All files', '.zip', true) + btn('download-xlsx', '', '.xlsx') + btn('download-pdf', '', '.pdf') +
      btn('download-receipts', 'Receipts', '.zip') + btn('download-log', 'Expense log', '.csv') + `<button data-action="copy-rows">Copy expense rows</button>`
    : crewSubmit
      ? btn('download-package', 'Submission', '.zip', true, blocks.length ? 'disabled' : '') + btn('download-pdf', '', '.pdf') + btn('download-receipts', 'Receipts', '.zip')
      : btn('download-all', 'All files', '.zip', true) + btn('download-pdf', '', '.pdf') + btn('download-receipts', 'Receipts', '.zip') + btn('download-log', 'Expense log', '.csv');
  const names = fileNames(state, f);
  const issueList = issues.length ? `<ul class="issue-list">${issues.map(i => `<li class="${i.level}">${e(i.text)}</li>`).join('')}</ul>` : '<p class="ok-line">Everything is reviewed and ready.</p>';

  const reviewPanel = state.review ? reviewPanelHTML() : '';
  const deliverPanel = panel(crewSubmit ? 'Submit to arki pictures' : 'Deliverables', crewSubmit
    ? 'Send the .zip to arki pictures by email or Drive.'
    : `Files: ${e(sheet ? names.xlsx + ', ' : '')}${e(names.pdf)}, ${e(names.folder)}/ receipts, ${e(names.log)}.`,
    `${issueList}<div class="deliver-grid">${deliver}</div>
    ${sheet ? `<p class="hint">Pasting into Google Sheets: click the first expense row, press ⌘⇧V, then check the totals.</p>` : ''}`);

  const taxPanel = (f.taxInvoice?.enabled !== false && sheet && p.taxType === 'vat') ? taxInvoicePanel(t) : '';
  const stylePanel = sheet ? '' : `<details class="panel style-panel"><summary>Invoice style</summary>
      <div class="form-grid" style="margin-top:16px">
        ${select('Layout', 'invoice.templateId', presets.map(x => [x.id, x.name]))}
        <label>Accent<span class="swatch-group">${['#a8c3d0', '#d4a373', '#9aa899', '#c97a7e', '#c8c8c4'].map(c => `<button type="button" class="swatch-btn ${state.invoice.accent === c ? 'active' : ''}" style="background:${c}" data-set-color="${c}" aria-label="Accent ${c}"></button>`).join('')}</span></label>
      </div>
      <label class="check-pill"><input type="checkbox" data-field="invoice.options.showReceiptGallery" ${state.invoice.options.showReceiptGallery ? 'checked' : ''}><span>Add receipt images to the PDF</span></label>
      <label class="check-pill"><input type="checkbox" data-field="invoice.options.showBankInfo" ${state.invoice.options.showBankInfo ? 'checked' : ''}><span>Show bank details</span></label>

    </details>`;
  const previewBlock = `<div class="panel preview-panel">
      <div class="section-head"><div><h2>Preview</h2></div><button data-action="open-preview">Full size</button></div>
      <div class="preview-viewport-box" id="scaler-viewport"><div class="preview-scaler-stage" id="scaler-stage"><div id="invoice-preview"></div></div></div>
    </div>`;
  return reviewPanel + deliverPanel + previewBlock + taxPanel + stylePanel;
}

function taxInvoicePanel(t) {
  const f = fmt(), p = state.project, c = cur();
  const items = f.taxInvoice?.items || ['{labor} ({yyyy}.{mm})', 'Reimbursed Expenses ({yyyy}.{mm})'];
  const rows = [[fillPattern(items[0], state, f), t.labor, t.laborTax]];
  if (p.vatOnExpenses && t.expenses) rows.push([fillPattern(items[1] || 'Reimbursed Expenses', state, f), t.expenses, t.expenseTax]);
  const deadline = taxInvoiceDeadline(p.shootEnd || p.invoiceDate);
  const daysLeft = Math.round((new Date(deadline + 'T23:59:00') - new Date()) / 86400000);
  const cell = (shown, value) => `<button class="copy-cell" data-action="copy-text" data-value="${e(value)}" title="Click to copy">${e(shown)}</button>`;
  return panel('Tax invoice (Hometax)', `Issue after approval · dated ${e(p.invoiceDate)} · deadline ${e(deadline)}${daysLeft >= 0 ? ` (${plural(daysLeft, 'day')} left)` : ' (passed)'}`,
    `<div class="table-scroll"><table class="data-table"><thead><tr><th>Item</th><th class="num">Supply amount</th><th class="num">VAT</th></tr></thead><tbody>
      ${rows.map(([item, supply, vat]) => `<tr><td>${cell(item, item)}</td><td class="num">${cell(money(supply, c), supply)}</td><td class="num">${cell(money(vat, c), vat)}</td></tr>`).join('')}
    </tbody></table></div>
    ${f.taxInvoice?.note ? `<p class="hint pre">${e(f.taxInvoice.note)}</p>` : ''}
    <p class="hint">Click a value to copy it. Amount changed after issuing? Issue a 수정세금계산서.</p>`);
}

// ---- Review mode (arki checking a crew submission) ---------------------------------------------
function reviewLine(r) {
  return `<div class="review-line"><span>Review:</span>
    <button class="chip ${r.reviewStatus === 'ok' ? 'active' : ''}" data-action="review-mark" data-id="${r.id}" data-value="ok">OK</button>
    <button class="chip ${r.reviewStatus === 'query' ? 'active warn' : ''}" data-action="review-mark" data-id="${r.id}" data-value="query">Query</button>
    <input data-review-note="${r.id}" value="${e(r.reviewNote || '')}" placeholder="Question for the crew member"></div>`;
}
function reviewPanelHTML() {
  const t = totals(state), cl = state.review.claimed || {}, c = cur();
  const row = (label, claimed, actual) => `<tr><td>${label}</td><td class="num">${money(claimed ?? 0, c)}</td><td class="num">${money(actual, c)}</td><td>${Math.abs((claimed ?? 0) - actual) < 1 ? '✓' : '<strong class="warn">Differs</strong>'}</td></tr>`;
  const queries = state.expenses.filter(r => r.reviewStatus === 'query').length, oks = state.expenses.filter(r => r.reviewStatus === 'ok').length;
  return panel(`Reviewing ${e(state.contractor.name || 'submission')}`, `Imported ${e(state.review.importedAt.slice(0, 10))} from ${e(state.review.fileName)}. ${plural(oks, 'line')} OK, ${queries} ${queries === 1 ? 'query' : 'queries'}.`,
    `<div class="table-scroll"><table class="data-table"><thead><tr><th></th><th class="num">Claimed</th><th class="num">Recalculated</th><th></th></tr></thead><tbody>
      ${row('Work', cl.labor, t.labor)}${row('Expenses', cl.expenses, t.expenses)}${row('Tax', cl.tax, t.tax)}${row('Total', cl.total, t.total)}
    </tbody></table></div>
    <p class="hint">${e(state.contractor.role || '')} · ${e(fmt().entityTypes?.[state.contractor.entityType]?.label || '')} · Business no. ${e(state.contractor.taxId || '—')} · ${e(state.contractor.bankName)} ${e(state.contractor.accountNumber)} (${e(state.contractor.accountHolder || '')})</p>
    <label class="full">Note to the crew member<textarea data-field="review.note">${e(state.review.note || '')}</textarea></label>
    <div class="button-row"><button class="primary" data-action="copy-review">Copy feedback</button><button data-action="go-receipts">Check receipts</button></div>`);
}

// ---- Preview ---------------------------------------------------------------------------------------
let previewCache = { key: '', html: '' };
function invoiceHTML() {
  const f = fmt();
  if (isSheetFormat(f)) {
    const key = JSON.stringify([state.project, state.labor, state.expenses.map(r => [r.date, r.time, r.total, r.category, r.vendor, r.status]), f.id, f.updatedAt]);
    if (previewCache.key === key) return previewCache.html;
    const book = openBook(buildWorkbook(), f.sheet.mapping.sheet);
    previewCache = { key, html: `<div class="sheet-paper">${renderBookHTML(book, { maxCol: f.sheet.mapping.maxCol })}</div>` };
    return previewCache.html;
  }
  return `<div class="invoice-paper" style="--invoice-accent:${e(state.invoice.accent)}">${renderInvoice(state.invoice.templateId, enrichedState())}</div>`;
}
function preview() {
  const el = $('#invoice-preview');
  if (!el) return;
  try { el.innerHTML = invoiceHTML(); } catch (err) { el.innerHTML = `<p class="notice">Preview failed: ${e(err.message)}</p>`; return; }
  requestAnimationFrame(() => {
    const viewport = $('#scaler-viewport'), stage = $('#scaler-stage');
    if (!viewport || !stage) return;
    const natural = el.firstElementChild?.scrollWidth || 680, available = viewport.clientWidth - 24;
    const scale = Math.min(1, available / natural);
    stage.style.width = `${natural}px`;
    stage.style.transform = `scale(${scale})`;
    stage.style.marginBottom = `-${stage.offsetHeight * (1 - scale)}px`;
  });
}
window.addEventListener('resize', () => { if (tab === 'invoice') preview(); });

function enrichedState() {
  return {
    ...state,
    project: { ...state.project, invoiceNumber: state.project.invoiceNumber?.trim() || state.project.defaultInvoiceNumber },
    expenses: state.expenses.map((r, i) => ({ ...r, _i: i, imageThumbnail: images.get(r.receiptId)?.imageThumbnail || '' }))
  };
}

// ---- Rendering -------------------------------------------------------------------------------------
function render() {
  if (!state) return;
  const scroll = window.scrollY;
  $('#view').innerHTML = { details: detailsView, work: workView, receipts: receiptsView, invoice: invoiceView }[tab]();
  document.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'step' : 'false'); });
  summary();
  if (tab === 'invoice') preview();
  if (tab === 'receipts') initDropzone();
  window.scrollTo(0, scroll);
}
async function go(next) {
  if (busy) return;
  await saveChain;
  tab = next; location.hash = next; message('');
  render(); window.scrollTo(0, 0);
}

function updateField(path, value, el) {
  const old = getPath(path);
  if (el?.type === 'number') {
    const max = path === 'project.taxRate' ? 100 : path.endsWith('.quantity') ? 1e6 : 1e12;
    if (value === '' && /^expenses\./.test(path)) { setPath(path, ''); save(); summary(); return; }
    if (!validNumber(value, max)) throw new Error('Enter a valid number.');
    value = Number(value);
    if (path.endsWith('.rate') || /^expenses\.\d+\.total$/.test(path)) value = round(value, cur());
  }
  if (path.startsWith('contractor.')) {          // the profile is shared by every invoice
    setPath(path, value);
    if (!state.review) saveProfile(state.contractor);
  } else setPath(path, value);
  if (path.startsWith('labor.')) delete state.labor[Number(path.split('.')[1])].auto;

  const p = state.project;
  if (path === 'project.month') setMonth(value);
  if (path === 'project.sequence') invoiceNumberFromPattern();
  if (path === 'project.periodMode' && value === 'month') setMonth(p.month || (p.shootStart || today()).slice(0, 7));
  if (path === 'project.taxType' && old !== value) p.taxRate = value === 'withholding' ? 3.3 : value === 'vat' ? 10 : 0;
  if (path === 'project.termsPreset' && value !== 'custom') { const due = dueFrom(p.invoiceDate, value); if (due) p.dueDate = due; }
  if (path === 'project.invoiceDate' && p.termsPreset !== 'custom') { const due = dueFrom(value, p.termsPreset); if (due) p.dueDate = due; }
  if (path === 'project.dueDate' && value !== dueFrom(p.invoiceDate, p.termsPreset)) p.termsPreset = 'custom';
  if (path === 'contractor.entityType') applyFormat(fmt());
  save(); summary();
  if (path.startsWith('labor.')) {
    const i = Number(path.split('.')[1]), r = state.labor[i], cell = document.querySelector(`[data-row-total="${i}"]`);
    if (cell && r) cell.textContent = money(round(r.rate * r.quantity, cur()), cur());
  }
}
// Fields whose change reshapes the page.
const RERENDER = /^(formatId|project\.(month|periodMode|taxType|termsPreset|invoiceDate|sequence|shootStart|shootEnd|vatOnExpenses)|contractor\.entityType|expenses\.\d+\.(date|time|category|total|shootDay)|invoice\.)/;

// ---- Receipts: upload, read, statuses --------------------------------------------------------------
async function storeReceiptFile(file) {
  const rec = await readReceiptFile(file);
  rec.id = uid(); rec.projectId = state.id;
  await db.put('receipts', rec);
  images.set(rec.id, rec);
  return rec;
}
function autoShootDay(x) {
  const s = suggestShootDays(events, x.date, x.time, fmt().returnLabel || 'return');
  return s.length === 1 ? s[0].label : '';
}
const looksLikeToll = name => /hipass|hi-pass|하이패스/i.test(name);
async function handleUpload(files) {
  files = [...files].filter(isReceiptFile);
  if (!files.length) return message('Choose PDF or image files.');
  const apiKey = setting('apiKey'), f = fmt();
  busy = true; let read = 0, failed = 0;
  try {
    for (let n = 0; n < files.length; n++) {
      message(`Reading ${n + 1} of ${files.length}: ${files[n].name}`, true);
      let rec;
      try { rec = await storeReceiptFile(files[n]); } catch (err) { failed++; fail(err); continue; }
      if (looksLikeToll(files[n].name)) { busy = false; await tollFromRecord(rec); busy = true; continue; }
      let items = [{}];
      if (apiKey && navigator.onLine) {
        try { items = await parseReceipt(rec, apiKey, { currency: cur(), categories: f.categories }); read++; }
        catch (err) { items = [{ warning: `Could not read automatically (${err.message.slice(0, 80)}). Fill in by hand.` }]; failed++; }
      }
      if (items[0]?.documentType === 'toll_statement') { busy = false; await tollFromRecord(rec); busy = true; continue; }
      for (const item of items) {
        const x = newExpense({ ...item, receiptId: rec.id, source: 'receipt', currency: cur(), status: 'pending' });
        x.shootDay = autoShootDay(x);
        state.expenses.push(x);
      }
    }
  } finally { busy = false; }
  await save(); filter = 'all'; render();
  message(apiKey ? `${plural(files.length, 'file')} added · ${read} read${failed ? ` · ${failed} need typing` : ''}.` : `${plural(files.length, 'file')} added. Type in the details.`);
}
async function tollFromRecord(rec) {
  const apiKey = setting('apiKey');
  if (!apiKey) throw new Error('Reading a Hi-pass statement needs a Gemini key (Settings). Without one, add trips with "Add by hand".');
  const existing = state.expenses.filter(r => r.source === 'hipass');
  if (existing.length && !confirm(`This looks like a Hi-pass statement. Replace the current one (${plural(existing.length, 'trip')})?`)) return;
  busy = true; message('Reading the Hi-pass statement…', true);
  try {
    const { cardLast4, trips } = await parseTollStatement(rec, apiKey);
    if (!trips.length) throw new Error('No trips were found in this file. Check it is the usage statement (사용내역 확인증).');
    for (const old of existing) if (old.receiptId && !state.expenses.some(r => r !== old && r.receiptId === old.receiptId && r.source !== 'hipass')) { images.delete(old.receiptId); db.remove('receipts', old.receiptId).catch(() => { }); }
    state.expenses = state.expenses.filter(r => r.source !== 'hipass');
    const category = matchCategory('Toll', fmt().categories) || 'Toll';
    for (const t of trips) {
      const route = [t.entry, t.exit].filter(Boolean).join(' → ');
      const x = newExpense({ receiptId: rec.id, source: 'hipass', date: t.date, time: t.time, vendor: `하이패스 ${route}`.trim(), route, total: t.amount, vat: 0, category, paidBy: cardLast4 ? `하이패스 ${cardLast4}` : '하이패스', balanceAfter: t.balanceAfter, currency: cur(), status: 'pending' });
      x.shootDay = autoShootDay(x);
      state.expenses.push(x);
    }
    await save(); render();
    message(`${plural(trips.length, 'trip')} imported. Review them in the Hi-pass table.`);
  } finally { busy = false; }
}
async function rescan(id) {
  const r = state.expenses.find(x => x.id === id), apiKey = setting('apiKey');
  if (!apiKey) throw new Error('Add a Gemini key in Settings first.');
  busy = true; message('Reading…', true);
  try {
    const [item] = await parseReceipt(images.get(r.receiptId), apiKey, { currency: cur(), categories: fmt().categories });
    Object.assign(r, Object.fromEntries(Object.entries(item).filter(([, v]) => v !== '' && v !== undefined)), { status: 'pending' });
    if (!r.shootDay) r.shootDay = autoShootDay(r);
    await save(); message('Read again.');
  } finally { busy = false; render(); }
}
async function setStatus(id, status) {
  const r = state.expenses.find(x => x.id === id);
  if (!r) return;
  if (status === 'verified' || status === 'check') validateReceipt(r, cur());
  if (status === 'check' && !r.notes.trim()) r.notes = 'Confirm this is a work expense';
  r.status = status;
  await save();
}

// ---- Building deliverables -------------------------------------------------------------------------
function buildWorkbook() {
  const f = fmt(), p = state.project, t = totals(state);
  const lines = invoiceLines(state, f);
  return fillWorkbook(loadTemplate(f.sheet.base64), f.sheet.mapping, {
    fields: { invoiceDate: p.invoiceDate, invoiceNumber: p.invoiceNumber || p.defaultInvoiceNumber, location: p.location || '', dueDate: f.sheet.mapping.fields.dueDate ? p.dueDate : undefined },
    lines, roundTax: f.roundTax !== false,
    results: { labor: t.labor, expenses: t.expenses, tax: t.tax, total: t.total, count: lines.reduce((n, l) => n + Number(l.qty || 0), 0) }
  });
}
async function invoicePdfBytes() {
  if (!window.html2pdf) throw new Error('The PDF engine is still loading. Try again in a moment.');
  if (isSheetFormat(fmt())) return sheetPdfBytes();
  const root = document.createElement('div');
  root.className = 'pdf-export-root';
  root.innerHTML = invoiceHTML();
  document.body.append(root);
  try {
    await document.fonts.ready;
    await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => { })));
    const width = root.firstElementChild.scrollWidth;
    return await window.html2pdf().set({
      margin: isSheetFormat(fmt()) ? [8, 6, 8, 6] : [12, 10, 14, 10],
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0, x: 0, y: 0, windowWidth: width + 40 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'h2', 'figure', '.invoice-totals'] }
    }).from(root.firstElementChild).outputPdf('arraybuffer');
  } finally { root.remove(); }
}
/** Spreadsheet formats: draw the sheet to a canvas, scale onto A4 pages, break pages between rows. */
async function sheetPdfBytes() {
  const f = fmt();
  await document.fonts.load('10pt WrapKorean').catch(() => { });
  const { canvas, rowBottoms, width: W, height: H } = renderBookCanvas(openBook(buildWorkbook(), f.sheet.mapping.sheet), { maxCol: f.sheet.mapping.maxCol, scale: 2.5 });
  const dummy = document.createElement('div'); dummy.style.height = '1px'; document.body.append(dummy);
  const pdf = await window.html2pdf().set({ margin: 0, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } }).from(dummy).toPdf().get('pdf');
  dummy.remove();
  const margin = 10, pageW = 210 - margin * 2, pageH = 297 - margin * 2;
  const mmPerPx = pageW / W, pagePx = pageH / mmPerPx, ratio = canvas.width / W;
  let start = 0;
  while (start < H - 1) {
    let end = Math.min(H, start + pagePx);
    if (end < H) { const cut = rowBottoms.filter(y => y > start + 40 && y <= end).at(-1); if (cut) end = cut; }
    const slice = document.createElement('canvas');
    slice.width = canvas.width; slice.height = Math.ceil((end - start) * ratio);
    slice.getContext('2d').drawImage(canvas, 0, Math.floor(start * ratio), canvas.width, slice.height, 0, 0, slice.width, slice.height);
    pdf.addPage('a4', 'portrait');
    pdf.addImage(slice.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, pageW, (end - start) * mmPerPx);
    start = end;
  }
  pdf.deletePage(1);
  return pdf.output('arraybuffer');
}
const getRecord = async id => images.get(id) || db.get('receipts', id);
function requireBasics() {
  const f = fmt();
  if (!state.contractor.name?.trim() && !isSheetFormat(f)) throw new Error('Add your name in Profile before exporting.');
  if (!state.labor.length && !state.expenses.some(isBillable)) throw new Error('Add work or receipts first.');
}
async function withBusy(label, fn) {
  if (busy) return; busy = true; message(label, true);
  try { await fn(); } finally { busy = false; }
}

// ---- Actions -----------------------------------------------------------------------------------------
const actions = {
  'add-labor': async () => {
    const kind = $('#labor-kind').value;
    const unit = /month/i.test(kind) ? 'month' : /week/i.test(kind) ? 'week' : /flat/i.test(kind) ? 'flat' : /hour/i.test(kind) ? 'hour' : /rental/i.test(kind) ? 'item' : 'day';
    state.labor.push({ id: uid(), type: kind, description: kind, date: state.project.shootStart || today(), quantity: 1, rate: 0, unit, taxable: state.project.taxType !== 'none' });
    await save(); render();
  },
  'remove-labor': async id => { state.labor = state.labor.filter(r => r.id !== id); await save(); render(); },
  'manual-receipt': async () => {
    state.expenses.push(newExpense({ date: state.project.periodMode === 'month' ? '' : today(), currency: cur(), source: 'manual', status: 'pending' }));
    filter = 'all'; await save(); render();
    document.querySelector('.receipt-row:last-of-type')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  'set-status': async (id, value) => {
    await setStatus(id, value); render();
    if ($('#receipt-inspect-modal').open) openInspector(id);
  },
  'remove-receipt': async id => {
    const r = state.expenses.find(x => x.id === id);
    if (!r || !confirm('Delete this receipt and its file?')) return;
    state.expenses = state.expenses.filter(x => x.id !== id);
    if (r.receiptId && !state.expenses.some(x => x.receiptId === r.receiptId)) { images.delete(r.receiptId); db.remove('receipts', r.receiptId).catch(() => { }); }
    await save(); render();
  },
  'apply-shootday': async (id, value) => { const r = state.expenses.find(x => x.id === id); r.shootDay = value; await save(); render(); },
  'filter': async (_, value) => { filter = value; render(); },
  'scan': rescan,
  'verify-toll-shootdays': async () => {
    let n = 0, skipped = 0;
    for (const r of state.expenses.filter(r => r.source === 'hipass' && r.status === 'pending')) {
      if (!events.length || shootSuggestions(r).length) { r.status = 'verified'; if (!r.shootDay) r.shootDay = autoShootDay(r); n++; } else skipped++;
    }
    await save(); render(); message(`${plural(n, 'trip')} verified${skipped ? `, ${skipped} left for you to decide` : ''}.`);
  },
  'verify-toll-all': async () => { for (const r of state.expenses.filter(r => r.source === 'hipass' && r.status === 'pending')) r.status = 'verified'; await save(); render(); },
  'remove-toll': async () => {
    if (!confirm('Remove all Hi-pass trips from this invoice?')) return;
    for (const r of state.expenses.filter(r => r.source === 'hipass')) if (r.receiptId) { images.delete(r.receiptId); db.remove('receipts', r.receiptId).catch(() => { }); }
    state.expenses = state.expenses.filter(r => r.source !== 'hipass'); await save(); render();
  },
  'clear-calendar': async () => { if (!confirm('Remove the imported shoot calendar from this device?')) return; await db.clear('schedule'); events = []; render(); if ($('#settings').open) openSettings(); },
  'open-settings': () => openSettings(),
  'open-profile': () => openProfile(),
  'go-receipts': () => go('receipts'),
  'open-preview': () => { $('#preview-modal-content').innerHTML = invoiceHTML(); $('#preview-modal').showModal(); },
  'copy-text': async (_, value, btn) => {
    await navigator.clipboard.writeText(value);
    message(`Copied: ${value}`);
    document.querySelectorAll('.copy-cell.copied').forEach(x => x.classList.remove('copied'));
    btn?.classList.add('copied');
  },

  'download-xlsx': () => withBusy('Building spreadsheet…', async () => { requireBasics(); download(buildWorkbook(), fileNames(state, fmt()).xlsx); message('Spreadsheet downloaded.'); }),
  'download-pdf': () => withBusy('Rendering PDF…', async () => { requireBasics(); download(await invoicePdfBytes(), fileNames(state, fmt()).pdf, 'application/pdf'); message('PDF downloaded.'); }),
  'download-log': async () => { download(new Blob([expenseLogCSV(state, fmt(), images)], { type: 'text/csv;charset=utf-8' }), fileNames(state, fmt()).log); },
  'download-receipts': () => withBusy('Collecting receipts…', async () => {
    const files = await receiptFiles(state, fmt(), getRecord), folder = fileNames(state, fmt()).folder;
    if (!files.length) throw new Error('No verified receipts with files yet.');
    download(zip(files.map(f => ({ path: `${folder}/${f.name}`, bytes: f.bytes }))), `${folder}.zip`, 'application/zip');
    message(`${plural(files.length, 'receipt file')} in ${folder}.zip.`);
  }),
  'copy-rows': async () => { const rows = sheetRowsForPaste(state, fmt()); await copyRich(rows); message(`${plural(rows.count, 'row')} copied (${rows.columns.length} columns).`); },
  'download-all': () => withBusy('Preparing files…', async () => {
    requireBasics();
    const f = fmt(), n = fileNames(state, f), base = (state.project.invoiceNumber || 'invoice').replace(/[\\/:*?"<>|]/g, '_');
    const entries = [{ path: `${base}/${n.pdf}`, bytes: new Uint8Array(await invoicePdfBytes()) }, { path: `${base}/${n.log}`, bytes: strToU8(expenseLogCSV(state, f, images)) }];
    if (isSheetFormat(f)) entries.unshift({ path: `${base}/${n.xlsx}`, bytes: buildWorkbook() });
    for (const file of await receiptFiles(state, f, getRecord)) entries.push({ path: `${base}/${n.folder}/${file.name}`, bytes: file.bytes });
    download(zip(entries), `${base}.zip`, 'application/zip');
    message('Everything downloaded as one zip.');
  }),
  'download-package': () => withBusy('Building submission…', async () => {
    const f = fmt(), blocks = checklist(state, f, { hasFile: id => images.has(id) }).filter(i => i.level === 'block');
    if (blocks.length) throw new Error(blocks[0].text);
    const n = fileNames(state, f), base = n.package.replace(/\.zip$/, '');
    const files = await receiptFiles(state, f, getRecord);
    const entries = [
      { path: `${base}/${n.pdf}`, bytes: new Uint8Array(await invoicePdfBytes()) },
      { path: `${base}/${n.log}`, bytes: strToU8(expenseLogCSV(state, f, images)) },
      ...files.map(x => ({ path: `${base}/receipts/${x.name}`, bytes: x.bytes })),
      { path: `${base}/${SUBMISSION_FILE}`, bytes: strToU8(JSON.stringify(submissionManifest(state, f, files), null, 1)) }
    ];
    download(zip(entries), n.package, 'application/zip');
    message('Submission package downloaded. Send it to arki pictures.');
  }),
  'next-period': async () => { await saveChain; await startNextMonth(state); },
  'delete-project': async () => {
    if (!confirm(`Delete "${projectLabel(state)}" and its receipts from this device?\n\nThis cannot be undone. Files you already downloaded are not affected.`)) return;
    for (const r of state.expenses) if (r.receiptId) await db.remove('receipts', r.receiptId).catch(() => { });
    await db.remove('projects', state.id);
    projects = projects.filter(p => p.id !== state.id);
    if (projects.length) await loadProject(projects.sort((a, b) => b.updatedAt - a.updatedAt)[0].id); else await createProject(fmt());
    message('Invoice deleted.');
  },
  'edit-format': async () => { const out = await openFormatEditor(fmt()); if (out) { await saveFormat(out); message('Format saved.'); } },
  'settings-edit-format': async id => {
    $('#settings').close();
    const out = await openFormatEditor(formats.find(x => x.id === id));
    if (out) { await saveFormat(out, { use: state.formatId === id }); message('Format saved.'); }
    openSettings('formats');
  },
  'open-review': async id => { $('#settings').close(); await loadProject(id); tab = 'invoice'; render(); },
  'settings-export-format': async id => { const f = formats.find(x => x.id === id); download(new Blob([exportFormat(f)], { type: 'application/json' }), `${f.name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.wrapformat.json`); },
  'settings-delete-format': async id => {
    const f = formats.find(x => x.id === id), used = projects.filter(p => p.formatId === id).length;
    if (!confirm(`Delete the format "${f.name}"?${used ? `\n\n${plural(used, 'invoice')} use it and will switch to the generic format.` : ''}`)) return;
    await db.remove('formats', id); formats = formats.filter(x => x.id !== id);
    for (const p of projects) if (p.formatId === id) { p.formatId = 'generic'; await db.put('projects', p); }
    if (state.formatId === id) { state.formatId = 'generic'; await save(); }
    render(); openSettings(); message('Format deleted.');
  },
  'test-key': testKey,
  'backup': downloadBackup,
  'review-mark': async (id, value) => { const r = state.expenses.find(x => x.id === id); r.reviewStatus = r.reviewStatus === value ? '' : value; await save(); render(); },
  'copy-review': async () => {
    const lines = state.expenses.filter(r => r.reviewStatus === 'query').sort(byDateTime).map(r => `- ${r.date} ${r.vendor} ${money(Number(r.total) || 0, cur())}: ${r.reviewNote || 'please check'}`);
    const text = [`Hi ${state.contractor.name || ''},`, '', state.review.note || 'Thanks for your invoice. A few questions before we approve it:', '', ...lines, '', 'Please send an updated package when ready.'].join('\n');
    await navigator.clipboard.writeText(text); message('Feedback copied.');
  }
};

// ---- Dialogs ---------------------------------------------------------------------------------------
function openProfile() {
  const c = { ...state.contractor };
  const f = (label, key, type = 'text', extra = '') => `<label>${label}<input name="${key}" type="${type}" value="${e(c[key] || '')}" ${extra}></label>`;
  $('#profile-form').innerHTML = `
    <div class="section-head"><div><h2>Profile</h2><p>Your details on freelance and arki pictures crew invoices. Client spreadsheets (like Eyeline) keep the name and bank block from their own sheet.</p></div><button type="button" class="dialog-close" data-close="profile-dialog" aria-label="Close">×</button></div>
    ${formats.some(x => x.kind === 'sheet') ? `<div class="settings-row"><span class="grow status-text">Copy your details from a client spreadsheet you already use:</span>${formats.filter(x => x.kind === 'sheet').map(x => `<button type="button" data-fill-profile="${x.id}">${e(x.name.replace(/\s*\(.*\)$/, ''))}</button>`).join('')}</div>` : ''}
    <div class="form-grid">
      ${f('Name or company', 'name')}${f('Role / position', 'role', 'text', 'placeholder="e.g. Data wrangler"')}
      ${f('Email', 'email', 'email')}${f('Phone', 'phone', 'tel')}
      ${f('Business registration no. (if registered)', 'taxId')}
      <label class="full">Address<textarea name="address">${e(c.address || '')}</textarea></label>
      ${f('Bank', 'bankName')}${f('Account number', 'accountNumber')}${f('Account holder', 'accountHolder')}
      <label class="full">Payment instructions<textarea name="paymentTerms">${e(c.paymentTerms || '')}</textarea></label>
    </div>
    <div class="button-row"><label class="file-button">${c.logo ? 'Change logo' : 'Add logo'}<input id="logo-input" type="file" accept="image/*"></label>${c.logo ? '<button type="button" id="remove-logo">Remove logo</button>' : ''}</div>
    <p class="hint">Logo shows on built-in layouts only.</p>
    <div class="dialog-actions"><button type="button" data-close="profile-dialog">Cancel</button><button class="primary" type="submit">Save</button></div>`;
  $('#profile-dialog').showModal();
}

/** Read the contractor's own block (NAME …) and the payment block from a client spreadsheet. */
function profileFromSheet(format) {
  const book = openBook(loadTemplate(format.sheet.base64), format.sheet.mapping.sheet);
  const cells = [...book.cells.values()], text = c => String(c?.value ?? '').trim();
  const at = (col, row) => text(book.cells.get(`${col}${row}`));
  const out = {};
  const nameLabel = cells.find(c => /^name:?$/i.test(text(c)) && splitRef(c.ref).row < format.sheet.mapping.headerRow);
  if (nameLabel) {
    const { col, row } = splitRef(nameLabel.ref), lines = [];
    for (let r = row + 1; r < row + 10 && at(col, r); r++) lines.push(at(col, r));
    const email = lines.find(l => /@/.test(l)), phone = lines.find(l => /^\+?[\d\s()-]{8,}$/.test(l));
    const rest = lines.filter(l => l !== email && l !== phone);
    if (rest[0]) { const inner = rest[0].match(/\(([^/()]+)/); out.name = (inner ? inner[1] : rest[0]).trim(); }
    if (rest.length > 1) out.address = rest.slice(1).join(', ');
    if (email) out.email = email; if (phone) out.phone = phone;
  }
  const valueRight = re => { const c = cells.find(x => re.test(text(x))); if (!c) return ''; const { col, row } = splitRef(c.ref); return at(String.fromCharCode(col.charCodeAt(0) + 1), row); };
  const holder = valueRight(/^account\s*name/i), bank = valueRight(/^bank\s*name/i), acct = valueRight(/^account\s*(no|number)/i);
  if (holder) out.accountHolder = holder; if (bank) out.bankName = bank; if (acct) out.accountNumber = acct;
  return out;
}

function patternFromExample(example) {
  const m = String(example || '').match(/^(.*?)(\d+)(\D*)$/);
  return m ? { pattern: `${m[1]}{num}${m[3]}`, digits: m[2].length, sequence: Number(m[2]) } : { pattern: '', digits: 3, sequence: 1 };
}

async function formatFromSpreadsheet(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const book = openBook(bytes), mapping = analyzeBook(book), g = mapping.guess;
  const num = patternFromExample(g.invoiceNumber);
  const fileBase = file.name.replace(/\.xlsx$/i, '');
  const fileNum = patternFromExample(fileBase);
  const memos = [...new Set([...book.cells.values()].filter(c => { const r = splitRef(c.ref); return r.col === mapping.cols.memo && r.row > mapping.firstRow && r.row <= mapping.lastRow; }).map(c => String(c.value).trim()).filter(Boolean))];
  const looksMonthly = /\d{8}\s*-\s*\d{8}/.test(String(book.cells.get(`${mapping.cols.date}${mapping.firstRow}`)?.value || ''));
  return {
    id: `fmt-${uid()}`, kind: 'sheet', updatedAt: Date.now(),
    name: g.clientName ? `${g.clientName}${g.po ? ` (${g.po})` : ''}` : fileBase,
    description: '',
    categories: memos.length >= 2 ? [...new Set([...memos, 'Parking', 'Supplies', 'Other'])] : ['Gas', 'Meal', 'Toll', 'Parking', 'Supplies', 'Other'],
    defaults: {
      clientName: g.clientName, periodMode: looksMonthly ? 'month' : 'range', currency: mapping.fixed.currency || 'KRW',
      termsPreset: /15/.test(g.terms) ? 'net_15' : /30/.test(g.terms) ? 'net_30' : /60/.test(g.terms) ? 'net_60' : 'due_receipt',
      taxType: 'vat', taxRate: g.taxRate || 10, vatOnExpenses: g.vatOnExpenses, sequence: num.sequence + 1,
      labor: g.laborMemo ? [{ type: 'Monthly fee', description: g.laborMemo, date: '', quantity: 1, rate: g.laborRate, unit: looksMonthly ? 'month' : 'day', taxable: true }] : []
    },
    numbering: { pattern: num.pattern, digits: num.digits },
    files: { receipt: '{yyyymmdd}_{category}', folder: '{yymmdd}_{name}', xlsx: fileNum.pattern || '{invoiceNumber}', pdf: '{invoiceNumber}_Invoice', log: '{yyyymm}_expense_log' },
    memo: 'category', returnLabel: 'return', timeZone: 'Asia/Seoul', roundTax: true, strict: false,
    taxInvoice: { enabled: true, items: [`${g.laborMemo ? g.laborMemo.split(' - ')[0] : 'Service'} ({yyyy}.{mm})${g.po ? ` ${g.po}` : ''}`, `Reimbursed Expenses ({yyyy}.{mm})${g.po ? ` ${g.po}` : ''}`], note: '' },
    sheet: { fileName: file.name, base64: bytesToBase64(bytes), mapping }
  };
}

function openFormatEditor(format, { isNew = false } = {}) {
  return new Promise(resolve => {
    const m = format.sheet.mapping, dlg = $('#format-dialog'), form = $('#format-form');
    const inp = (label, name, value, extra = '') => `<label>${label}<input name="${name}" value="${e(value ?? '')}" ${extra}></label>`;
    form.innerHTML = `
      <div class="section-head"><div><h2>${isNew ? 'New client format' : 'Edit format'}</h2><p>Detected from ${e(format.sheet.fileName)}. Check each value, then save.</p></div><button type="button" class="dialog-close" data-close="format-dialog" aria-label="Close">×</button></div>
      <h3 class="sub">Spreadsheet</h3>
      <div class="form-grid three">
        ${inp('Format name', 'name', format.name, 'required class="full"')}
        ${inp('Line table header row', 'headerRow', m.headerRow, 'type="number" min="1"')}
        ${inp('First line row', 'firstRow', m.firstRow, 'type="number" min="1"')}
        ${inp('Last line row (template)', 'lastRow', m.lastRow, 'type="number" min="1"')}
        ${inp('Invoice date cell', 'f_invoiceDate', m.fields.invoiceDate)}
        ${inp('Invoice number cell', 'f_invoiceNumber', m.fields.invoiceNumber)}
        ${inp('Location cell', 'f_location', m.fields.location)}
        ${inp('Due date cell (optional)', 'f_dueDate', m.fields.dueDate)}
        ${inp('Project code (every line)', 'fx_project', m.fixed.project)}
        ${inp('Cost centre (every line)', 'fx_costCentre', m.fixed.costCentre)}
      </div>
      <p class="hint">Columns: ${Object.entries(m.cols).map(([k, v]) => `${k} ${v}`).join(' · ')}. Totals: ${Object.entries(m.totals).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none found'}${m.table ? ` · table ${m.table}` : ''}.</p>
      <h3 class="sub">Rules</h3>
      <div class="form-grid three">
        ${inp('Invoice number pattern', 'numbering', format.numbering.pattern, 'placeholder="e.g. arki_NHL_#{num}"')}
        ${inp('Number digits', 'digits', format.numbering.digits, 'type="number" min="1" max="6"')}
        <label>Billing period<select name="periodMode"><option value="month" ${format.defaults.periodMode === 'month' ? 'selected' : ''}>Calendar month</option><option value="range" ${format.defaults.periodMode === 'range' ? 'selected' : ''}>Dates</option></select></label>
        <label class="full">Expense categories (comma separated)<input name="categories" value="${e(format.categories.join(', '))}"></label>
        <label>Line description<select name="memo">${[['category', 'Category only'], ['category-vendor', 'Category — vendor'], ['vendor', 'Vendor only']].map(([v, t]) => `<option value="${v}" ${format.memo === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        ${inp('VAT rate (%)', 'taxRate', format.defaults.taxRate, 'type="number" min="0" max="100" step="0.1"')}
        <label class="check-pill"><input type="checkbox" name="vatOnExpenses" ${format.defaults.vatOnExpenses ? 'checked' : ''}><span>VAT on expenses</span></label>
        <label class="check-pill"><input type="checkbox" name="roundTax" ${format.roundTax !== false ? 'checked' : ''}><span>Round VAT to whole won</span></label>
        ${inp('Return-trip label', 'returnLabel', format.returnLabel, 'placeholder="e.g. 복귀"')}
      </div>
      <h3 class="sub">File names</h3>
      <div class="form-grid three">
        ${inp('Receipts', 'f_receipt', format.files.receipt)}
        ${inp('Receipts folder', 'f_folder', format.files.folder)}
        ${inp('Spreadsheet', 'f_xlsx', format.files.xlsx)}
        ${inp('PDF', 'f_pdf', format.files.pdf)}
        ${inp('Expense log', 'f_log', format.files.log)}
      </div>
      <p class="hint">Tokens: {num} {invoiceNumber} {yyyymm} {yyyy} {mm} {yymmdd} (today) {name} {category} {yyyymmdd} (receipt date).</p>
      <h3 class="sub">Tax invoice (Hometax)</h3>
      <div class="form-grid">
        ${inp('Item text — fees', 'ti_0', format.taxInvoice?.items?.[0])}
        ${inp('Item text — expenses', 'ti_1', format.taxInvoice?.items?.[1])}
        <label class="full">Notes shown with the values (recipients, remarks…)<textarea name="ti_note">${e(format.taxInvoice?.note || '')}</textarea></label>
      </div>
      <div class="dialog-actions">
        ${isNew ? '' : '<button type="button" class="link-danger" data-format-delete>Delete format</button>'}
        <label class="file-button">Replace spreadsheet<input type="file" data-format-replace accept=".xlsx"></label>
        <button type="button" data-close="format-dialog">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>`;
    let replaced = null;
    form.querySelector('[data-format-replace]').onchange = async ev => {
      try { replaced = await formatFromSpreadsheet(ev.target.files[0]); message('Spreadsheet replaced. Check the cells, then save.'); }
      catch (err) { fail(err); }
    };
    const delBtn = form.querySelector('[data-format-delete]');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm(`Delete the format "${format.name}"? Invoices using it switch to the generic format.`)) return;
      await db.remove('formats', format.id); formats = formats.filter(x => x.id !== format.id);
      for (const p of projects) if (p.formatId === format.id) { p.formatId = 'generic'; await db.put('projects', p); }
      if (state.formatId === format.id) state.formatId = 'generic';
      dlg.close(); resolve(null); render();
    };
    form.onsubmit = ev => {
      ev.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      const out = structuredClone(format);
      if (replaced) { out.sheet = replaced.sheet; }
      const mm = out.sheet.mapping;
      Object.assign(mm, { headerRow: Number(d.headerRow), firstRow: Number(d.firstRow), lastRow: Number(d.lastRow) });
      mm.laborStyleRow = mm.firstRow; mm.expenseStyleRow = mm.lastRow > mm.firstRow ? mm.firstRow + 1 : mm.firstRow;
      for (const k of ['invoiceDate', 'invoiceNumber', 'location', 'dueDate']) mm.fields[k] = (d[`f_${k}`] || '').trim().toUpperCase() || undefined;
      mm.fixed.project = d.fx_project; mm.fixed.costCentre = d.fx_costCentre;
      out.name = d.name.trim() || out.name;
      out.numbering = { pattern: d.numbering.trim(), digits: Number(d.digits) || 3 };
      out.defaults = { ...out.defaults, periodMode: d.periodMode, taxRate: Number(d.taxRate), vatOnExpenses: Boolean(d.vatOnExpenses) };
      out.roundTax = Boolean(d.roundTax);
      out.categories = d.categories.split(',').map(s => s.trim()).filter(Boolean);
      out.memo = d.memo; out.returnLabel = d.returnLabel.trim() || 'return';
      out.files = { ...out.files, receipt: d.f_receipt, folder: d.f_folder, xlsx: d.f_xlsx, pdf: d.f_pdf, log: d.f_log };
      out.taxInvoice = { enabled: true, items: [d.ti_0, d.ti_1], note: d.ti_note };
      out.updatedAt = Date.now();
      dlg.close(); resolve(out);
    };
    dlg.onclose = () => resolve(null);
    dlg.showModal();
  });
}

async function saveFormat(format, { use = true } = {}) {
  await db.put('formats', format);
  const i = formats.findIndex(x => x.id === format.id);
  if (i < 0) formats.push(format); else formats[i] = format;
  previewCache.key = '';
  if (use) {
    applyFormat(format, { full: state.formatId !== format.id });
    await save();
  }
  render();
}

// ---- Settings ----------------------------------------------------------------------------------------
const TIME_ZONES = [['Asia/Seoul', 'Korea (Seoul)'], ['Asia/Shanghai', 'China (Shanghai)'], ['Asia/Tokyo', 'Japan (Tokyo)'], ['America/Los_Angeles', 'US Pacific'], ['America/New_York', 'US Eastern'], ['Europe/London', 'UK (London)']];
let settingsTab = 'general';
const help = text => `<button type="button" class="help-btn" aria-label="What is this?" aria-expanded="false">?</button><span class="help-text" hidden>${text}</span>`;
const ago = iso => { if (!iso) return 'never'; const d = Math.floor((Date.now() - new Date(iso)) / 86400000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };

function settingsGeneral() {
  const tz = setting('timeZone') || 'Asia/Seoul', key = setting('apiKey');
  return `
    <section class="settings-section">
      <h3>Receipt reading ${help('A free Gemini key from aistudio.google.com lets the site read dates, amounts, cards and Hi-pass trips from your files. Each file is sent to Google only when it is read. Without a key you can still upload receipts and type the details.')}</h3>
      <form id="key-form" class="settings-row">
        <input id="api-key" class="grow" type="password" autocomplete="off" value="${e(key)}" placeholder="Gemini API key" aria-label="Gemini API key">
        <button type="button" data-action="test-key">Test</button>
        <button class="primary" type="submit">Save</button>
      </form>
    </section>
    <section class="settings-section">
      <h3>Time zone ${help('Receipt times are compared with your shoot calendar in this time zone. Choose where you shoot, not where you are.')}</h3>
      <div class="settings-row">
        <select id="tz-select" class="grow" aria-label="Time zone">${TIME_ZONES.map(([v, t]) => `<option value="${v}" ${tz === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
    </section>`;
}
function settingsFormats() {
  const list = formats.filter(f => f.kind === 'sheet');
  return `
    <section class="settings-section">
      <h3>Client formats ${help('A client format is a company\'s own invoice layout, made from one of their past invoice spreadsheets. Add one from the Details tab. Export saves it as a file to use on another device.')}</h3>
      ${list.length ? `<ul class="settings-list">${list.map(f => `<li><span>${e(f.name)}</span>
        <button data-action="settings-edit-format" data-id="${f.id}">Edit</button>
        <button data-action="settings-export-format" data-id="${f.id}">Export</button>
        <button class="danger-quiet" data-action="settings-delete-format" data-id="${f.id}">Delete</button></li>`).join('')}</ul>` : '<p class="status-text">No client formats yet.</p>'}
    </section>`;
}
function settingsBackup() {
  const last = setting('lastBackup'), stale = !last || Date.now() - new Date(last) > 14 * 86400000;
  return `
    <section class="settings-section">
      <h3>Backup ${help('Invoices, receipts and formats live only in this browser. Clearing browser data deletes them. A backup is one .zip file with everything; Restore brings it back on this or another device.')}</h3>
      <div class="settings-row">
        <span class="grow status-text ${stale ? 'warn-text' : ''}">Last backup: ${ago(last)} · ${plural(projects.length, 'invoice')}</span>
        <label class="file-button">Restore<input id="backup-input" type="file" accept=".zip"></label>
        <button data-action="backup">Download backup</button>
      </div>
    </section>`;
}
function settingsStudio() {
  const reviews = projects.filter(p => p.review).sort((a, b) => (b.review.importedAt || '').localeCompare(a.review.importedAt || ''));
  return `
    <section class="settings-section">
      <h3>Crew submissions ${help('Crew hired by arki pictures use this site with the "arki pictures — crew invoice" format and send you a submission package (.zip). Open it here to recalculate their totals, look at every receipt, and mark each line OK or Query.')}</h3>
      <label class="drop-target">Open a submission package (.zip)<input id="review-input" type="file" accept=".zip,application/zip"></label>
      ${reviews.length ? `<ul class="settings-list">${reviews.map(p => {
        const q = p.expenses.filter(r => r.reviewStatus === 'query').length;
        return `<li><span>${e(p.contractor.name || 'Crew')} · ${e(p.project.projectTitle || '')}<small>${e(money(totals(p).total, p.project.currency))}${q ? ` · ${q} ${q === 1 ? 'query' : 'queries'}` : ''}</small></span>
          <button data-action="open-review" data-id="${p.id}">Open</button></li>`;
      }).join('')}</ul>` : '<p class="status-text">No submissions opened yet.</p>'}
    </section>`;
}
function openSettings(tabName) {
  if (tabName) settingsTab = tabName;
  const tabs = [['general', 'General'], ['formats', 'Client formats'], ['backup', 'Backup'], ['studio', 'arki studio']];
  $('#settings-body').innerHTML = `
    <div class="section-head"><div><h2>Settings</h2></div><button type="button" class="dialog-close" data-close="settings" aria-label="Close">×</button></div>
    <nav class="settings-tabs">${tabs.map(([k, t]) => `<button class="${settingsTab === k ? 'active' : ''}" data-settings-tab="${k}">${t}</button>`).join('')}</nav>
    ${{ general: settingsGeneral, formats: settingsFormats, backup: settingsBackup, studio: settingsStudio }[settingsTab]()}`;
  const keyForm = $('#key-form');
  if (keyForm) keyForm.onsubmit = ev => { ev.preventDefault(); setSetting('apiKey', $('#api-key').value.replace(/\s+/g, '')); message($('#api-key').value ? 'Key saved.' : 'Key removed.'); render(); };
  const tzSel = $('#tz-select');
  if (tzSel) tzSel.onchange = ev => { setSetting('timeZone', ev.target.value); message('Time zone saved. Import the calendar again to apply it.'); };
  if (!$('#settings').open) $('#settings').showModal();
}

const toB64 = buf => bytesToBase64(new Uint8Array(buf));
async function downloadBackup() {
  const receipts = await db.all('receipts');
  const data = {
    wrapsheetBackup: 1, createdAt: new Date().toISOString(),
    projects: await db.all('projects'), formats, events,
    receipts: receipts.map(r => ({ ...r, original: r.original ? toB64(r.original) : undefined })),
    settings: { profile: setting('profile'), profileLogo: setting('profileLogo'), timeZone: setting('timeZone') }
  };
  download(zip([{ path: 'wrapsheet-backup.json', bytes: strToU8(JSON.stringify(data)) }]), `wrapsheet-backup-${today()}.zip`, 'application/zip');
  setSetting('lastBackup', new Date().toISOString());
  if ($('#settings').open) openSettings();
}
async function restoreBackup(file) {
  const { unzipSync, strFromU8 } = await import('./vendor/fflate.js');
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const raw = entries['wrapsheet-backup.json'];
  if (!raw) throw new Error('This is not a WrapSheet backup.');
  const data = JSON.parse(strFromU8(raw));
  if (!confirm(`Restore ${plural(data.projects.length, 'invoice')} from ${data.createdAt.slice(0, 10)}? Invoices with the same ID are replaced; others are kept.`)) return;
  await db.putMany('projects', data.projects);
  if (data.formats?.length) await db.putMany('formats', data.formats);
  if (data.events?.length) { await db.clear('schedule'); await db.putMany('schedule', data.events); }
  for (const r of data.receipts || []) await db.put('receipts', { ...r, original: r.original ? loadTemplate(r.original).buffer : undefined });
  for (const k of ['profile', 'profileLogo', 'timeZone']) if (data.settings?.[k]) setSetting(k, data.settings[k]);
  projects = (await db.all('projects')).map(upgradeProject); formats = await db.all('formats'); events = await db.all('schedule');
  await loadProject(data.projects[0]?.id || state.id);
  $('#settings').close(); message('Backup restored.');
}
async function testKey() {
  const key = $('#api-key').value.replace(/\s+/g, '');
  if (!key) throw new Error('Paste a key first.');
  message('Testing the key…', true);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
  if (res.ok) message('The key works.'); else throw new Error(res.status === 400 || res.status === 403 ? 'Google rejected this key. Copy it again from aistudio.google.com.' : `Could not reach Google (${res.status}).`);
}

// ---- Inspector ---------------------------------------------------------------------------------------
const inspectable = () => sortedExpenses().filter(x => x.r.source !== 'hipass' && (filter === 'all' || x.r.status === filter));
function openInspector(id) {
  const list = inspectable(), idx = list.findIndex(x => x.r.id === id);
  if (idx < 0) return;
  inspectingId = id;
  const { r, i } = list[idx], rec = r.receiptId ? images.get(r.receiptId) : null;
  $('#inspect-counter').textContent = `${idx + 1} of ${list.length}`;
  $('#inspect-prev-btn').disabled = idx === 0; $('#inspect-next-btn').disabled = idx === list.length - 1;
  $('#inspect-img-target').src = rec?.imageFull || '';
  const dis = r.status === 'verified' || r.status === 'excluded' ? 'disabled' : '';
  $('#inspect-form-target').innerHTML = `
    <span class="badge status-${r.status}">${STATUS[r.status]}</span>
    <div class="form-grid" style="grid-template-columns:1fr 1fr; gap:12px; margin-top:12px">
      ${field('Date', `expenses.${i}.date`, 'date', dis)}${field('Time', `expenses.${i}.time`, 'time', dis)}
      ${field('Vendor', `expenses.${i}.vendor`, 'text', dis)}${field(`Amount (${cur()})`, `expenses.${i}.total`, 'number', `step="any" ${dis}`)}
      <label>Category<input data-field="expenses.${i}.category" list="category-list" value="${e(r.category)}" ${dis}></label>
      <label>Paid by<input data-field="expenses.${i}.paidBy" list="card-list" value="${e(r.paidBy)}" ${dis}></label>
      <label class="full">Shoot day<input data-field="expenses.${i}.shootDay" list="sd-${r.id}" value="${e(r.shootDay)}" ${dis}></label>
      <label class="full">Notes<input data-field="expenses.${i}.notes" value="${e(r.notes)}" ${dis}></label>
    </div>
    <div class="actions">${statusButtons(r)}</div>`;
  if (!$('#receipt-inspect-modal').open) $('#receipt-inspect-modal').showModal();
}
function stepInspector(delta) {
  const list = inspectable(), idx = list.findIndex(x => x.r.id === inspectingId);
  const next = list[idx + delta]; if (next) openInspector(next.r.id);
}

// ---- Projects ----------------------------------------------------------------------------------------
async function loadProject(id) {
  const loaded = await db.get('projects', id);
  if (!loaded) throw new Error('Invoice not found.');
  state = applyProfile(upgradeProject(loaded));
  if (state.invoice.labels.invoiceTitle === 'WRAP SHEET / INVOICE') state.invoice.labels.invoiceTitle = 'INVOICE';
  images = new Map();
  for (const rid of new Set(state.expenses.map(r => r.receiptId).filter(Boolean))) { const rec = await db.get('receipts', rid); if (rec) images.set(rid, rec); }
  setSetting('currentProjectId', id);
  filter = 'all'; previewCache.key = '';
  updatePicker(); render();
}
/** The latest invoice made with a format (by month, then by edit time). */
const latestFor = formatId => projects.filter(p => p.formatId === formatId && !p.review)
  .sort((a, b) => (b.project.month || '').localeCompare(a.project.month || '') || b.updatedAt - a.updatedAt)[0];

async function startNextMonth(source) {
  const next = upgradeProject(structuredClone(source));
  Object.assign(next, { id: uid(), expenses: [], review: null, updatedAt: Date.now() });
  const prevMonth = next.project.month;
  const highest = Math.max(...projects.filter(p => p.formatId === source.formatId).map(p => Number(p.project.sequence) || 0), Number(source.project.sequence) || 0);
  next.project.sequence = highest + 1;
  next.project.location = '';
  next.project.projectTitle = (next.project.projectTitle || '').replace(prevMonth, shiftMonth(prevMonth, 1));
  state = applyProfile(next); images = new Map();
  setMonth(shiftMonth(prevMonth, 1));
  if (!fmt().numbering?.pattern) next.project.invoiceNumber = '';
  await save(); setSetting('currentProjectId', state.id); tab = 'details'; location.hash = 'details'; render();
  message(`Started ${state.project.invoiceNumber || 'the next invoice'} for ${state.project.month}.`);
}

function openNewInvoice() {
  const monthName = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const options = [];
  for (const f of formats.filter(x => x.kind === 'sheet')) {
    const last = latestFor(f.id);
    if (last && last.project.periodMode === 'month') {
      const seq = Math.max(...projects.filter(p => p.formatId === f.id).map(p => Number(p.project.sequence) || 0)) + 1;
      const num = f.numbering?.pattern ? fillPattern(f.numbering.pattern, { ...last, project: { ...last.project, sequence: seq } }, f) : '';
      options.push({ kind: 'next', id: last.id, title: `${f.name} — next month`, sub: `${num ? num + ' · ' : ''}${monthName(shiftMonth(last.project.month, 1))} · same fee, empty receipts` });
    } else options.push({ kind: 'format', id: f.id, title: f.name, sub: last ? 'New invoice in this format' : 'First invoice in this format' });
  }
  options.push({ kind: 'format', id: 'generic', title: 'Freelance invoice (generic)', sub: 'Your own layout, any client' });
  options.push({ kind: 'format', id: 'arki-crew', title: 'arki pictures — crew invoice', sub: 'For crew hired by arki pictures' });
  $('#new-body').innerHTML = `
    <div class="section-head"><div><h2>New invoice</h2></div><button type="button" class="dialog-close" data-close="new-dialog" aria-label="Close">×</button></div>
    <div class="choice-list">${options.map(o => `<button class="choice" data-new-kind="${o.kind}" data-new-id="${o.id}"><strong>${e(o.title)}</strong><span>${e(o.sub)}</span></button>`).join('')}</div>`;
  $('#new-dialog').showModal();
}

async function createProject(format) {
  state = applyProfile(newProject());
  images = new Map();
  applyFormat(format, { full: true });
  // Never repeat a number already used in this format.
  const used = projects.filter(p => p.formatId === format.id).map(p => Number(p.project.sequence) || 0);
  if (used.length) { state.project.sequence = Math.max(...used, Number(state.project.sequence) - 1) + 1; invoiceNumberFromPattern(); }
  await save(); setSetting('currentProjectId', state.id);
  tab = 'details'; location.hash = 'details'; render();
}

async function importReview(file) {
  const { manifest, files } = readSubmission(await file.arrayBuffer());
  const s = upgradeProject(manifest.state);
  s.id = uid(); s.formatId = manifest.formatId || 'arki-crew';
  s.review = { importedAt: new Date().toISOString(), fileName: file.name, claimed: manifest.claimed, note: '' };
  for (const r of s.expenses) { r.reviewStatus = ''; r.reviewNote = ''; }
  await db.put('projects', s); projects.push(s);
  for (const [rid, name] of Object.entries(manifest.files || {})) {
    const bytes = files.get(name);
    if (!bytes) continue;
    const rec = await readReceiptFile(new File([bytes], name, { type: 'application/pdf' }));
    rec.id = rid; rec.projectId = s.id;
    await db.put('receipts', rec);
  }
  const missing = s.expenses.filter(r => r.receiptId && !files.get(manifest.files?.[r.receiptId])).length;
  await loadProject(s.id);
  tab = 'invoice'; render();
  message(`Submission from ${s.contractor.name || 'crew'} imported${missing ? ` · ${missing} receipt file(s) missing` : ''}.`);
}

// ---- Events --------------------------------------------------------------------------------------------
function initDropzone() {
  const zone = $('#receipt-dropzone');
  if (!zone) return;
  ['dragenter', 'dragover'].forEach(n => zone.addEventListener(n, ev => { ev.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(n => zone.addEventListener(n, ev => { ev.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', ev => handleUpload(ev.dataTransfer.files).catch(fail));
}
const swipe = $('#inspect-swipe-area');
swipe.addEventListener('touchstart', ev => { touchStartX = ev.changedTouches[0].screenX; touchStartY = ev.changedTouches[0].screenY; }, { passive: true });
swipe.addEventListener('touchend', ev => {
  const dx = ev.changedTouches[0].screenX - touchStartX, dy = ev.changedTouches[0].screenY - touchStartY;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) stepInspector(dx < 0 ? 1 : -1);
}, { passive: true });
window.addEventListener('keydown', ev => {
  if (!$('#receipt-inspect-modal').open || ev.target.matches('input, textarea, select')) return;
  if (ev.key === 'ArrowLeft') stepInspector(-1); if (ev.key === 'ArrowRight') stepInspector(1);
});

document.addEventListener('click', async ev => {
  const t = ev.target;
  const helpBtn = t.closest('.help-btn');
  if (helpBtn) {
    const txt = helpBtn.nextElementSibling, open = txt.hidden;
    document.querySelectorAll('.help-text').forEach(x => { x.hidden = true; x.previousElementSibling?.setAttribute('aria-expanded', 'false'); });
    txt.hidden = !open; helpBtn.setAttribute('aria-expanded', String(open)); return;
  }
  if (!t.closest('.help-text')) document.querySelectorAll('.help-text:not([hidden])').forEach(x => { x.hidden = true; x.previousElementSibling?.setAttribute('aria-expanded', 'false'); });
  const choice = t.closest('[data-new-kind]');
  if (choice) {
    $('#new-dialog').close();
    try {
      await saveChain;
      if (choice.dataset.newKind === 'next') await startNextMonth(projects.find(p => p.id === choice.dataset.newId));
      else { await createProject(findFormat(formats, choice.dataset.newId)); message('New invoice started.'); }
    } catch (error) { fail(error); }
    return;
  }
  const stab = t.closest('[data-settings-tab]');
  if (stab) { openSettings(stab.dataset.settingsTab); return; }
  const closeBtn = t.closest('[data-close]');
  if (closeBtn) { $(`#${closeBtn.dataset.close}`).close(); return; }
  const inspect = t.closest('[data-inspect-id]');
  if (inspect) { openInspector(inspect.dataset.inspectId); return; }
  if (t.closest('#inspect-prev-btn')) return stepInspector(-1);
  if (t.closest('#inspect-next-btn')) return stepInspector(1);
  if (t.closest('#close-inspect-modal')) { $('#receipt-inspect-modal').close(); render(); return; }
  if (t.closest('#close-preview-modal')) { $('#preview-modal').close(); return; }
  const fill = t.closest('[data-fill-profile]');
  if (fill) {
    const got = profileFromSheet(formats.find(x => x.id === fill.dataset.fillProfile));
    for (const [k, v] of Object.entries(got)) { const input = $(`#profile-form [name=${k}]`); if (input && v) input.value = v; }
    message(Object.keys(got).length ? 'Details copied. Check them, then Save.' : 'No details found in that spreadsheet.');
    return;
  }
  if (t.id === 'remove-logo') { state.contractor.logo = ''; setSetting('profileLogo', ''); await save(); openProfile(); return; }
  const b = t.closest('button, a[data-action]');
  if (!b) return;
  try {
    if (b.dataset.setColor) { state.invoice.accent = b.dataset.setColor; await save(); render(); return; }
    if (b.id === 'primary-action-btn') {
      const next = { details: 'work', work: 'receipts', receipts: 'invoice' }[tab];
      if (next) return go(next);
      const f = fmt();
      return actions[f.crew && !state.review ? 'download-package' : 'download-all']();
    }
    if (b.dataset.tab) return go(b.dataset.tab);
    if (b.dataset.action && actions[b.dataset.action]) {
      if (busy && !['filter', 'copy-text'].includes(b.dataset.action)) return;
      b.disabled = true;
      try { await actions[b.dataset.action](b.dataset.id, b.dataset.value, b); } finally { if (b.isConnected) b.disabled = false; }
    }
  } catch (error) { fail(error); }
});

document.addEventListener('input', ev => {
  const el = ev.target;
  if (el.dataset.reviewNote) { const r = state.expenses.find(x => x.id === el.dataset.reviewNote); r.reviewNote = el.value; save(); return; }
  if (!el.dataset.field || el.type === 'checkbox' || el.tagName === 'SELECT' || ['date', 'time', 'month'].includes(el.type)) return;
  try {
    if (el.dataset.field === 'formatId') return;
    updateField(el.dataset.field, el.value, el);
    if (tab === 'invoice') preview();
  } catch (error) { fail(error); }
});

document.addEventListener('change', async ev => {
  const el = ev.target;
  try {
    if (el.dataset.actionChange) { await actions[el.dataset.actionChange](el.dataset.id, el.value); return; }
    if (el.dataset.field === 'formatId') {
      const f = findFormat(formats, el.value);
      applyFormat(f, { full: true });
      await save(); render(); return;
    }
    if (el.dataset.field) {
      updateField(el.dataset.field, el.type === 'checkbox' ? el.checked : el.value, el);
      if (RERENDER.test(el.dataset.field) && !$('#receipt-inspect-modal').open) render();
      else if (tab === 'invoice') preview();
      return;
    }
    const files = [...(el.files || [])];
    if (!files.length) return;
    if (el.id === 'receipt-input' || el.id === 'camera-input') await handleUpload(files);
    else if (el.id === 'ics-input') {
      const list = await readCalendarFile(files[0], { timeZone: setting('timeZone') || 'Asia/Seoul' });
      if (!list.length) throw new Error('No events found in that file.');
      await db.clear('schedule'); await db.putMany('schedule', list); events = list;
      for (const r of state.expenses) if (!r.shootDay && r.status === 'pending') r.shootDay = autoShootDay(r);
      await save(); render(); if ($('#settings').open) openSettings(); message(`${plural(list.length, 'calendar event')} imported.`);
    }
    else if (el.id === 'format-input' && /\.json$/i.test(files[0].name)) {
      const f = importFormat(await files[0].text());
      await saveFormat(f); message(`Format "${f.name}" added and in use.`);
    }
    else if (el.id === 'format-input') {
      message('Reading the spreadsheet…', true);
      const draft = await formatFromSpreadsheet(files[0]);
      message('');
      const saved = await openFormatEditor(draft, { isNew: true });
      if (saved) { await saveFormat(saved); message(`Format "${saved.name}" saved and in use.`); }
    }
    else if (el.id === 'backup-input') await restoreBackup(files[0]);
    else if (el.id === 'review-input') { $('#settings').close(); await importReview(files[0]); }
    else if (el.id === 'logo-input') { const logo = await compressImage(files[0], 500, 0.9); state.contractor.logo = logo; setSetting('profileLogo', logo); await save(); openProfile(); }
    el.value = '';
  } catch (error) { el.value = ''; fail(error); }
});

$('#profile-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const d = Object.fromEntries(new FormData(ev.target));
  Object.assign(state.contractor, d);
  saveProfile(state.contractor);
  $('#profile-dialog').close(); await save(); render(); message('Profile saved.');
});
$('#project-picker').addEventListener('change', async ev => { try { await saveChain; await loadProject(ev.target.value); } catch (error) { fail(error); } });
$('#new-project').addEventListener('click', openNewInvoice);
$('#settings-button').addEventListener('click', () => openSettings());
$('#profile-button').addEventListener('click', openProfile);
$('#delete-project').addEventListener('click', () => actions['delete-project']().catch(fail));
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (TABS.includes(next) && !busy && next !== tab) { tab = next; render(); } });

async function boot() {
  try {
    await db.openDB();
    projects = (await db.all('projects')).map(upgradeProject);
    formats = await db.all('formats');
    events = await db.all('schedule');
    const current = setting('currentProjectId');
    const existing = projects.find(p => p.id === current) || [...projects].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'details';
    if (existing) await loadProject(existing.id); else await createProject(BUILTIN_FORMATS[0]);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
  } catch (error) { fail(error); }
}
boot();
