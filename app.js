import * as db from './db.js';
import { newProject, uid, today, money, totals, round, validNumber, validDate, validateReceipt } from './model.js';
import { renderInvoice, presets, sanitizeTemplate, checkTemplate, escapeHTML as e } from './invoice.js';
import { compressImage, parseReceiptImage } from './receipt.js';

const $ = s => document.querySelector(s);
let state, projects = [], templates = [], images = new Map(), tab = 'project', saveChain = Promise.resolve(), revision = 0, scanBusy = false, renderBusy = false;

// 5 Curated Cinema Palettes
const SWATCHES = [
  { name: 'Arki Slate', color: '#a8c3d0' },
  { name: 'Kodak Amber', color: '#d4a373' },
  { name: 'Studio Olive', color: '#9aa899' },
  { name: 'Monochrome', color: '#c8c8c4' },
  { name: 'Muted Clay', color: '#b5838d' }
];

function message(text) {
  const el = $('#message');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function fail(error) { message(error.message || String(error)); }

function setting(key) {
  try { return localStorage.getItem(`wrapsheet.${key}`) || ''; } catch { return ''; }
}

function setSetting(key, value) {
  try {
    if (value) localStorage.setItem(`wrapsheet.${key}`, value);
    else localStorage.removeItem(`wrapsheet.${key}`);
  } catch {
    message('Browser settings could not be saved.');
  }
}

function setPath(path, value) {
  const parts = path.split('.');
  let obj = state;
  for (const p of parts.slice(0, -1)) obj = obj[p];
  obj[parts.at(-1)] = value;
}

function getPath(path) {
  return path.split('.').reduce((o, k) => o[k], state);
}

function setSaveStatus(text, color = 'var(--muted)') {
  const el = $('#save-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
}

function save() {
  const snapshot = structuredClone(state), rev = ++revision;
  snapshot.updatedAt = Date.now();
  setSaveStatus('Saving…', '#a8c3d0');

  saveChain = saveChain
    .catch(() => { })
    .then(() => db.put('projects', snapshot))
    .then(() => {
      if (rev === revision) setSaveStatus('● Autosaved', 'var(--green)');
      const i = projects.findIndex(p => p.id === snapshot.id);
      if (i < 0) projects.push(snapshot);
      else projects[i] = snapshot;
      updatePicker();
    })
    .catch(error => {
      setSaveStatus('Not saved', '#f07c74');
      message(`Could not save shoot: ${error.message}.`);
      throw error;
    });

  saveChain.catch(() => { });
  return saveChain;
}

function updatePicker() {
  const picker = $('#project-picker');
  if (!picker) return;
  picker.innerHTML = projects.map(p => `<option value="${p.id}">${e(p.project.projectTitle || 'Untitled production')}</option>`).join('');
  picker.value = state.id;
}

function updateStickyActionBar() {
  const btn = $('#primary-action-btn');
  if (!btn) return;
  if (tab === 'project') btn.textContent = 'Next: Add Work →';
  else if (tab === 'work') btn.textContent = 'Next: Add Receipts →';
  else if (tab === 'receipts') btn.textContent = 'Review Invoice →';
  else if (tab === 'invoice') btn.textContent = 'Export PDF';
}

function summary() {
  if (!state) return;
  const t = totals(state), c = state.project.currency;

  if ($('#summary-name')) $('#summary-name').textContent = state.project.projectTitle || 'Untitled production';
  if ($('#labor-total')) $('#labor-total').textContent = money(t.labor, c);
  if ($('#tax-total')) $('#tax-total').textContent = money(t.tax, c);
  if ($('#tax-percent')) $('#tax-percent').textContent = `(${state.project.taxRate}%)`;
  if ($('#expense-total')) $('#expense-total').textContent = money(t.expenses, c);
  if ($('#grand-total')) $('#grand-total').textContent = money(t.total, c);

  const pending = state.expenses.filter(r => !r.verified).length;
  if ($('#receipt-status')) {
    $('#receipt-status').textContent = pending
      ? `${pending} receipt${pending === 1 ? '' : 's'} awaiting review`
      : `Ready when you are`;
  }
  updateStickyActionBar();
}

function field(label, path, type = 'text', extra = '') {
  return `<label>${label}<input data-field="${path}" type="${type}" value="${e(getPath(path))}" ${extra}></label>`;
}
function area(label, path) {
  return `<label class="full">${label}<textarea data-field="${path}">${e(getPath(path))}</textarea></label>`;
}
function select(label, path, options) {
  return `<label>${label}<select data-field="${path}">${options.map(o => {
    const [value, title] = Array.isArray(o) ? o : [o, o];
    return `<option value="${e(value)}" ${getPath(path) === value ? 'selected' : ''}>${e(title)}</option>`;
  }).join('')}</select></label>`;
}
function panel(title, description, content, tag = '') {
  return `<div class="panel"><div class="section-head"><div><h2>${title}</h2><p>${description}</p></div>${tag ? `<span class="tag">${tag}</span>` : ''}</div>${content}</div>`;
}

function projectView() {
  return panel('Set the scene.', 'Production metadata for the final invoice.',
    `<div class="form-grid">
      ${field('Project title', 'project.projectTitle', 'text', 'placeholder="e.g. Autumn campaign — Seoul" maxlength="200"')}
      ${field('Client / production company', 'project.clientName', 'text', 'placeholder="Production studio or client name" maxlength="200"')}
      ${select('Currency', 'project.currency', [['KRW', 'KRW — Korean won'], ['USD', 'USD — US dollar'], ['EUR', 'EUR — Euro']])}
      ${field('Invoice number', 'project.invoiceNumber')}
      ${field('Shoot start', 'project.shootStart', 'date')}
      ${field('Shoot end', 'project.shootEnd', 'date')}
      ${field('Invoice date', 'project.invoiceDate', 'date')}
      ${field('Payment due', 'project.dueDate', 'date')}
      ${area('Client address', 'project.clientAddress')}
    </div>
    <div class="actions">
      <button class="primary" data-go="work">Continue to work →</button>
      <button data-action="backup">Download backup</button>
    </div>`, 'PRODUCTION DETAILS') +
    panel('The contractor behind the frame.', 'Your personal or studio contractor profile.',
      `<div class="form-grid">
      ${field('Contractor / company', 'contractor.name', 'text', 'placeholder="Your name or studio"')}
      ${field('Email', 'contractor.email', 'email')}
      ${field('Phone', 'contractor.phone', 'tel')}
      ${field('Business registration / Tax ID', 'contractor.taxId')}
      ${area('Address', 'contractor.address')}
      ${field('Bank name', 'contractor.bankName')}
      ${field('Account number', 'contractor.accountNumber')}
      ${area('Payment terms', 'contractor.paymentTerms')}
    </div>`);
}

const laborTypes = ['Shoot Day', 'Prep Day', 'Travel Day', 'Half Day', 'Overtime', 'Kit Rental', 'Equipment Rental', 'Assistant', 'Post-production', 'Other'];

function workView() {
  return panel('Every hour. Every piece of kit.', 'Build your agreed day rates and equipment fees.',
    `<div class="inline-action-row">
      <label>Add a work item
        <select id="labor-kind">${laborTypes.map(t => `<option>${t}</option>`).join('')}</select>
      </label>
      <button class="primary" data-action="add-labor">＋ Add item</button>
    </div>
    ${state.labor.length ? state.labor.map((r, i) => `
      <div class="row-card">
        <div class="row-top">
          <strong>${String(i + 1).padStart(2, '0')} / <span data-row-total="${i}">${money(round(r.rate * r.quantity, state.project.currency), state.project.currency)}</span></strong>
          <button class="remove" data-action="remove-labor" data-id="${r.id}">Remove</button>
        </div>
        <div class="form-grid">
          ${field('Description', `labor.${i}.description`)}
          ${field('Work date', `labor.${i}.date`, 'date')}
          ${select('Unit', `labor.${i}.unit`, ['day', 'hour', 'item', 'km', 'mile'])}
          ${field('Quantity', `labor.${i}.quantity`, 'number', 'min="0" max="1000000" step="0.01"')}
          ${field(`Rate (${state.project.currency})`, `labor.${i}.rate`, 'number', 'min="0" max="1000000000000" step="any"')}
        </div>
        <label class="check-pill">
          <input type="checkbox" data-field="labor.${i}.taxable" ${r.taxable ? 'checked' : ''}>
          Taxable item
        </label>
      </div>`).join('') : '<div class="empty">No work logged yet. Add your first shoot day above.</div>'}
    <div class="form-grid" style="margin-top:20px;">
      ${field('Tax on taxable work (%)', 'project.taxRate', 'number', 'min="0" max="100" step="0.01"')}
    </div>
    <div class="actions">
      <button class="primary" data-go="receipts">Continue to receipts →</button>
    </div>`, 'WORK LOG');
}

function receiptView() {
  return panel('Proof, without the paperwork.', 'Upload slips as you get them. Only verified receipts enter the invoice.',
    `<div class="upload-box">
      <svg class="box-icon" viewBox="0 0 24 24">
        <path d="M19 2H5c-1.1 0-2 .9-2 2v17l3-1.5 3 1.5 3-1.5 3 1.5 3-1.5 3 1.5V4c0-1.1-.9-2-2-2zm0 15.8l-1-.5-3 1.5-3-1.5-3 1.5-3-1.5-1 .5V4h14v13.8zM7 7h10v2H7zm0 4h10v2H7zm0 4h7v2H7z"/>
      </svg>
      <h3>Drop the admin. Keep the receipt.</h3>
      <p>Multi-language OCR with Gemini Flash</p>
      <div class="file-actions-grid">
        <label class="file-button">
          <svg class="btn-icon" viewBox="0 0 24 24"><path d="M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4z"/><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
          Scan with Camera
          <input id="camera-input" type="file" accept="image/*" capture="environment">
        </label>
        <label class="file-button">
          <svg class="btn-icon" viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
          Upload Files
          <input id="receipt-input" type="file" accept="image/*" multiple>
        </label>
        <button data-action="manual-receipt">＋ Manual Entry</button>
      </div>
    </div>
    <div class="actions" style="margin: 16px 0 8px;">
      <span class="hint">${state.expenses.length} receipts logged</span>
    </div>
    ${state.expenses.map((r, i) => `
      <div class="row-card">
        <div class="row-top">
          <span class="badge ${r.verified ? 'verified' : ''}">${r.verified ? '✓ VERIFIED' : '○ PENDING REVIEW'} · ${String(i + 1).padStart(2, '0')}</span>
          <button class="remove" data-action="remove-receipt" data-id="${r.id}">Remove</button>
        </div>
        <div class="receipt-card">
          <div>
            ${images.get(r.receiptId) ? `<a href="${e(images.get(r.receiptId).imageFull)}" target="_blank" rel="noopener"><img class="receipt-image" src="${e(images.get(r.receiptId).imageThumbnail)}" alt="Receipt"></a>` : '<div class="empty">Manual</div>'}
          </div>
          <div>
            <div class="form-grid">
              ${field('Vendor / 거래처', `expenses.${i}.vendor`)}
              ${field('Date / 날짜', `expenses.${i}.date`, 'date')}
              ${field('Total paid / 합계', `expenses.${i}.total`, 'number', 'min="0" step="any"')}
              ${field('Included VAT / 부가세', `expenses.${i}.vat`, 'number', 'min="0" step="any"')}
              ${field('Category', `expenses.${i}.category`)}
              ${select('Currency', `expenses.${i}.currency`, [['', 'Choose'], ['KRW', 'KRW'], ['USD', 'USD'], ['EUR', 'EUR']])}
            </div>
            ${r.warning ? `<p class="notice">${e(r.warning)}</p>` : ''}
            <div class="actions">
              ${!r.verified ? `<button class="primary" data-action="confirm-receipt" data-id="${r.id}">Confirm expense</button>` : ''}
              ${r.receiptId ? `<button data-action="scan" data-id="${r.id}" ${scanBusy ? 'disabled' : ''}>${scanBusy ? 'Scanning…' : 'Scan OCR'}</button>` : ''}
            </div>
          </div>
        </div>
      </div>`).join('')}
    <div class="actions">
      <button class="primary" data-go="invoice">Review invoice →</button>
    </div>`);
}

function invoiceView() {
  const currentAccent = state.invoice.accent || '#a8c3d0';

  return panel('Your name. Your invoice.', 'Review the live sheet before exporting.',
    `<div class="invoice-controls">
      ${select('Invoice layout preset', 'invoice.templateId', [...presets.map(p => [p.id, p.name]), ...templates.map(t => [t.id, `${t.name} (Custom)`])])}

      <div style="margin-top: 14px;">
        <label>Accent Palette</label>
        <div class="swatch-group">
          ${SWATCHES.map(s => `
            <button type="button" class="swatch-btn ${currentAccent.toLowerCase() === s.color ? 'active' : ''}" 
                    style="background: ${s.color}" data-set-color="${s.color}" title="${s.name}"></button>
          `).join('')}
        </div>
      </div>

      <!-- High-Contrast Asset Customization Deck -->
      <div class="deck-row">
        <label class="file-button deck-btn">
          <svg class="btn-icon" viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
          Upload Logo
          <input type="file" id="logo-input" accept="image/*">
        </label>
        ${state.contractor.logo ? '<button class="action-btn" data-action="remove-logo">Remove Logo</button>' : ''}

        <label class="file-button deck-btn">
          <svg class="btn-icon" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          Upload HTML Template
          <input type="file" id="template-input" accept=".html,text/html">
        </label>
      </div>
      <p class="hint" style="margin-top: 6px;"><a href="./example-template.html" download style="color:var(--accent); text-decoration: none;">Download starter HTML template ↗</a></p>

      <details style="margin-top: 16px;">
        <summary>Labels & sections</summary>
        <div class="form-grid">
          ${Object.keys(state.invoice.labels).map(k => field(k.replace(/([A-Z])/g, ' $1'), `invoice.labels.${k}`)).join('')}
        </div>
      </details>
    </div>

    <!-- Redesigned High-Utility Action Bar -->
    <div class="actions invoice-action-bar">
      <button class="primary" data-action="export">
        <svg class="btn-icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        Export PDF
      </button>
      <button data-action="copy-summary">
        <svg class="btn-icon" viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        Copy Summary
      </button>
      <button data-action="clone-project">
        <svg class="btn-icon" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        Duplicate Shoot
      </button>
    </div>
    <p id="export-status" role="status" class="hint"></p>`) +
    `<div class="preview-wrap"><div id="invoice-preview" class="invoice-paper"></div></div>`;
}

function enrichedState() {
  return { ...state, expenses: state.expenses.map(r => ({ ...r, imageThumbnail: images.get(r.receiptId)?.imageThumbnail || '' })) };
}

function template() {
  return templates.find(t => t.id === state.invoice.templateId) || presets.find(t => t.id === state.invoice.templateId) || presets[0];
}

function preview() {
  if (!$('#invoice-preview')) return;
  $('#invoice-preview').style.setProperty('--invoice-accent', state.invoice.accent || '#a8c3d0');
  $('#invoice-preview').innerHTML = renderInvoice(template(), enrichedState(), { editable: true });
}

function render() {
  if (!state) return;
  $('#view').innerHTML = tab === 'project' ? projectView() : tab === 'work' ? workView() : tab === 'receipts' ? receiptView() : invoiceView();
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.setAttribute('aria-current', b.dataset.tab === tab ? 'step' : 'false');
  });
  summary();
  preview();
}

