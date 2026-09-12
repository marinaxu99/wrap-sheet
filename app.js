import * as db from './db.js';
import { newProject, uid, today, money, totals, round, validNumber, validDate, validateReceipt } from './model.js';
import { renderInvoice, presets, sanitizeTemplate, checkTemplate, escapeHTML as e } from './invoice.js';
import { compressImage, parseReceiptImage } from './receipt.js';

const $ = s => document.querySelector(s);
let state, projects = [], templates = [], images = new Map(), tab = 'project', saveChain = Promise.resolve(), revision = 0, scanBusy = false, renderBusy = false, messageTimer = null;
let profileEditing = false;

const SWATCHES = [
  { name: 'Arki Slate', color: '#a8c3d0', desc: 'Cool Field Neutral' },
  { name: 'Kodak Amber', color: '#d4a373', desc: 'Warm 3200K Tungsten' },
  { name: 'Studio Olive', color: '#9aa899', desc: 'Arri Monitor Green' },
  { name: 'Technicolor Carmine', color: '#c97a7e', desc: 'Vintage Film Wash' },
  { name: 'Monochrome Silver', color: '#c8c8c4', desc: 'Classic B&W Starch' }
];

function addDays(isoDateStr, days) {
  if (!isoDateStr) return '';
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + Number(days));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calculateDueDate(invoiceDate, termsPreset) {
  if (!invoiceDate) return '';
  if (termsPreset === 'due_receipt') return invoiceDate;
  if (termsPreset === 'net_15') return addDays(invoiceDate, 15);
  if (termsPreset === 'net_30') return addDays(invoiceDate, 30);
  if (termsPreset === 'net_60') return addDays(invoiceDate, 60);
  return null;
}

function message(text, persistent = false) {
  const el = $('#message');
  if (!el) return;
  clearTimeout(messageTimer);
  el.textContent = text;
  el.hidden = !text;
  if (text && !persistent) {
    messageTimer = setTimeout(() => {
      el.hidden = true;
      el.textContent = '';
    }, 4000);
  }
}

function fail(error) { message(error.message || String(error), true); }

function setting(key) {
  try { return localStorage.getItem(`wrapsheet.${key}`) || ''; } catch { return ''; }
}

function setSetting(key, value) {
  try {
    if (value) localStorage.setItem(`wrapsheet.${key}`, value);
    else localStorage.removeItem(`wrapsheet.${key}`);
  } catch {
    message('Settings could not be saved.');
  }
}

function setPath(path, value) {
  const parts = path.split('.');
  let obj = state;
  for (const p of parts.slice(0, -1)) obj = obj[p];
  obj[parts.at(-1)] = value;
}

function getPath(path) {
  return path.split('.').reduce((o, k) => o?.[k], state);
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
      message(`Could not save shoot: ${error.message}.`, true);
      throw error;
    });

  saveChain.catch(() => { });
  return saveChain;
}

