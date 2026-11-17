// Deliverables: receipt PDFs with standard names, the expense log, Google Sheets rows, zip bundles.
import { zipSync, unzipSync, strToU8, strFromU8 } from './vendor/fflate.js';
import { isBillable, byDateTime, compact, totals, round } from './model.js';
import { receiptFileNames, memoFor, safeFileName, fillPattern } from './formats.js';

export function download(bytes, name, type = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let pdfLib;
const loadPdfLib = async () => (pdfLib ||= await import('./vendor/pdf-lib.esm.js'));

/** An image receipt becomes a one-page PDF sized to the photo. */
export async function imageToPdf(dataUrl) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), c => c.charCodeAt(0));
  const img = dataUrl.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const maxW = 595, scale = Math.min(1, maxW / img.width);
  const page = doc.addPage([img.width * scale, img.height * scale]);
  page.drawImage(img, { x: 0, y: 0, width: img.width * scale, height: img.height * scale });
  return doc.save();
}

/** Billable receipts as [{name, bytes, receiptId}] using the format's naming rule. */
export async function receiptFiles(state, format, getRecord) {
  const names = receiptFileNames(state, format);
  const out = [], used = new Set();
  for (const [rid, name] of names) {
    const rec = await getRecord(rid);
    if (!rec) continue;
    let fileName = name || safeFileName(rec.name || `${rid}.pdf`);
    if (!/\.pdf$/i.test(fileName)) fileName = fileName.replace(/\.[^.]+$/, '') + '.pdf';
    while (used.has(fileName)) fileName = fileName.replace(/(\.pdf)$/i, '_copy$1');
    used.add(fileName);
    const bytes = rec.original && rec.mime === 'application/pdf' ? new Uint8Array(rec.original) : await imageToPdf(rec.imageFull);
    out.push({ name: fileName, bytes, receiptId: rid });
  }
  return out;
}

/** File name a billable line will carry, for display in the receipt list. */
export function fileNameFor(r, state, format, records) {
  if (!r.receiptId) return '';
  const names = receiptFileNames(state, format);
  return names.get(r.receiptId) || records.get(r.receiptId)?.name || '';
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Expense log, one row per item (Hi-pass: one row per trip). UTF-8 with BOM so Excel reads Korean. */
export function expenseLogCSV(state, format, records) {
  const names = receiptFileNames(state, format);
  const c = state.project.currency;
  const header = ['Date', 'Time', 'Category', 'Vendor', 'Location', `Amount (${c})`, 'Paid by', 'File', 'Shoot day', 'Notes', 'Status'];
  const rows = state.expenses.filter(r => r.status !== 'excluded').sort(byDateTime).map(r => [
    r.date, r.time, r.category, r.vendor, r.location, r.total, r.paidBy,
    r.receiptId ? (names.get(r.receiptId) || records.get(r.receiptId)?.name || '') : '',
    r.shootDay, r.notes,
    r.status === 'pending' ? 'to review (not billed)' : r.status === 'check' ? 'flagged' : 'looks right'
  ]);
  return '﻿' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Lines in invoice order: work first, then billable expenses by date and time. */
export function invoiceLines(state, format) {
  const p = state.project, fx = format.sheet?.mapping?.fixed || {};
  const period = `${compact(p.shootStart)} - ${compact(p.shootEnd)}`;
  const labor = state.labor.map(l => ({
    kind: 'labor', date: p.periodMode === 'month' ? period : (l.date ? compact(l.date) : period),
    project: fx.project || '', memo: l.description, costCentre: fx.costCentre || '', qty: Number(l.quantity) || 0, rate: Number(l.rate) || 0, currency: fx.currency || p.currency
  }));
  const expenses = state.expenses.filter(isBillable).sort(byDateTime).map(r => ({
    kind: 'expense', date: compact(r.date), project: fx.project || '', memo: memoFor(r, format), costCentre: fx.costCentre || '', qty: 1, rate: Number(r.total) || 0, currency: fx.currency || r.currency || p.currency
  }));
  return [...labor, ...expenses];
}

/** Rows for pasting over the expense section of an existing Google Sheet (tab separated + HTML table). */
export function sheetRowsForPaste(state, format, { includeLabor = false } = {}) {
  const map = format.sheet?.mapping;
  const lines = invoiceLines(state, format).filter(l => includeLabor || l.kind === 'expense');
  const order = map ? Object.entries(map.cols).sort((a, b) => a[1].localeCompare(b[1], 'en', { numeric: true })).map(([k]) => k) : ['date', 'project', 'memo', 'costCentre', 'qty', 'rate', 'currency', 'amount'];
  const cell = (l, k) => k === 'amount' ? round(l.qty * l.rate, state.project.currency) : l[k] ?? '';
  const rows = lines.map(l => order.map(k => cell(l, k)));
  const tsv = rows.map(r => r.join('\t')).join('\n');
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<table>${rows.map(r => `<tr>${r.map((v, i) => `<td${order[i] === 'date' ? ' style="mso-number-format:\'@\'"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  return { tsv, html, count: rows.length, columns: order };
}

export async function copyRich({ tsv, html }) {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([tsv], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
  } else await navigator.clipboard.writeText(tsv);
}

export function zip(entries) {
  const tree = {};
  for (const { path, bytes } of entries) tree[path] = [bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { level: /\.(pdf|jpe?g|png|zip|xlsx)$/i.test(path) ? 0 : 6 }];
  return zipSync(tree);
}

export const fileNames = (state, format) => ({
  folder: safeFileName(fillPattern(format.files?.folder || '{yymmdd}_{name}', state, format)),
  pdf: safeFileName(fillPattern(format.files?.pdf || '{invoiceNumber}', state, format)) + '.pdf',
  xlsx: safeFileName(fillPattern(format.files?.xlsx || '{invoiceNumber}', state, format)) + '.xlsx',
  log: safeFileName(fillPattern(format.files?.log || '{yyyymm}_expense_log', state, format)) + '.csv',
  package: safeFileName(fillPattern(format.files?.package || '{yymmdd}_{name}_{project}', state, format)) + '.zip'
});

// ---- Crew submission package --------------------------------------------------------------------
export const SUBMISSION_FILE = 'submission.wrapsheet.json';

export function submissionManifest(state, format, files) {
  const t = totals(state);
  const byId = Object.fromEntries(files.map(f => [f.receiptId, f.name]));
  const clean = structuredClone(state);
  delete clean.contractor.logo;
  clean.review = null;
  return {
    wrapsheetSubmission: 1, createdAt: new Date().toISOString(), formatId: format.id, formatName: format.name,
    claimed: { labor: t.labor, tax: t.tax, expenses: t.expenses, total: t.total, count: t.count, taxType: state.project.taxType, taxRate: state.project.taxRate },
    files: byId, state: clean
  };
}

/** Read a crew package back. Returns { manifest, files: Map(name -> bytes) }. */
export function readSubmission(bytes) {
  const entries = unzipSync(new Uint8Array(bytes));
  const manifestPath = Object.keys(entries).find(p => p.endsWith(SUBMISSION_FILE));
  if (!manifestPath) throw new Error('This zip is not a WrapSheet submission package (no submission.wrapsheet.json).');
  const manifest = JSON.parse(strFromU8(entries[manifestPath]));
  if (manifest.wrapsheetSubmission !== 1) throw new Error('Unsupported submission version.');
  const files = new Map(Object.entries(entries).filter(([p]) => /\/receipts\/[^/]+$/.test(p) || /^receipts\/[^/]+$/.test(p)).map(([p, b]) => [p.split('/').pop(), b]));
  return { manifest, files };
}

export { strToU8 };