async function go(next) {
  if (scanBusy || renderBusy) return;
  await saveChain;
  tab = next;
  location.hash = next;
  message('');
  render();
}

function updateField(path, value, element) {
  const old = getPath(path);
  if (typeof old === 'number' || element.type === 'number') {
    const max = path === 'project.taxRate' ? 100 : path.endsWith('.quantity') ? 1e6 : 1e12;
    if (!validNumber(value, max)) throw new Error('Enter a valid number.');
    value = Number(value);
    if (path.endsWith('.rate') || /^expenses\.\d+\.(total|vat)$/.test(path)) value = round(value, state.project.currency);
  }
  setPath(path, value);
  save();
  summary();
  if (path.startsWith('labor.')) {
    const i = Number(path.split('.')[1]), r = state.labor[i], el = document.querySelector(`[data-row-total="${i}"]`);
    if (el) el.textContent = money(round(r.rate * r.quantity, state.project.currency), state.project.currency);
  }
}

async function loadProject(id) {
  const loaded = await db.get('projects', id);
  if (!loaded) throw new Error('Project not found.');
  state = loaded;
  images = new Map();
  for (const r of state.expenses) {
    if (r.receiptId) {
      const image = await db.get('receipts', r.receiptId);
      if (image) images.set(r.receiptId, image);
    }
  }
  setSetting('currentProjectId', id);
  updatePicker();
  render();
}

