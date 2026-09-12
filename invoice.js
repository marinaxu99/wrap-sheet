import { money, totals, round } from './model.js';

export const escapeHTML = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export const presets = [
  { id: 'production', name: 'Production (Original Cinema Wrap)' },
  { id: 'minimal', name: 'Editorial Swiss (Clean Hairlines)' },
  { id: 'field', name: 'Field Ledger (Technical Spec)' }
];

const ko = {
  invoiceTitle: '청구서',
  laborTitle: '작업 및 장비',
  expensesTitle: '실비 정산',
  totalTitle: '총 청구 금액',
  paymentTitle: '입금 안내',
  receiptsTitle: '영수증 증빙'
};

export function sanitizeTemplate(source) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const allowed = new Set(['SECTION', 'DIV', 'HEADER', 'FOOTER', 'MAIN', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'P', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'BR', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'UL', 'OL', 'LI']);
  const blocked = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'TEMPLATE', 'IMG', 'AUDIO', 'VIDEO']);
  const clean = node => {
    for (const child of [...node.children]) {
      if (blocked.has(child.tagName)) { child.remove(); continue; }
      clean(child);
      if (!allowed.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
      for (const a of [...child.attributes]) child.removeAttribute(a.name);
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

export const placeholders = ['invoiceTitle', 'contractorName', 'clientName', 'clientAddress', 'projectTitle', 'invoiceNumber', 'invoiceDate', 'dueDate', 'shootDates', 'contractorDetails', 'logo', 'laborTable', 'expenseTable', 'laborTotal', 'expenseTotal', 'taxTotal', 'totalAmountDue', 'totals', 'paymentDetails', 'notes', 'receiptGallery', 'footer'];

export function checkTemplate(html) {
  const unknown = [...html.matchAll(/{{\s*(\w+)\s*}}/g)].map(m => m[1]).filter(p => !placeholders.includes(p));
  if (unknown.length) throw new Error(`Unknown placeholders: ${[...new Set(unknown)].join(', ')}`);
  for (const required of ['laborTable', 'expenseTable', 'totals']) {
    if (!html.includes(`{{${required}}}`)) throw new Error(`Template must contain {{${required}}}.`);
  }
  return html;
}

export function renderInvoice(template, s, { editable = false } = {}) {
  const e = escapeHTML, c = s.project.currency, t = totals(s), o = s.invoice.options || {};
  const currentPresetId = template?.id || s.invoice.templateId || 'production';

  const edit = (path, value, type = 'text') => editable
    ? `<span contenteditable="plaintext-only" role="textbox" aria-label="${e(path)}" data-edit="${e(path)}" data-type="${type}">${e(value)}</span>`
    : e(value);

  const label = k => edit(`invoice.labels.${k}`, s.invoice.labels[k]) + (o.bilingualLabels ? ` / ${ko[k]}` : '');
  const text = (path, value) => edit(path, value);
  const cash = value => e(money(value, c));

  // Shared Clean Table Rows
  const laborRows = s.labor.map((r, i) => `
    <tr>
      <td>${text(`labor.${i}.description`, r.description)}<br><small style="color:#666">${text(`labor.${i}.date`, r.date)}</small></td>
      <td>${edit(`labor.${i}.quantity`, r.quantity, 'number')} ${text(`labor.${i}.unit`, r.unit)}</td>
      <td>${editable ? edit(`labor.${i}.rate`, r.rate, 'number') : cash(r.rate)}</td>
      <td><strong>${cash(round(r.quantity * r.rate, c))}</strong>${r.taxable ? ' *' : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" style="text-align:center; padding:12px; color:#888;">No work logged</td></tr>';

  const laborTable = `
    <section>
      <h2>${label('laborTitle')}</h2>
      <table>
        <thead><tr><th>Description / Date</th><th>Qty / Unit</th><th>Rate</th><th>Amount</th></tr></thead>
        <tbody>${laborRows}</tbody>
      </table>
      <p style="font-size:10px; color:#666; margin-top:4px;">* Taxable items. Currency: ${c}</p>
    </section>
  `;

  const expenseRows = s.expenses.filter(r => r.verified).map((r, i) => `
    <tr>
      <td>${text(`expenses.${i}.vendor`, r.vendor)}<br><small style="color:#666">${text(`expenses.${i}.date`, r.date)}</small></td>
      ${o.showExpenseCategories ? `<td>${text(`expenses.${i}.category`, r.category)}</td>` : ''}
      ${o.showVat ? `<td>${editable ? edit(`expenses.${i}.vat`, r.vat, 'number') : cash(r.vat)}</td>` : ''}
      <td><strong>${editable ? edit(`expenses.${i}.total`, r.total, 'number') : cash(r.total)}</strong></td>
    </tr>
  `).join('');

  const expenseTable = `
    <section>
      <h2>${label('expensesTitle')}</h2>
      <table>
        <thead>
          <tr>
            <th>Vendor / Date</th>
            ${o.showExpenseCategories ? '<th>Category</th>' : ''}
            ${o.showVat ? '<th>Included VAT</th>' : ''}
            <th>Total Paid</th>
          </tr>
        </thead>
        <tbody>${expenseRows || `<tr><td colspan="${2 + Number(o.showVat) + Number(o.showExpenseCategories)}" style="text-align:center; padding:12px; color:#888;">No verified expenses</td></tr>`}</tbody>
      </table>
      <p style="font-size:10px; color:#666; margin-top:4px;">Reimbursements include receipt VAT; it is not added again.</p>
    </section>
  `;

  const receiptGallery = (o.showReceiptGallery !== false && s.expenses.some(r => r.verified)) ? `
    <section class="proof-section" style="margin-top:28px;">
      <h2>${label('receiptsTitle')}</h2>
      <div class="proof-grid">
        ${s.expenses.filter(r => r.verified).map((r, i) => `
          <figure>
            ${r.imageThumbnail ? `<img src="${e(r.imageThumbnail)}" alt="Receipt Proof">` : '<p style="padding:40px 0; text-align:center; color:#999; font-size:11px;">Manual expense — no photo</p>'}
            <figcaption>
              <strong>${String(i + 1).padStart(2, '0')} / ${e(r.vendor)}</strong> · ${e(r.date)} · ${cash(r.total)}<br>${e(r.category || 'Disbursement')}
            </figcaption>
          </figure>
        `).join('')}
      </div>
    </section>
  ` : '';

  const totalBlock = `
    <div class="invoice-totals">
      <div><span>Work subtotal</span><strong>${cash(t.labor)}</strong></div>
      ${t.tax > 0 ? `<div><span>Labor tax (${e(s.project.taxRate)}%)</span><strong>${cash(t.tax)}</strong></div>` : ''}
      ${t.expenses > 0 ? `<div><span>Expenses</span><strong>${cash(t.expenses)}</strong></div>` : ''}
      <div class="amount-due"><span>${label('totalTitle')}</span><strong>${cash(t.total)}</strong></div>
    </div>
  `;

  const paymentDetails = o.showBankInfo ? `
    <section class="payment-block">
      <h2>${label('paymentTitle')}</h2>
      <p>Bank: <strong>${text('contractor.bankName', s.contractor.bankName)}</strong><br>
      Account: <strong>${text('contractor.accountNumber', s.contractor.accountNumber)}</strong><br>
      Terms: ${text('contractor.paymentTerms', s.contractor.paymentTerms)}</p>
    </section>
  ` : '';

  const notes = o.showNotes && s.project.notes ? `
    <section class="notes-block">
      <h2>Notes</h2>
      <p>${text('project.notes', s.project.notes)}</p>
    </section>
  ` : '';

  if (template?.html) {
    const values = {
      invoiceTitle: label('invoiceTitle'),
      contractorName: text('contractor.name', s.contractor.name),
      clientName: text('project.clientName', s.project.clientName),
      clientAddress: text('project.clientAddress', s.project.clientAddress),
      projectTitle: text('project.projectTitle', s.project.projectTitle),
      invoiceNumber: text('project.invoiceNumber', s.project.invoiceNumber),
      invoiceDate: text('project.invoiceDate', s.project.invoiceDate),
      dueDate: text('project.dueDate', s.project.dueDate),
      shootDates: `${e(s.project.shootStart)} – ${e(s.project.shootEnd)}`,
      contractorDetails: `${text('contractor.address', s.contractor.address)}<br>${text('contractor.email', s.contractor.email)} · ${text('contractor.phone', s.contractor.phone)}<br>${text('contractor.taxId', s.contractor.taxId)}`,
      logo: s.contractor.logo ? `<img class="logo" src="${e(s.contractor.logo)}" alt="Logo">` : '',
      laborTable,
      expenseTable,
      receiptGallery,
      laborTotal: cash(t.labor),
      expenseTotal: cash(t.expenses),
      taxTotal: cash(t.tax),
      totalAmountDue: cash(t.total),
      totals: totalBlock,
      paymentDetails,
      notes,
      footer: text('contractor.footer', s.contractor.footer)
    };
    const safe = checkTemplate(sanitizeTemplate(template.html));
    return safe.replace(/{{\s*(\w+)\s*}}/g, (_, key) => values[key] ?? '');
  }

  // PRESET 1: PRODUCTION (Your Beloved Original Design)
  if (currentPresetId === 'production') {
    return `
      <div class="invoice-theme-production">
        <header class="invoice-header">
          <div>
            ${s.contractor.logo ? `<img class="logo" src="${e(s.contractor.logo)}" alt="Logo">` : ''}
            <h1>${label('invoiceTitle')}</h1>
            <p><strong>${text('contractor.name', s.contractor.name || 'Contractor')}</strong><br>
            ${text('contractor.email', s.contractor.email)} · ${text('contractor.phone', s.contractor.phone)} · ID: ${text('contractor.taxId', s.contractor.taxId || 'n/a')}</p>
          </div>
          <div class="inv-meta">
            <span class="inv-tag"># ${text('project.invoiceNumber', s.project.invoiceNumber)}</span>
            <p>Issued: <strong>${text('project.invoiceDate', s.project.invoiceDate)}</strong><br>
            Due: <strong>${text('project.dueDate', s.project.dueDate)}</strong></p>
          </div>
        </header>

        <div class="bill-to-strip">
          <div>
            <small>CLIENT / PRODUCTION</small>
            <strong>${text('project.clientName', s.project.clientName || 'Client')}</strong>
            <p>${text('project.clientAddress', s.project.clientAddress)}</p>
          </div>
          <div>
            <small>PROJECT / SHOOT</small>
            <strong>${text('project.projectTitle', s.project.projectTitle || 'Production')}</strong>
            <p>Dates: ${e(s.project.shootStart)} ~ ${e(s.project.shootEnd)}</p>
          </div>
        </div>

        ${laborTable}
        ${expenseTable}
        ${totalBlock}
        ${paymentDetails}
        ${notes}
        ${receiptGallery}

        <footer class="invoice-footer">
          <span>WRAPSHEET FIELD EDITION</span>
          <span>${text('contractor.footer', s.contractor.footer || 'FOOTER')}</span>
        </footer>
      </div>
    `;
  }

  // PRESET 2: EDITORIAL SWISS (Minimalist Hairlines)
  if (currentPresetId === 'minimal') {
    return `
      <div class="invoice-theme-swiss">
        <div class="swiss-head">
          <div>
            <h2>${text('contractor.name', s.contractor.name || 'Contractor')}</h2>
            <p>${text('contractor.email', s.contractor.email)} / ID: ${text('contractor.taxId', s.contractor.taxId || 'n/a')}</p>
          </div>
          <div style="text-align:right;">
            <span>INVOICE</span>
            <h1>#${text('project.invoiceNumber', s.project.invoiceNumber)}</h1>
          </div>
        </div>

        <div class="swiss-quad">
          <div><small>CLIENT</small><strong>${text('project.clientName', s.project.clientName)}</strong></div>
          <div><small>SHOOT</small><strong>${text('project.projectTitle', s.project.projectTitle)}</strong></div>
          <div><small>ISSUED</small><strong>${text('project.invoiceDate', s.project.invoiceDate)}</strong></div>
          <div><small>DUE</small><strong>${text('project.dueDate', s.project.dueDate)}</strong></div>
        </div>

        ${laborTable}
        ${expenseTable}
        ${totalBlock}
        ${paymentDetails}
        ${notes}
        ${receiptGallery}

        <footer class="invoice-footer">
          <span>SWISS EDITORIAL</span>
          <span>${text('contractor.footer', s.contractor.footer || 'THANK YOU')}</span>
        </footer>
      </div>
    `;
  }

  // PRESET 3: FIELD LEDGER (Technical Grid & Callout)
  return `
    <div class="invoice-theme-field">
      <div class="field-banner">
        <span>WRAPSHEET // FIELD DISBURSEMENT</span>
        <span>AUDIT REF: #${text('project.invoiceNumber', s.project.invoiceNumber)}</span>
      </div>

      <div class="field-trio">
        <div><small>CONTRACTOR</small><strong>${text('contractor.name', s.contractor.name)}</strong><p>${text('contractor.email', s.contractor.email)}</p></div>
        <div><small>PRODUCTION</small><strong>${text('project.clientName', s.project.clientName)}</strong><p>${text('project.projectTitle', s.project.projectTitle)}</p></div>
        <div><small>PAYMENT DUE</small><strong>${text('project.dueDate', s.project.dueDate)}</strong><p>${text('contractor.bankName', s.contractor.bankName)}</p></div>
      </div>

      ${laborTable}
      ${expenseTable}
      ${totalBlock}
      ${paymentDetails}
      ${notes}
      ${receiptGallery}

      <footer class="invoice-footer">
        <span>FIELD LOG SPECIFICATION</span>
        <span>${text('contractor.footer', s.contractor.footer || 'AUDIT READY')}</span>
      </footer>
    </div>
  `;
}