function updatePicker() {
  const picker = $('#project-picker');
  const title = state.project.projectTitle || 'Untitled production';
  if ($('#deck-current-title')) $('#deck-current-title').textContent = title;
  if (!picker) return;
  picker.innerHTML = `<option value="" disabled selected>Switch Shoot ▾</option>` +
    projects.map(p => `<option value="${p.id}">${e(p.project.projectTitle || 'Untitled production')}</option>`).join('');
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
  const statusPill = $('#receipt-status-pill');
  if (statusPill) {
    if (state.expenses.length === 0) {
      statusPill.hidden = true;
    } else if (pending > 0) {
      statusPill.hidden = false;
      statusPill.className = 'status-indicator-pill pending';
      statusPill.textContent = `○ ${pending} receipt${pending === 1 ? '' : 's'} awaiting review →`;
      statusPill.onclick = () => {
        go('receipts');
        setTimeout(() => {
          const firstPending = document.querySelector('.badge:not(.verified)');
          firstPending?.closest('.row-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 120);
      };
    } else {
      statusPill.hidden = false;
      statusPill.className = 'status-indicator-pill verified';
      statusPill.textContent = `✓ All ${state.expenses.length} receipts verified · Audit ready`;
      statusPill.onclick = null;
    }
  }
  updateStickyActionBar();
}

function field(label, path, type = 'text', extra = '') {
  return `<label>${label}<input data-field="${path}" type="${type}" value="${e(getPath(path))}" ${extra}></label>`;
}
function area(label, path, extra = '') {
  return `<label class="full">${label}<textarea data-field="${path}" ${extra}>${e(getPath(path))}</textarea></label>`;
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
  const currentTerms = state.project.termsPreset || 'due_receipt';
  const isLocked = !profileEditing;

  return panel('Set the scene.', 'Production metadata for the final invoice.',
    `<div class="form-grid">
      ${field('Project title', 'project.projectTitle', 'text', 'placeholder="e.g. Autumn campaign — Seoul" maxlength="200"')}
      ${field('Client / production company', 'project.clientName', 'text', 'placeholder="Production studio or client name" maxlength="200"')}
      ${select('Currency', 'project.currency', [['KRW', 'KRW — Korean won'], ['USD', 'USD — US dollar'], ['EUR', 'EUR — Euro']])}
      ${field('Invoice number', 'project.invoiceNumber')}
      ${field('Shoot start', 'project.shootStart', 'date')}
      ${field('Shoot end', 'project.shootEnd', 'date')}
      ${field('Invoice date', 'project.invoiceDate', 'date')}
      <div class="terms-due-cell">
        <label>Payment terms & due date
          <div class="terms-split-row">
            <div class="select-chevron-wrap">
              <select id="payment-terms-preset" data-field="project.termsPreset">
                <option value="due_receipt" ${currentTerms === 'due_receipt' ? 'selected' : ''}>Due Now</option>
                <option value="net_15" ${currentTerms === 'net_15' ? 'selected' : ''}>Net 15</option>
                <option value="net_30" ${currentTerms === 'net_30' ? 'selected' : ''}>Net 30</option>
                <option value="net_60" ${currentTerms === 'net_60' ? 'selected' : ''}>Net 60</option>
                <option value="custom" ${currentTerms === 'custom' ? 'selected' : ''}>Custom</option>
              </select>
            </div>
            <input data-field="project.dueDate" type="date" value="${e(getPath('project.dueDate'))}" id="payment-due-input">
          </div>
        </label>
      </div>
      ${area('Client address', 'project.clientAddress')}
    </div>`, 'PRODUCTION DETAILS') +

    panel('Contractor Profile Vault', 'Your verified contractor credentials. Locked to prevent accidental changes.',
      `<div class="profile-vault-card ${isLocked ? 'locked' : 'editing'}">
        <div class="vault-top">
          <div class="vault-status">
            <span class="vault-icon">${isLocked ? '🔒' : '✎'}</span>
            <strong>${isLocked ? 'Profile Locked & Active' : 'Editing Contractor Profile'}</strong>
          </div>
          <button type="button" class="action-btn" data-action="${isLocked ? 'edit-profile' : 'save-profile'}">
            ${isLocked ? '✎ Edit Profile' : '✓ Lock & Save Default'}
          </button>
        </div>

        <div class="form-grid" style="margin-top:14px;">
          ${field('Contractor / Company', 'contractor.name', 'text', isLocked ? 'disabled' : 'placeholder="Your name or studio"')}
          ${field('Email', 'contractor.email', 'email', isLocked ? 'disabled' : '')}
          ${field('Phone', 'contractor.phone', 'tel', isLocked ? 'disabled' : '')}
          ${field('Business registration / Tax ID', 'contractor.taxId', 'text', isLocked ? 'disabled' : '')}
          ${area('Business Address', 'contractor.address', isLocked ? 'disabled' : '')}
          ${field('Bank Name', 'contractor.bankName', 'text', isLocked ? 'disabled' : '')}
          ${field('Account Number', 'contractor.accountNumber', 'text', isLocked ? 'disabled' : '')}
          ${area('Payment Terms', 'contractor.paymentTerms', isLocked ? 'disabled' : '')}
        </div>
      </div>`, 'PROFILE VAULT');
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
          <span>Taxable item</span>
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
  const hasApiKey = Boolean(setting('apiKey'));

  return panel('Proof, without the paperwork.', 'Upload slips as you get them. Only verified receipts enter the invoice.',
    `${!hasApiKey ? `<div class="ocr-notice-bar">
      <span>ℹ Instant OCR requires a free Google AI key. Set it up once in <a data-action="open-settings">API & Setup ⚙</a></span>
    </div>` : ''}
    <div class="upload-box" id="receipt-dropzone">
      <svg class="box-icon" viewBox="0 0 24 24">
        <path d="M19 2H5c-1.1 0-2 .9-2 2v17l3-1.5 3 1.5 3-1.5 3 1.5 3-1.5 3 1.5V4c0-1.1-.9-2-2-2zm0 15.8l-1-.5-3 1.5-3-1.5-3 1.5-3-1.5-1 .5V4h14v13.8zM7 7h10v2H7zm0 4h10v2H7zm0 4h7v2H7z"/>
      </svg>
      <h3>Drop the admin. Keep the receipt.</h3>
      <p>Supports Hi-Pass tolls, parking, and catering slips</p>
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
      <span class="hint">${state.expenses.length} receipts logged · Tap thumbnail to inspect proof</span>
    </div>
    ${state.expenses.map((r, i) => `
      <div class="row-card">
        <div class="row-top">
          <span class="badge ${r.verified ? 'verified' : ''}">${r.verified ? '✓ VERIFIED' : '○ PENDING REVIEW'} · ${String(i + 1).padStart(2, '0')}</span>
          <button class="remove" data-action="remove-receipt" data-id="${r.id}">Remove</button>
        </div>
        <div class="receipt-card">
          <div>
            ${images.get(r.receiptId) ? `<img class="receipt-image" src="${e(images.get(r.receiptId).imageThumbnail)}" alt="Receipt" data-inspect-id="${r.id}" style="cursor:pointer;" title="Tap to inspect">` : '<div class="empty">Manual</div>'}
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
              ${!r.verified
        ? `<button class="primary" data-action="confirm-receipt" data-id="${r.id}">Confirm expense</button>`
        : `<button class="action-btn" data-action="unconfirm-receipt" data-id="${r.id}">Edit expense</button>`
      }
              ${r.receiptId && !r.verified
        ? `<button class="action-btn" data-action="scan" data-id="${r.id}" ${scanBusy ? 'disabled' : ''}>${scanBusy ? 'Scanning…' : 'Re-scan OCR'}</button>`
        : ''
      }
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
  const showGallery = state.invoice.options?.showReceiptGallery !== false;

  return (
    panel('Invoice Style & Palette', 'Choose an editorial layout and cinema-accent color.',
      `<div class="form-grid">
        <div class="select-chevron-wrap full">
          <label>Layout Preset
            <select data-field="invoice.templateId" class="preset-dropdown">
              ${presets.map(p => `<option value="${p.id}" ${state.invoice.templateId === p.id ? 'selected' : ''}>${e(p.name)}</option>`).join('')}
              ${templates.map(t => `<option value="${t.id}" ${state.invoice.templateId === t.id ? 'selected' : ''}>${e(t.name)} (Custom)</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="full" style="margin-top: 6px;">
          <label>Cinema Accent Grade</label>
          <div class="swatch-group">
            ${SWATCHES.map(s => `
              <button type="button" class="swatch-btn ${currentAccent.toLowerCase() === s.color ? 'active' : ''}" 
                      style="background: ${s.color}" data-set-color="${s.color}" title="${s.name} (${s.desc})"></button>
            `).join('')}
          </div>
        </div>
      </div>`, 'LAYOUT ARCHETYPE') +

    panel('Export Options & Branding', 'Control PDF attachments, logo, and document exports.',
      `<div class="invoice-options-deck">
        <label class="check-pill full">
          <input type="checkbox" data-field="invoice.options.showReceiptGallery" ${showGallery ? 'checked' : ''}>
          <span>Include receipt proof gallery in PDF (Uncheck if using Google Drive)</span>
        </label>

        <div class="deck-row">
          <label class="file-button deck-btn">
            <svg class="btn-icon" viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
            ${state.contractor.logo ? 'Change Logo' : 'Upload Logo'}
            <input type="file" id="logo-input" accept="image/*">
          </label>
          ${state.contractor.logo ? '<button class="action-btn" data-action="remove-logo">Remove Logo</button>' : ''}

          <label class="file-button deck-btn">
            <svg class="btn-icon" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
            Upload Custom HTML
            <input type="file" id="template-input" accept=".html,text/html">
          </label>
        </div>

        <details style="margin-top: 18px;">
          <summary style="cursor:pointer; font-size:12px; font-weight:600; color:var(--accent);">Customize Document Section Headings ▾</summary>
          <div class="form-grid" style="margin-top:12px;">
            ${Object.keys(state.invoice.labels).map(k => field(k.replace(/([A-Z])/g, ' $1'), `invoice.labels.${k}`)).join('')}
          </div>
        </details>
      </div>

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
      <p id="export-status" role="status" class="hint"></p>`, 'DOCUMENT ACTIONS') +

    `<!-- Proportional Scaled Viewport -->
    <div class="preview-prompt-bar">
      <span>Live Sheet Preview</span>
      <span class="edit-zoom-pill" id="open-zoom-modal">🔍 Tap to View & Edit Full Size</span>
    </div>
    <div class="preview-viewport-box" id="scaler-viewport" title="Tap to expand and edit">
      <div class="preview-scaler-stage" id="scaler-stage">
        <div id="invoice-preview" class="invoice-paper"></div>
      </div>
    </div>

    <dialog id="invoice-zoom-modal">
      <div class="zoom-modal-header">
        <span>Tap any dashed field to edit</span>
        <button type="button" id="close-zoom-modal" class="primary">Done</button>
      </div>
      <div class="zoom-modal-body" id="invoice-modal-backdrop">
        <div id="invoice-modal-content" class="invoice-paper"></div>
      </div>
    </dialog>`
  );
}

function enrichedState() {
  return { ...state, expenses: state.expenses.map(r => ({ ...r, imageThumbnail: images.get(r.receiptId)?.imageThumbnail || '' })) };
}

function template() {
  return templates.find(t => t.id === state.invoice.templateId) || presets.find(t => t.id === state.invoice.templateId) || presets[0];
}

function preview() {
  const el = $('#invoice-preview');
  if (!el) return;

  const currentTpl = template();
  const stateData = enrichedState();
  const accent = state.invoice.accent || '#a8c3d0';

  el.style.setProperty('--invoice-accent', accent);
  el.innerHTML = renderInvoice(currentTpl, stateData, { editable: false });

  const modalEl = $('#invoice-modal-content');
  if (modalEl) {
    modalEl.style.setProperty('--invoice-accent', accent);
    modalEl.innerHTML = renderInvoice(currentTpl, stateData, { editable: true });
  }

  requestAnimationFrame(() => {
    const viewport = $('#scaler-viewport');
    const stage = $('#scaler-stage');
    if (!viewport || !stage) return;

    const availableWidth = viewport.clientWidth - 32;
    const baseWidth = 680;

    if (availableWidth > 0 && availableWidth < baseWidth) {
      const scale = availableWidth / baseWidth;
      stage.style.transform = `scale(${scale})`;
      stage.style.marginBottom = `-${(stage.offsetHeight * (1 - scale))}px`;
    } else {
      stage.style.transform = 'none';
      stage.style.marginBottom = '0px';
    }
  });
}

window.addEventListener('resize', () => {
  if (tab === 'invoice') preview();
});

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
  if (typeof old === 'number' || (element && element.type === 'number')) {
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
  const full = await compressImage(file, 1200, 0.82);
  const thumb = await compressImage(file, 400, 0.72);
  const record = { id: uid(), projectId: state.id, imageFull: full, imageThumbnail: thumb, name: file.name };
  await db.put('receipts', record);
  images.set(record.id, record);

  const apiKey = setting('apiKey');
  if (navigator.onLine && apiKey) {
    scanBusy = true;
    render();
    message('Reading items with Gemini 2.5 Flash…', true);
    try {
      const items = await parseReceiptImage(full, apiKey, state.project.currency);
      for (const item of items) {
        state.expenses.unshift({
          id: uid(),
          receiptId: record.id,
          vendor: item.vendor,
          date: item.date,
          total: item.total,
          vat: item.vat,
          currency: item.currency,
          category: item.category,
          verified: false,
          warning: item.warning
        });
      }
      message(`${items.length} item(s) extracted. Review and confirm.`);
    } catch (e) {
      state.expenses.unshift({
        id: uid(),
        receiptId: record.id,
        vendor: '',
        date: '',
        total: '',
        vat: '',
        currency: state.project.currency,
        category: '',
        verified: false,
        warning: 'Could not auto-scan'
      });
      fail(e);
    } finally {
      scanBusy = false;
      await save();
      render();
    }
  } else {
    state.expenses.unshift({
      id: uid(),
      receiptId: record.id,
      vendor: '',
      date: '',
      total: '',
      vat: '',
      currency: state.project.currency,
      category: '',
      verified: false,
      warning: ''
    });
    await save();
    render();
    message('Receipt photo saved.');
  }
}

async function scan(id) {
  const r = state.expenses.find(r => r.id === id);
  if (!r) return;
  const apiKey = setting('apiKey');
  if (!apiKey) {
    message('Add your Gemini API Key in Settings.', true);
    return;
  }
  scanBusy = true;
  render();
  message('Scanning with Gemini Flash…', true);

  try {
    const items = await parseReceiptImage(images.get(r.receiptId).imageFull, apiKey, state.project.currency);
    Object.assign(r, items[0], { verified: false });
    await save();
    message('Scan complete.');
  } catch (err) {
    fail(err);
  } finally {
    scanBusy = false;
    render();
  }
}

function openInspector(expenseId) {
  const r = state.expenses.find(x => x.id === expenseId);
  if (!r || !r.receiptId) return;
  const imgRecord = images.get(r.receiptId);
  if (!imgRecord) return;

  const modal = $('#receipt-inspect-modal');
  const imgTarget = $('#inspect-img-target');
  const formTarget = $('#inspect-form-target');

  const idx = state.expenses.findIndex(x => x.id === expenseId);

  imgTarget.src = imgRecord.imageFull;
  formTarget.innerHTML = `
    <h3 style="margin-bottom:12px; font-size:16px;">Verify Line Item #${idx + 1}</h3>
    <div class="form-grid" style="grid-template-columns:1fr; gap:12px;">
      ${field('Vendor / 거래처', `expenses.${idx}.vendor`)}
      ${field('Date / 날짜', `expenses.${idx}.date`, 'date')}
      ${field('Total paid / 합계', `expenses.${idx}.total`, 'number', 'min="0" step="any"')}
      ${field('Included VAT / 부가세', `expenses.${idx}.vat`, 'number', 'min="0" step="any"')}
      ${field('Category', `expenses.${idx}.category`)}
    </div>
    <div style="margin-top:20px; display:flex; gap:10px;">
      <button class="primary" data-action="confirm-receipt" data-id="${r.id}">Confirm & Verify</button>
    </div>
  `;

  modal.showModal();
}

async function exportPDF() {
  if (
    !state.project.projectTitle.trim() ||
    !state.project.clientName.trim() ||
    !state.contractor.name.trim() ||
    !state.project.invoiceNumber.trim()
  ) {
    throw new Error('Please fill in project, client, contractor name, and invoice number before exporting.');
  }

  renderBusy = true;
  const button = document.querySelector('[data-action=export]');
  if (button) button.disabled = true;
  if ($('#export-status')) $('#export-status').textContent = 'Rendering PDF…';

  let root;
  try {
    await save();
    root = document.createElement('div');
    root.className = 'invoice-paper exporting';
    root.style.setProperty('--invoice-accent', state.invoice.accent || '#a8c3d0');
    root.innerHTML = renderInvoice(template(), enrichedState());

    if (state.invoice.options?.showReceiptGallery === false) {
      const proofs = root.querySelector('.proof-section');
      if (proofs) proofs.remove();
    }

    document.body.append(root);
    await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => { })));

    const filename = (state.project.invoiceNumber || 'WrapSheet').replace(/[^\p{L}\p{N}_-]/gu, '_') + '.pdf';

    await window.html2pdf()
      .set({
        margin: [12, 10, 14, 10],
        filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollY: 0, windowWidth: 760 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: {
          mode: ['avoid-all', 'css', 'legacy'],
          avoid: ['h2', 'h1', 'tr', 'figure', '.invoice-totals', '.invoice-header', '.invoice-footer', 'p']
        }
      })
      .from(root)
      .save();

    if ($('#export-status')) $('#export-status').textContent = 'PDF exported cleanly.';
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
    state.expenses.unshift({ id: uid(), receiptId: null, vendor: '', date: today(), total: '', vat: 0, currency: state.project.currency, category: '', verified: false, warning: '' });
    await save();
    render();
  },
  'confirm-receipt': async id => {
    const r = state.expenses.find(r => r.id === id);
    validateReceipt(r, state.project.currency);
    r.verified = true;
    await save();
    message('Expense verified and included in total.');
    const inspectModal = $('#receipt-inspect-modal');
    if (inspectModal && inspectModal.open) inspectModal.close();
    render();
  },
  'unconfirm-receipt': async id => {
    const r = state.expenses.find(r => r.id === id);
    if (r) {
      r.verified = false;
      await save();
      message('Expense marked for editing and excluded from total.');
      render();
    }
  },
  'remove-receipt': async id => {
    const r = state.expenses.find(r => r.id === id);
    state.expenses = state.expenses.filter(r => r.id !== id);
    await save();
    render();
  },
  'edit-profile': () => {
    profileEditing = true;
    render();
  },
  'save-profile': () => {
    profileEditing = false;
    localStorage.setItem('wrapsheet.defaultContractor', JSON.stringify(state.contractor));
    save();
    render();
    message(`★ Profile locked & saved as default (${state.contractor.name || 'Contractor'}).`);
  },
  'open-settings': () => {
    $('#api-key').value = setting('apiKey');
    $('#settings').showModal();
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
    message('Shoot duplicated.');
  }
};

function initDragAndDrop() {
  const dropzone = $('#receipt-dropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', async e => {
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    for (const file of files) await addPhoto(file);
  });
}

document.addEventListener('click', async event => {
  const b = event.target.closest('button') || event.target.closest('a[data-action]');

  const inspectImg = event.target.closest('[data-inspect-id]');
  if (inspectImg) {
    openInspector(inspectImg.dataset.inspectId);
    return;
  }

  if (event.target.closest('#close-inspect-modal')) {
    $('#receipt-inspect-modal')?.close();
    return;
  }

  if (event.target.closest('#scaler-viewport') || event.target.closest('#open-zoom-modal')) {
    $('#invoice-zoom-modal')?.showModal();
    preview();
    return;
  }

  if (event.target.closest('#close-zoom-modal') || event.target.id === 'invoice-modal-backdrop') {
    $('#invoice-zoom-modal')?.close();
    return;
  }

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
      const val = el.type === 'checkbox' ? el.checked : el.value;
      updateField(el.dataset.field, val, el);

      if (el.dataset.field === 'project.termsPreset') {
        const computed = calculateDueDate(state.project.invoiceDate, val);
        if (computed) {
          updateField('project.dueDate', computed, $('#payment-due-input'));
          const dueInput = $('#payment-due-input');
          if (dueInput) dueInput.value = computed;
        }
      }

      if (el.dataset.field === 'project.dueDate') {
        const presetSelect = $('#payment-terms-preset');
        if (presetSelect && state.project.termsPreset !== 'custom') {
          const expected = calculateDueDate(state.project.invoiceDate, state.project.termsPreset);
          if (val !== expected) {
            updateField('project.termsPreset', 'custom', presetSelect);
            presetSelect.value = 'custom';
          }
        }
      }

      if (el.dataset.field === 'project.invoiceDate' && state.project.termsPreset !== 'custom') {
        const computed = calculateDueDate(val, state.project.termsPreset || 'due_receipt');
        if (computed) {
          updateField('project.dueDate', computed, $('#payment-due-input'));
          const dueInput = $('#payment-due-input');
          if (dueInput) dueInput.value = computed;
        }
      }

      if (tab === 'invoice') preview();
      return;
    }

    if (['camera-input', 'receipt-input', 'logo-input', 'template-input'].includes(el.id)) {
      const files = [...el.files];
      if (el.id === 'camera-input' || el.id === 'receipt-input') {
        for (const file of files) await addPhoto(file);
      }
      if (el.id === 'logo-input' && files[0]) {
        state.contractor.logo = await compressImage(files[0], 500, 0.9);
        await save();
      }
      if (el.id === 'template-input' && files[0]) {
        const raw = await files[0].text();
        const html = checkTemplate(sanitizeTemplate(raw));
        const customT = { id: uid(), name: files[0].name.replace(/\.html?$/i, ''), html };
        await db.put('templates', customT);
        templates.push(customT);
        state.invoice.templateId = customT.id;
        await save();
        message('Custom HTML template installed.');
      }
      el.value = '';
      render();
    }
  } catch (error) {
    fail(error);
  }
});

document.addEventListener('focusout', event => {
  const el = event.target.closest('[data-edit]');
  if (!el) return;
  const path = el.dataset.edit;
  try {
    const value = el.textContent.trim();
    if (String(getPath(path)) === value) return;
    updateField(path, value, el);
    preview();
  } catch (error) {
    el.textContent = getPath(path);
    fail(error);
  }
});

$('#project-picker')?.addEventListener('change', async event => {
  const id = event.target.value;
  if (!id) return;
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

    const savedContractor = localStorage.getItem('wrapsheet.defaultContractor');
    if (savedContractor) {
      try {
        state.contractor = { ...state.contractor, ...JSON.parse(savedContractor) };
      } catch { }
    }

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
  message('API key saved.');
  render();
});
$('#clear-key')?.addEventListener('click', () => {
  setSetting('apiKey', '');
  $('#api-key').value = '';
  message('API key removed.');
  render();
});

window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (['project', 'work', 'receipts', 'invoice'].includes(next) && !scanBusy && !renderBusy) {
    tab = next;
    render();
  }
});

const originalRender = render;
render = function () {
  originalRender();
  if (tab === 'receipts') initDragAndDrop();
};

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
      const savedContractor = localStorage.getItem('wrapsheet.defaultContractor');
      if (savedContractor) {
        try {
          state.contractor = { ...state.contractor, ...JSON.parse(savedContractor) };
        } catch { }
      }
      await save();
      setSetting('currentProjectId', state.id);
    }
    tab = ['project', 'work', 'receipts', 'invoice'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'project';
    render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { });
  } catch (error) {
    fail(error);
  }
}

boot();