async function addPhoto(file) {
  const full = await compressImage(file), thumb = await compressImage(file, 500, .78);
  const record = { id: uid(), projectId: state.id, imageFull: full, imageThumbnail: thumb, name: file.name };
  await db.put('receipts', record);
  images.set(record.id, record);
  state.expenses.push({ id: uid(), receiptId: record.id, vendor: '', date: '', total: '', vat: '', currency: state.project.currency, category: '', verified: false, warning: '' });
  await save();
}

async function scan(id) {
  const r = state.expenses.find(r => r.id === id);
  if (!r) return;
  if (!navigator.onLine) throw new Error('Offline. Connect to run scan.');
  scanBusy = true;
  render();
  message('Scanning with Gemini…');
  try {
    const result = await parseReceiptImage(images.get(r.receiptId).imageFull, setting('apiKey'), state.project.currency);
    Object.assign(r, result, { verified: false });
    await save();
    message('Scan complete. Review the fields.');
  } finally {
    scanBusy = false;
    render();
  }
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportPDF() {
  if (!state.project.projectTitle.trim() || !state.project.clientName.trim() || !state.contractor.name.trim() || !state.project.invoiceNumber.trim()) {
    throw new Error('Please fill in project, client, contractor name, and invoice number before exporting.');
  }
  renderBusy = true;
  const button = document.querySelector('[data-action=export]');
  if (button) button.disabled = true;
  if ($('#export-status')) $('#export-status').textContent = 'Rendering PDF…';

  let root;
  try {
    await save();
    await document.fonts.load('12px WrapKorean', '영수증 청구서');
    await document.fonts.ready;
    root = document.createElement('div');
    root.className = 'invoice-paper exporting';
    root.style.setProperty('--invoice-accent', state.invoice.accent || '#a8c3d0');
    root.innerHTML = renderInvoice(template(), enrichedState());
    document.body.append(root);
    await Promise.all([...root.querySelectorAll('img')].map(img => img.decode()));
    const filename = (state.project.invoiceNumber || 'WrapSheet').replace(/[^\p{L}\p{N}_-]/gu, '_') + '.pdf';
    await window.html2pdf().set({
      margin: 10,
      filename,
      image: { type: 'jpeg', quality: .96 },
      html2canvas: { scale: 2, useCORS: false, backgroundColor: '#ffffff', scrollY: 0 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'figure', '.invoice-totals'] }
    }).from(root).save();
    if ($('#export-status')) $('#export-status').textContent = 'PDF exported successfully.';
  } finally {
    root?.remove();
    renderBusy = false;
    if (button) button.disabled = false;
  }
}

