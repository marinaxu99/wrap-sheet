// Billing formats: everything that is fixed for one client or one hiring studio.
// Built-in formats ship with the site. Client formats (for example a production's own spreadsheet)
// are created on the device from an uploaded .xlsx and can be exported as a .wrapformat.json file.
import { compact, isBillable, byDateTime } from './model.js';

const COMMON_CATEGORIES = ['Gas', 'Meal', 'Toll', 'Parking', 'Transport', 'Supplies', 'Equipment rental', 'Other'];

export const BUILTIN_FORMATS = [
  {
    id: 'generic', kind: 'builtin', name: 'Freelance (generic)',
    description: '',
    categories: COMMON_CATEGORIES,
    defaults: { periodMode: 'range', taxType: 'vat', taxRate: 10, vatOnExpenses: false },
    numbering: { pattern: '', digits: 3 },
    files: { receipt: '{yyyymmdd}_{category}', folder: '{yymmdd}_{name}', pdf: '{invoiceNumber}', xlsx: '{invoiceNumber}', log: '{yyyymm}_expense_log' },
    memo: 'category', returnLabel: 'return', timeZone: 'Asia/Seoul', strict: false
  },
  {
    id: 'arki-crew', kind: 'builtin', crew: true, name: 'arki pictures — crew invoice',
    description: '',
    categories: ['Fuel', 'Toll', 'Parking', 'Meal', 'Transport', 'Lodging', 'Supplies', 'Equipment rental', 'Other'],
    defaults: {
      clientName: 'arki pictures',
      clientAddress: 'Admin Building 2F, #202, 33 Baekseokgongdan 6-gil, Seobuk-gu, Cheonan-si, Chungcheongnam-do, 31094',
      periodMode: 'range', termsPreset: 'net_15', taxType: 'withholding', taxRate: 3.3, vatOnExpenses: false,
      notes: 'Submitted with WrapSheet. All receipts attached.'
    },
    numbering: { pattern: 'arki-{yyyymm}-{name}', digits: 3 },
    files: { receipt: '{yyyymmdd}_{category}', folder: '{yymmdd}_{name}', pdf: '{invoiceNumber}', xlsx: '{invoiceNumber}', log: '{yyyymm}_expense_log', package: '{yymmdd}_{name}_{project}' },
    memo: 'category', returnLabel: 'return', timeZone: 'Asia/Seoul',
    strict: true,
    entityTypes: {
      freelancer: { label: 'Freelancer (individual, no business registration)', taxType: 'withholding', taxRate: 3.3, note: '3.3% is withheld from your fee. arki pictures will ask for your resident registration number separately.' },
      business: { label: 'Registered business (general VAT)', taxType: 'vat', taxRate: 10, note: '10% VAT is added. Issue a 세금계산서 after approval.' },
      business_simplified: { label: 'Registered business (simplified taxpayer)', taxType: 'none', taxRate: 0, note: 'No VAT added. If you can issue a 세금계산서, choose general VAT.' }
    },
    required: ['contractor.name', 'contractor.role', 'contractor.email', 'contractor.phone', 'contractor.bankName', 'contractor.accountHolder', 'contractor.accountNumber', 'project.projectTitle']
  }
];

export const isSheetFormat = f => f?.kind === 'sheet';

export function findFormat(formats, id) {
  return formats.find(f => f.id === id) || BUILTIN_FORMATS.find(f => f.id === id) || BUILTIN_FORMATS[0];
}

