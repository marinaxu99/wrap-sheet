import { money, totals, round, isBillable, byDateTime } from './model.js';

export const escapeHTML = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export const presets = [
  { id: 'production', name: 'Production' },
  { id: 'minimal', name: 'Minimal' },
  { id: 'traditional', name: 'Formal' },
  { id: 'receipt-heavy', name: 'Receipt ledger' }
];

const ko = {
  invoiceTitle: '청구서',
  laborTitle: '작업 및 장비',
  expensesTitle: '실비 정산',
  totalTitle: '총 청구 금액',
  paymentTitle: '입금 안내',
  receiptsTitle: '영수증 증빙'
};

export function renderInvoice(presetId, s) {
  const e = escapeHTML, c = s.project.currency, t = totals(s), o = s.invoice.options || {};
  const currentPresetId = presets.some(p => p.id === presetId) ? presetId : 'production';
  const editable = false;
  const edit = (path, value) => e(value);

  const label = k => edit(`invoice.labels.${k}`, s.invoice.labels[k]) + (o.bilingualLabels ? ` / ${ko[k]}` : '');
  const text = (path, value) => edit(path, value);
  const cash = value => e(money(value, c));

  const laborRows = s.labor.map((r, i) => `
    <tr>
      <td>${text(`labor.${i}.description`, r.description)}<br><small style="color:#666">${text(`labor.${i}.date`, r.date)}</small></td>
      <td>${edit(`labor.${i}.quantity`, r.quantity, 'number')} ${text(`labor.${i}.unit`, r.unit)}</td>
      <td>${editable ? edit(`labor.${i}.rate`, r.rate, 'number') : cash(r.rate)}</td>
      <td style="text-align:right"><strong>${cash(round(r.quantity * r.rate, c))}</strong>${r.taxable ? ' *' : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" style="text-align:center; padding:12px; color:#888;">No work logged</td></tr>';

  const laborTable = `
    <section class="invoice-section">
      <h2>${label('laborTitle')}</h2>
      <table>
        <thead><tr><th>Description / Date</th><th>Qty / Unit</th><th>Rate</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${laborRows}</tbody>
      </table>
      <p style="font-size:9px; color:#777; margin-top:4px;">* Taxable items. Currency: ${c}</p>
    </section>
  `;

  const billable = s.expenses.map((r, i) => ({ ...r, _i: r._i ?? i })).filter(isBillable).sort(byDateTime);
  const expenseRows = billable.map(r => { const i = r._i; return `
    <tr>
      <td>${text(`expenses.${i}.vendor`, r.vendor)}<br><small style="color:#666">${text(`expenses.${i}.date`, r.date)}${r.time ? ' ' + e(r.time) : ''}${r.status === 'check' ? ' · needs check' : ''}</small></td>
      ${o.showExpenseCategories ? `<td>${text(`expenses.${i}.category`, r.category)}</td>` : ''}
      ${o.showVat ? `<td>${editable ? edit(`expenses.${i}.vat`, r.vat, 'number') : cash(r.vat)}</td>` : ''}
      <td style="text-align:right"><strong>${editable ? edit(`expenses.${i}.total`, r.total, 'number') : cash(r.total)}</strong></td>
    </tr>
  `; }).join('');

  const expenseTable = `
    <section class="invoice-section">
      <h2>${label('expensesTitle')}</h2>
      <table>
        <thead>
          <tr>
            <th>Vendor / Date</th>
            ${o.showExpenseCategories ? '<th>Category</th>' : ''}
            ${o.showVat ? '<th>Included VAT</th>' : ''}
            <th style="text-align:right">Total Paid</th>
          </tr>
        </thead>
        <tbody>${expenseRows || `<tr><td colspan="${2 + Number(o.showVat) + Number(o.showExpenseCategories)}" style="text-align:center; padding:12px; color:#888;">No verified expenses</td></tr>`}</tbody>
      </table>
      <p style="font-size:9px; color:#777; margin-top:4px;">${s.project.vatOnExpenses && s.project.taxType === 'vat' ? 'VAT is charged on reimbursed expenses as agreed with the client.' : 'Reimbursements include receipt VAT; it is not added again.'}</p>
    </section>
  `;

  const receiptGallery = (o.showReceiptGallery !== false) ? `
    <section class="proof-section" style="margin-top:24px; break-inside:avoid; page-break-inside:avoid;">
      <h2>${label('receiptsTitle')}</h2>
      <div class="proof-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        ${billable.map((r, i) => `
          <figure style="border:1px solid #e0e0e0; padding:8px; border-radius:4px; background:#fafafa; break-inside:avoid;">
            ${r.imageThumbnail ? `<img src="${e(r.imageThumbnail)}" alt="Receipt Proof" style="width:100%; height:160px; object-fit:contain; background:#fff; border-radius:2px;">` : '<p style="padding:40px 0; text-align:center; color:#999; font-size:11px;">Manual expense</p>'}
            <figcaption style="font-size:9px; color:#555; margin-top:6px; text-align:center;">
              <strong>${String(i + 1).padStart(2, '0')} / ${e(r.vendor)}</strong> · ${e(r.date)} · ${cash(r.total)}<br>${e(r.category || 'Disbursement')}
            </figcaption>
          </figure>
        `).join('') || '<p style="font-size:11px; color:#888;">No receipt proofs attached.</p>'}
      </div>
    </section>
  ` : '';

  // Adaptive tax calculation label and sign
  const taxTitle = t.isWithholding ? 'Withholding tax' : (s.project.vatOnExpenses ? 'VAT (work + expenses)' : 'Labor tax (VAT)');
  const taxPrefix = t.isWithholding ? '−' : '+';
  const totalBlock = `
    <div class="invoice-totals">
      <div><span>Work subtotal</span><strong>${cash(t.labor)}</strong></div>
      ${t.tax > 0 ? `<div><span>${taxTitle} (${e(s.project.taxRate)}%)</span><strong>${taxPrefix}${cash(t.tax)}</strong></div>` : ''}
      ${t.expenses > 0 ? `<div><span>Expenses</span><strong>${cash(t.expenses)}</strong></div>` : ''}
      <div class="amount-due"><span>${label('totalTitle')}</span><strong>${cash(t.total)}</strong></div>
    </div>
  `;

  const paymentDetails = o.showBankInfo ? `
    <section class="payment-block" style="margin-top:20px;">
      <h2>${label('paymentTitle')}</h2>
      <p style="font-size:11px; line-height:1.6;">
        Bank: <strong>${text('contractor.bankName', s.contractor.bankName)}</strong><br>
        Account: <strong>${text('contractor.accountNumber', s.contractor.accountNumber)}</strong>${s.contractor.accountHolder ? ` (${e(s.contractor.accountHolder)})` : ''}<br>
        Terms: ${text('contractor.paymentTerms', s.contractor.paymentTerms)}
      </p>
    </section>
  ` : '';

  const notes = o.showNotes && s.project.notes ? `
    <section style="margin-top:14px;">
      <h2 style="font-size:10px; text-transform:uppercase; letter-spacing:0.8px;">Notes</h2>
      <p style="font-size:11px; color:#555;">${text('project.notes', s.project.notes)}</p>
    </section>
  ` : '';

  // PRESET 1: PRODUCTION
  if (currentPresetId === 'production') {
    return `
      <article class="invoice-paper-layout production-theme">
        <header class="invoice-header">
          <div>
            ${s.contractor.logo ? `<img src="${e(s.contractor.logo)}" alt="Logo" class="logo">` : ''}
            <h1>${label('invoiceTitle')}</h1>
            <p style="font-size:12px; font-weight:700;">${text('contractor.name', s.contractor.name || 'Contractor')}${s.contractor.role ? ` · ${e(s.contractor.role)}` : ''}</p>
            <p style="font-size:10px; color:#555;">${text('contractor.email', s.contractor.email)} · ${text('contractor.phone', s.contractor.phone)} · ID: ${text('contractor.taxId', s.contractor.taxId || 'n/a')}</p>
          </div>
          <div class="inv-meta">
            <span class="inv-tag"># ${text('project.invoiceNumber', s.project.invoiceNumber)}</span>
            <p style="margin-top:6px;">Issued: <strong>${text('project.invoiceDate', s.project.invoiceDate)}</strong></p>
            <p>Due: <strong>${text('project.dueDate', s.project.dueDate)}</strong></p>
          </div>
        </header>

        <div class="bill-to-strip">
          <div>
            <small>CLIENT / PRODUCTION</small>
            <strong>${text('project.clientName', s.project.clientName || 'Client')}</strong>
            <p>${text('project.clientAddress', s.project.clientAddress || '')}</p>
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
          <span>${e(s.project.invoiceNumber)}</span>
          <span>${e(s.contractor.footer || '')}</span>
        </footer>
      </article>
    `;
  }

  // PRESET 2: EDITORIAL SWISS
  if (currentPresetId === 'minimal') {
    return `
      <article class="invoice-paper-layout minimal-theme">
        <div style="display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:16px; border-bottom:2px solid #000; margin-bottom:22px;">
          <div>
            <h1 style="font-size:24px; font-weight:800; letter-spacing:-0.5px; margin:0 0 4px; color:#000;">${text('contractor.name', s.contractor.name || 'Contractor')}</h1>
            <p style="font-size:11px; color:#666; margin:0;">${text('contractor.email', s.contractor.email || '')} · Tax ID: ${text('contractor.taxId', s.contractor.taxId || 'n/a')}</p>
          </div>
          <div style="text-align:right;">
            <span style="font-size:9px; font-weight:800; letter-spacing:1.5px; color:var(--invoice-accent, #a8c3d0); display:block; text-transform:uppercase;">INVOICE</span>
            <strong style="font-size:20px; color:#000; letter-spacing:-0.5px;">#${text('project.invoiceNumber', s.project.invoiceNumber)}</strong>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:16px; margin-bottom:24px; font-size:11px;">
          <div>
            <span style="font-size:9px; font-weight:800; color:#888; letter-spacing:1px; display:block; margin-bottom:4px;">CLIENT</span>
            <strong style="color:#000; font-size:12px;">${text('project.clientName', s.project.clientName || '—')}</strong>
          </div>
          <div>
            <span style="font-size:9px; font-weight:800; color:#888; letter-spacing:1px; display:block; margin-bottom:4px;">SHOOT</span>
            <strong style="color:#000; font-size:12px;">${text('project.projectTitle', s.project.projectTitle || '—')}</strong>
          </div>
          <div>
            <span style="font-size:9px; font-weight:800; color:#888; letter-spacing:1px; display:block; margin-bottom:4px;">ISSUED</span>
            <span style="color:#222;">${text('project.invoiceDate', s.project.invoiceDate || '—')}</span>
          </div>
          <div>
            <span style="font-size:9px; font-weight:800; color:#888; letter-spacing:1px; display:block; margin-bottom:4px;">DUE</span>
            <strong style="color:#000;">${text('project.dueDate', s.project.dueDate || '—')}</strong>
          </div>
        </div>

        ${laborTable}
        ${expenseTable}
        ${totalBlock}
        ${paymentDetails}
        ${notes}
        ${receiptGallery}

        <footer class="invoice-footer" style="margin-top:36px; padding-top:14px; border-top:1px solid #000; font-size:9px; color:#555; letter-spacing:1px; text-transform:uppercase;">
          <span>${e(s.project.invoiceNumber)}</span>
          <span>${e(s.contractor.footer || '')}</span>
        </footer>
      </article>
    `;
  }

  // PRESET 3: COMMERCIAL
  if (currentPresetId === 'traditional') {
    return `
      <article class="invoice-paper-layout traditional-theme" style="border:1px solid #111; padding:28px; border-radius:0;">
        <div style="text-align:center; border-bottom:2px solid #111; padding-bottom:14px; margin-bottom:20px;">
          <h1 style="font-size:22px; font-weight:800; letter-spacing:2px; margin-bottom:4px;">${label('invoiceTitle')}</h1>
          <p style="font-size:12px; color:#444;">${text('contractor.name', s.contractor.name)} · ${text('contractor.address', s.contractor.address)}</p>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; border:1px solid #ddd; padding:12px 16px; margin-bottom:20px; font-size:11px; gap:20px;">
          <div style="border-right:1px solid #eee; padding-right:12px;">
            <p style="margin-bottom:4px;"><strong style="margin-right:6px;">To:</strong> ${text('project.clientName', s.project.clientName)}</p>
            <p style="margin-bottom:4px;"><strong style="margin-right:6px;">Address:</strong> ${text('project.clientAddress', s.project.clientAddress)}</p>
            <p><strong style="margin-right:6px;">Shoot:</strong> ${text('project.projectTitle', s.project.projectTitle)}</p>
          </div>
          <div>
            <p style="margin-bottom:4px;"><strong style="margin-right:6px;">Invoice #:</strong> ${text('project.invoiceNumber', s.project.invoiceNumber)}</p>
            <p style="margin-bottom:4px;"><strong style="margin-right:6px;">Issue Date:</strong> ${text('project.invoiceDate', s.project.invoiceDate)}</p>
            <p><strong style="margin-right:6px;">Due Date:</strong> ${text('project.dueDate', s.project.dueDate)}</p>
          </div>
        </div>

        ${laborTable}
        ${expenseTable}
        ${totalBlock}
        ${paymentDetails}
        ${notes}
        ${receiptGallery}

        <div style="text-align:center; margin-top:28px; border-top:1px dotted #999; padding-top:10px; font-size:9px; color:#666; letter-spacing:1px; text-transform:uppercase;">
          ${e(s.contractor.footer || '')}
        </div>
      </article>
    `;
  }

  // PRESET 4: FIELD LEDGER
  return `
    <article class="invoice-paper-layout receipt-heavy-theme">
      <div style="background:#111; color:#fff; padding:6px 12px; font-family:var(--font-accent, monospace); font-size:11px; font-weight:700; display:flex; justify-content:space-between; margin-bottom:18px;">
        <span>EXPENSE CLAIM & INVOICE</span>
        <span>REF: ${text('project.invoiceNumber', s.project.invoiceNumber)}</span>
      </div>

      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:20px; font-size:11px;">
        <div style="border:1px solid #333; padding:10px;">
          <span style="color:#777; font-size:8px; font-weight:800; display:block; margin-bottom:4px; letter-spacing:0.5px;">CLAIMANT</span>
          <strong style="display:block; margin-bottom:2px;">${text('contractor.name', s.contractor.name)}</strong>
          <span style="font-size:10px; color:#555;">ID: ${text('contractor.taxId', s.contractor.taxId || 'n/a')}</span>
        </div>
        <div style="border:1px solid #333; padding:10px;">
          <span style="color:#777; font-size:8px; font-weight:800; display:block; margin-bottom:4px; letter-spacing:0.5px;">PRODUCTION</span>
          <strong style="display:block; margin-bottom:2px;">${text('project.clientName', s.project.clientName)}</strong>
          <span style="font-size:10px; color:#555;">${text('project.projectTitle', s.project.projectTitle)}</span>
        </div>
        <div style="border:1px solid #333; padding:10px;">
          <span style="color:#777; font-size:8px; font-weight:800; display:block; margin-bottom:4px; letter-spacing:0.5px;">REMITTANCE</span>
          <strong style="display:block; margin-bottom:2px;">Due: ${text('project.dueDate', s.project.dueDate)}</strong>
          <span style="font-size:10px; color:#555;">${text('contractor.bankName', s.contractor.bankName)}</span>
        </div>
      </div>

      ${laborTable}
      ${expenseTable}
      ${totalBlock}
      ${receiptGallery}
      ${paymentDetails}

      <footer class="invoice-footer" style="margin-top:32px; padding-top:12px; border-top:1px solid #333; display:flex; justify-content:space-between; font-size:9px; color:#888;">
        <span>${e(s.project.invoiceNumber)}</span>
        <span>${e(s.contractor.footer || '')}</span>
      </footer>
    </article>
  `;
}