const actions = {
  'add-labor': async () => {
    const kind = $('#labor-kind').value;
    state.labor.push({
      id: uid(),
      type: kind,
      description: kind,
      date: state.project.shootStart || today(),
      quantity: 1,
      rate: 0,
      unit: kind === 'Overtime' ? 'hour' : kind.includes('Rental') ? 'item' : 'day',
      taxable: true
    });
    await save();
    render();
  },
  'remove-labor': async id => {
    state.labor = state.labor.filter(r => r.id !== id);
    await save();
    render();
  },
  'manual-receipt': async () => {
    state.expenses.push({ id: uid(), receiptId: null, vendor: '', date: today(), total: '', vat: 0, currency: state.project.currency, category: '', verified: false, warning: '' });
    await save();
    render();
  },
  'confirm-receipt': async id => {
    const r = state.expenses.find(r => r.id === id);
    validateReceipt(r, state.project.currency);
    r.verified = true;
    await save();
    message('Expense verified.');
    render();
  },
  'remove-receipt': async id => {
    const r = state.expenses.find(r => r.id === id);
    state.expenses = state.expenses.filter(r => r.id !== id);
    await save();
    if (r.receiptId) {
      await db.remove('receipts', r.receiptId);
      images.delete(r.receiptId);
    }
    render();
  },
  'scan': scan,
  'export': exportPDF,
  'remove-logo': async () => {
    state.contractor.logo = '';
    await save();
    render();
  },
  'copy-summary': async () => {
    const t = totals(state), c = state.project.currency;
    const summaryText = `[WrapSheet] ${state.project.projectTitle || 'Production'}
Client: ${state.project.clientName || '-'}
Invoice: ${state.project.invoiceNumber || '-'}
Work & Equipment: ${money(t.labor, c)}
Verified Expenses: ${money(t.expenses, c)}
Total Due: ${money(t.total, c)}`;
    await navigator.clipboard.writeText(summaryText);
    message('Wrap summary copied to clipboard.');
  },
  'clone-project': async () => {
    const clone = structuredClone(state);
    clone.id = uid();
    clone.project.projectTitle = `${clone.project.projectTitle || 'Shoot'} (Copy)`;
    clone.project.invoiceNumber = `WS-${Date.now().toString().slice(-6)}`;
    await db.put('projects', clone);
    projects.push(clone);
    await loadProject(clone.id);
    message('Shoot duplicated successfully.');
  },
  'backup': async () => {
    await save();
    download(`WrapSheet-${state.id}.json`, new Blob([JSON.stringify({ schemaVersion: 1, project: state, receipts: [...images.values()] }, null, 2)], { type: 'application/json' }));
  }
};