/** Fill a pattern such as "arki_NHL_#{num}" or "{yymmdd}_{name}". */
export function fillPattern(pattern, state, format, extra = {}) {
  const p = state.project, now = new Date();
  const period = (p.periodMode === 'month' ? p.month : (p.shootEnd || p.invoiceDate || '').slice(0, 7)) || '';
  const tokens = {
    num: String(p.sequence || 1).padStart(format?.numbering?.digits || 3, '0'),
    invoiceNumber: p.invoiceNumber?.trim() || p.defaultInvoiceNumber || 'invoice',
    yyyymm: period.replace('-', ''), yyyy: period.slice(0, 4), mm: period.slice(5, 7),
    yymmdd: compact(extra.today || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`).slice(2),
    name: state.contractor.name || 'Name', project: p.projectTitle || 'Project', client: p.clientName || 'Client',
    labor: state.labor[0]?.description || 'Service', ...extra
  };
  return String(pattern || '').replace(/{(\w+)}/g, (m, k) => tokens[k] ?? m);
}

export const safeFileName = s => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+$/,'').slice(0, 150) || 'file';

/**
 * Receipt file names: yyyymmdd_category.pdf, numbered _1, _2 … in time order when a day has several.
 * Statements (Hi-pass) keep their original file name. Returns Map receiptId -> name.
 */
export function receiptFileNames(state, format) {
  const pattern = format.files?.receipt || '{yyyymmdd}_{category}';
  const firstLine = new Map();
  for (const r of state.expenses.filter(r => isBillable(r) && r.receiptId).sort(byDateTime)) if (!firstLine.has(r.receiptId)) firstLine.set(r.receiptId, r);
  const names = new Map(), groups = new Map();
  for (const [rid, r] of firstLine) {
    if (r.source === 'hipass') { names.set(rid, r._fileName || null); continue; }
    const base = safeFileName(pattern.replace('{yyyymmdd}', compact(r.date) || 'nodate').replace('{category}', (r.category || 'other').toLowerCase().replace(/\s+/g, '-')).replace('{vendor}', r.vendor || ''));
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push([rid, r]);
  }
  for (const [base, list] of groups) {
    list.sort((a, b) => byDateTime(a[1], b[1]));
    list.forEach(([rid], i) => names.set(rid, list.length > 1 ? `${base}_${i + 1}.pdf` : `${base}.pdf`));
  }
  return names;
}

export function memoFor(r, format) {
  if (format.memo === 'vendor') return r.vendor;
  if (format.memo === 'category-vendor') return [r.category, r.vendor].filter(Boolean).join(' — ');
  return r.category || 'Other';
}

/** Problems that should block a strict (crew) submission, or warn on a personal format. */
export function checklist(state, format, { hasFile = () => true } = {}) {
  const issues = [];
  const get = path => path.split('.').reduce((o, k) => o?.[k], state);
  for (const path of format.required || []) if (!String(get(path) ?? '').trim()) issues.push({ level: 'block', text: `Missing: ${path.split('.').pop().replace(/([A-Z])/g, ' $1').toLowerCase()}.` });
  if (format.crew && state.contractor.entityType !== 'freelancer' && !state.contractor.taxId.trim()) issues.push({ level: 'block', text: 'Registered businesses must enter their business registration number.' });
  const pending = state.expenses.filter(r => r.status === 'pending').length;
  const check = state.expenses.filter(r => r.status === 'check').length;
  if (pending) issues.push({ level: format.strict ? 'block' : 'warn', text: `${pending} receipt${pending > 1 ? 's' : ''} not reviewed (not billed).` });
  if (check) issues.push({ level: format.strict ? 'block' : 'warn', text: `${check} flagged item${check > 1 ? 's' : ''} billed. Confirm before sending.` });
  const p = state.project, start = p.shootStart, end = p.shootEnd;
  const outside = state.expenses.filter(r => isBillable(r) && r.date && start && end && (r.date < start || r.date > end));
  if (outside.length) issues.push({ level: 'warn', text: `${outside.length} billed item${outside.length > 1 ? 's fall' : ' falls'} outside ${start} – ${end}.` });
  const noFile = state.expenses.filter(r => isBillable(r) && (!r.receiptId || !hasFile(r.receiptId)) && !r.notes.trim());
  if (noFile.length) issues.push({ level: format.strict ? 'block' : 'warn', text: `${noFile.length} billed item${noFile.length > 1 ? 's have' : ' has'} no receipt or note.` });
  const seen = new Map();
  for (const r of state.expenses.filter(isBillable)) {
    if (r.source === 'hipass') continue;
    const k = `${r.date}|${r.total}|${(r.vendor || '').trim()}`;
    if (seen.has(k)) issues.push({ level: 'warn', text: `Possible duplicate: ${r.vendor} ${r.date} ${r.total}.` });
    seen.set(k, r);
  }
  if (!state.labor.length && format.crew) issues.push({ level: 'block', text: 'Add at least one work line (day rate, prep, travel…).' });
  return issues;
}

export function exportFormat(format) {
  return JSON.stringify({ wrapsheetFormat: 1, exportedAt: new Date().toISOString(), format }, null, 1);
}

export function importFormat(text) {
  const data = JSON.parse(text);
  if (data?.wrapsheetFormat !== 1 || !data.format?.name) throw new Error('This is not a WrapSheet format file.');
  return { ...data.format, id: data.format.id?.startsWith('fmt-') ? data.format.id : `fmt-${crypto.randomUUID()}` };
}