document.addEventListener('click', async event => {
  const b = event.target.closest('button');
  if (!b) return;

  if (b.dataset.setColor) {
    state.invoice.accent = b.dataset.setColor;
    await save();
    preview();
    render();
    return;
  }

  if (b.id === 'primary-action-btn') {
    if (tab === 'project') await go('work');
    else if (tab === 'work') await go('receipts');
    else if (tab === 'receipts') await go('invoice');
    else if (tab === 'invoice') {
      try { await exportPDF(); } catch (err) { fail(err); }
    }
    return;
  }

  try {
    if (b.dataset.go || b.dataset.tab) {
      await go(b.dataset.go || b.dataset.tab);
      return;
    }
    if (b.dataset.action) {
      if (scanBusy || renderBusy) return;
      b.disabled = true;
      try {
        await actions[b.dataset.action]?.(b.dataset.id);
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    }
  } catch (error) {
    fail(error);
  }
});

document.addEventListener('input', event => {
  const el = event.target;
  if (!el.dataset.field || el.type === 'checkbox' || el.tagName === 'SELECT') return;
  try {
    updateField(el.dataset.field, el.value, el);
    if (tab === 'invoice') preview();
  } catch (error) {
    fail(error);
  }
});

document.addEventListener('change', async event => {
  const el = event.target;
  try {
    if (el.dataset.field) {
      updateField(el.dataset.field, el.type === 'checkbox' ? el.checked : el.value, el);
      if (tab === 'invoice') preview();
      return;
    }
    if (['camera-input', 'receipt-input', 'logo-input', 'template-input'].includes(el.id)) {
      const files = [...el.files];
      if (el.id === 'camera-input' || el.id === 'receipt-input') {
        for (const file of files) await addPhoto(file);
      }
      if (el.id === 'logo-input' && files[0]) {
        state.contractor.logo = await compressImage(files[0], 500, .9);
        await save();
      }
      if (el.id === 'template-input' && files[0]) {
        if (files[0].size > 250000) throw new Error('Template exceeds 250 KB limit.');
        const raw = await files[0].text();
        const html = checkTemplate(sanitizeTemplate(raw));
        const customT = { id: uid(), name: files[0].name.replace(/\.html?$/i, ''), html };
        await db.put('templates', customT);
        templates.push(customT);
        state.invoice.templateId = customT.id;
        await save();
        message('Custom HTML template installed and active.');
      }
      el.value = '';
      render();
    }
  } catch (error) {
    fail(error);
  }
});

$('#project-picker')?.addEventListener('change', async event => {
  const id = event.target.value;
  try {
    await saveChain;
    await loadProject(id);
  } catch (error) {
    fail(error);
  }
});

$('#new-project')?.addEventListener('click', async () => {
  const confirmCreate = confirm("Create a new shoot? Your current shoot remains saved in the dropdown.");
  if (!confirmCreate) return;
  try {
    await saveChain;
    state = newProject();
    images = new Map();
    tab = 'project';
    location.hash = 'project';
    await save();
    setSetting('currentProjectId', state.id);
    render();
  } catch (error) {
    fail(error);
  }
});

$('#settings-button')?.addEventListener('click', () => {
  $('#api-key').value = setting('apiKey');
  $('#settings').showModal();
});
$('#close-settings')?.addEventListener('click', () => $('#settings').close());
$('#settings-form')?.addEventListener('submit', event => {
  event.preventDefault();
  setSetting('apiKey', $('#api-key').value.trim());
  $('#settings').close();
  message('Settings saved.');
});
$('#clear-key')?.addEventListener('click', () => {
  setSetting('apiKey', '');
  $('#api-key').value = '';
  message('API key removed.');
});

function network() {
  const netEl = $('#network');
  if (netEl) netEl.textContent = navigator.onLine ? '● Online' : '○ Offline';
}
window.addEventListener('online', network);
window.addEventListener('offline', network);

window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (['project', 'work', 'receipts', 'invoice'].includes(next) && !scanBusy && !renderBusy) {
    tab = next;
    render();
  }
});

async function boot() {
  try {
    await db.openDB();
    projects = await db.all('projects');
    templates = await db.all('templates');
    const current = setting('currentProjectId');
    const existing = projects.find(p => p.id === current) || projects.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) await loadProject(existing.id);
    else {
      state = newProject();
      await save();
      setSetting('currentProjectId', state.id);
    }
    tab = ['project', 'work', 'receipts', 'invoice'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'project';
    render();
    network();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
  } catch (error) {
    $('#view').innerHTML = '<div class="panel"><h2>Local storage unavailable.</h2><button onclick="location.reload()">Reload</button></div>';
    fail(error);
  }
}

boot();