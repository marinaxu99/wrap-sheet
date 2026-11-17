// Client spreadsheet formats.
// Reads a client's own .xlsx invoice (for example one downloaded from Google Sheets), finds its line table,
// header fields and totals, then writes a new month into a copy of that exact file.
// The workbook is edited at the XML level, so styles, table styles, theme colours and column widths
// survive untouched. Only the cells WrapSheet owns change.
import { unzipSync, zipSync, strFromU8, strToU8 } from './vendor/fflate.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const parseXML = text => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The spreadsheet could not be read (damaged XML).');
  return doc;
};
const serialize = doc => new XMLSerializer().serializeToString(doc);
const kids = (el, name) => el ? [...el.children].filter(c => c.localName === name) : [];
const kid = (el, name) => kids(el, name)[0] || null;
const deep = (el, name) => el ? [...el.getElementsByTagNameNS('*', name)] : [];
const textOf = el => deep(el, 't').map(t => t.textContent).join('') || (el?.localName === 't' ? el.textContent : '');

// ---- Cell references -------------------------------------------------------------------------
export const colToNum = col => [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const numToCol = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
export const splitRef = ref => { const m = String(ref).match(/^\$?([A-Z]{1,3})\$?(\d+)$/); return m ? { col: m[1], row: Number(m[2]) } : null; };

const REF = /(?<![A-Za-z0-9_.$])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?(?![A-Za-z0-9_(])/g;

/** Rewrite references in a formula. mapRow(row, part) where part is 'single' | 'start' | 'end'. */
export function rewriteFormula(formula, sheetName, mapRow, shiftCol = 0) {
  const sameSheet = prefix => !prefix || prefix.replace(/^'|'!$|!$/g, '').replace(/''/g, "'") === sheetName;
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => i % 2 ? part : part.replace(REF, (m, prefix, d1, c1, d2, r1, d3, c2, d4, r2) => {
    if (!sameSheet(prefix)) return m;
    const col = (c, abs) => abs || !shiftCol ? c : numToCol(colToNum(c) + shiftCol);
    if (r2 === undefined) return `${prefix || ''}${d1}${col(c1, d1)}${d2}${d2 ? r1 : mapRow(Number(r1), 'single')}`;
    return `${prefix || ''}${d1}${col(c1, d1)}${d2}${d2 ? r1 : mapRow(Number(r1), 'start')}:${d3}${col(c2, d3)}${d4}${d4 ? r2 : mapRow(Number(r2), 'end')}`;
  })).join('');
}

// ---- Reading a workbook ------------------------------------------------------------------------
function readStyles(text) {
  if (!text) return { xfs: [], fonts: [], fills: [], borders: [], numFmts: {}, dxfs: [], tableStyles: {} };
  const doc = parseXML(text), root = doc.documentElement;
  const color = el => el ? { rgb: el.getAttribute('rgb'), theme: el.getAttribute('theme'), tint: Number(el.getAttribute('tint') || 0) } : null;
  const numFmts = Object.fromEntries(kids(kid(root, 'numFmts'), 'numFmt').map(n => [n.getAttribute('numFmtId'), n.getAttribute('formatCode')]));
  const fonts = kids(kid(root, 'fonts'), 'font').map(f => ({
    b: Boolean(kid(f, 'b')) && kid(f, 'b').getAttribute('val') !== '0', i: Boolean(kid(f, 'i')), u: Boolean(kid(f, 'u')),
    sz: Number(kid(f, 'sz')?.getAttribute('val') || 10), color: color(kid(f, 'color')), name: kid(f, 'name')?.getAttribute('val') || 'Arial'
  }));
  const fillOf = f => { const p = kid(f, 'patternFill'); return p && p.getAttribute('patternType') === 'solid' ? color(kid(p, 'fgColor')) : null; };
  const fills = kids(kid(root, 'fills'), 'fill').map(fillOf);
  const borders = kids(kid(root, 'borders'), 'border').map(b => Object.fromEntries(['left', 'right', 'top', 'bottom'].map(side => {
    const e = kid(b, side); return [side, e?.getAttribute('style') ? { style: e.getAttribute('style'), color: color(kid(e, 'color')) } : null];
  })));
  const xfs = kids(kid(root, 'cellXfs'), 'xf').map(x => {
    const a = kid(x, 'alignment');
    return {
      numFmtId: x.getAttribute('numFmtId') || '0', fontId: Number(x.getAttribute('fontId') || 0), fillId: Number(x.getAttribute('fillId') || 0),
      borderId: Number(x.getAttribute('borderId') || 0), h: a?.getAttribute('horizontal') || '', v: a?.getAttribute('vertical') || 'bottom', wrap: a?.getAttribute('wrapText') === '1'
    };
  });
  const dxfs = kids(kid(root, 'dxfs'), 'dxf').map(d => ({ fill: fillOf(kid(d, 'fill')), font: kid(d, 'font') ? { b: Boolean(kid(kid(d, 'font'), 'b')), color: color(kid(kid(d, 'font'), 'color')) } : null }));
  const tableStyles = Object.fromEntries(kids(kid(root, 'tableStyles'), 'tableStyle').map(t => [t.getAttribute('name'),
  Object.fromEntries(kids(t, 'tableStyleElement').map(e => [e.getAttribute('type'), dxfs[Number(e.getAttribute('dxfId'))]]))]));
  return { xfs, fonts, fills, borders, numFmts, dxfs, tableStyles };
}

function readTheme(text) {
  if (!text) return [];
  const doc = parseXML(text);
  const scheme = deep(doc, 'clrScheme')[0];
  if (!scheme) return [];
  const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const byName = Object.fromEntries([...scheme.children].map(c => {
    const v = c.firstElementChild; return [c.localName, v?.getAttribute('lastClr') || v?.getAttribute('val') || '000000'];
  }));
  return order.map(n => byName[n] || '000000');
}

const resolvePath = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
};
const relsPathOf = path => path.replace(/([^/]+)$/, '_rels/$1.rels');
function readRels(files, path) {
  const text = files[relsPathOf(path)];
  if (!text) return [];
  return kids(parseXML(strFromU8(text)).documentElement, 'Relationship').map(r => ({ id: r.getAttribute('Id'), type: r.getAttribute('Type'), target: resolvePath(path, r.getAttribute('Target')) }));
}

/** Parse the parts WrapSheet needs. `files` is the fflate unzip map. */
export function readBook(files, preferredSheet) {
  const wbPath = 'xl/workbook.xml';
  if (!files[wbPath]) throw new Error('This file is not an .xlsx workbook.');
  const wb = parseXML(strFromU8(files[wbPath]));
  const rels = readRels(files, wbPath);
  const sheets = deep(wb, 'sheet').map(s => ({ name: s.getAttribute('name'), path: rels.find(r => r.id === s.getAttributeNS(RNS, 'id') || r.id === s.getAttribute('r:id'))?.target }));
  const sheet = sheets.find(s => s.name === preferredSheet) || sheets[0];
  if (!sheet?.path || !files[sheet.path]) throw new Error('The workbook has no readable sheet.');
  const shared = files['xl/sharedStrings.xml'] ? kids(parseXML(strFromU8(files['xl/sharedStrings.xml'])).documentElement, 'si').map(textOf) : [];
  const styles = readStyles(files['xl/styles.xml'] && strFromU8(files['xl/styles.xml']));
  const themePath = rels.find(r => r.type.endsWith('/theme'))?.target;
  const theme = readTheme(themePath && files[themePath] && strFromU8(files[themePath]));
  const doc = parseXML(strFromU8(files[sheet.path]));
  const cells = new Map(), rows = new Map();
  for (const row of deep(doc, 'row')) {
    const r = Number(row.getAttribute('r'));
    rows.set(r, { ht: Number(row.getAttribute('ht')) || null });
    for (const c of kids(row, 'c')) {
      const ref = c.getAttribute('r'), t = c.getAttribute('t'), v = kid(c, 'v')?.textContent ?? null, f = kid(c, 'f');
      let value = v;
      if (t === 's') value = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') value = textOf(kid(c, 'is'));
      else if (t === 'b') value = v === '1';
      else if (t === 'str' || t === 'e') value = v ?? '';
      else if (v !== null && v !== '') value = Number(v);
      cells.set(ref, { ref, s: Number(c.getAttribute('s') || 0), t, value, formula: f ? (f.textContent || null) : null, shared: f?.getAttribute('t') === 'shared' ? { si: f.getAttribute('si'), ref: f.getAttribute('ref') } : null });
    }
  }
  const cols = kids(kid(doc.documentElement, 'cols'), 'col').map(c => ({ min: Number(c.getAttribute('min')), max: Number(c.getAttribute('max')), width: Number(c.getAttribute('width')), hidden: c.getAttribute('hidden') === '1' }));
  const sheetRels = readRels(files, sheet.path);
  const tables = kids(kid(doc.documentElement, 'tableParts'), 'tablePart').map(tp => {
    const path = sheetRels.find(r => r.id === (tp.getAttributeNS(RNS, 'id') || tp.getAttribute('r:id')))?.target;
    if (!path || !files[path]) return null;
    const t = parseXML(strFromU8(files[path])).documentElement, info = kid(t, 'tableStyleInfo');
    return { path, ref: t.getAttribute('ref'), headerRowCount: Number(t.getAttribute('headerRowCount') ?? 1), style: info?.getAttribute('name') || '', rowStripes: info?.getAttribute('showRowStripes') === '1' };
  }).filter(Boolean);
  const gridLines = deep(doc, 'sheetView')[0]?.getAttribute('showGridLines') !== '0';
  const fmt = deep(doc, 'sheetFormatPr')[0];
  const defaultColWidth = Number(fmt?.getAttribute('defaultColWidth')) || (Number(fmt?.getAttribute('baseColWidth')) || 8) + 0.63;
  const defaultRowHeight = Number(fmt?.getAttribute('defaultRowHeight')) || 12.75;
  return { sheets, sheet, cells, rows, cols, styles, theme, tables, gridLines, shared, defaultColWidth, defaultRowHeight };
}

const str = cell => cell == null || cell.value == null ? '' : String(cell.value).trim();

// ---- Detecting the invoice layout --------------------------------------------------------------
const COLUMN_RULES = {
  date: /^date\b|^날짜|^일자|^일시/i,
  project: /^project|^job\b|^프로젝트|^작품/i,
  memo: /memo|description|^item|^details?$|내역|품목|적요/i,
  costCentre: /cost\s*cent|^cc\b|코스트/i,
  qty: /duration|^qty|quantity|^days?$|^units?$|수량|일수/i,
  rate: /^rate|unit\s*price|^price|단가/i,
  currency: /currency|통화/i,
  amount: /^total|^amount|금액|합계|^line\s*total/i
};
const LABEL_RULES = {
  invoiceDate: /invoice\s*date|date\s*of\s*invoice|발행\s*일|청구\s*일|작성\s*일/i,
  invoiceNumber: /invoice\s*(no|number|#)|청구서\s*번호|invoice\s*id/i,
  dueDate: /due\s*date|payment\s*due|지급\s*기한/i,
  location: /location|site\s*of\s*services|촬영\s*지/i,
  po: /^po\b|p\.o\.|purchase\s*order/i,
  terms: /payment\s*terms/i,
  partner: /business\s*partner|attention|attn|담당/i
};
const TOTAL_RULES = [
  ['total', /total\s*due|amount\s*due|grand\s*total|balance\s*due|^total$|총\s*(청구|합계)|청구\s*금액/i],
  ['tax', /^vat|tax|부가세|withholding|원천/i],
  ['expenses', /expense|reimburs|실비/i],
  ['labor', /service\s*fee|^fees?$|labou?r|subtotal|용역|^work/i]
];

export function analyzeBook(book) {
  const { cells } = book;
  const byRow = new Map();
  for (const c of cells.values()) { const { row } = splitRef(c.ref); if (!byRow.has(row)) byRow.set(row, []); byRow.get(row).push(c); }
  let header = null;
  for (const [row, list] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const cols = {};
    for (const c of list) for (const [key, re] of Object.entries(COLUMN_RULES)) if (!cols[key] && typeof c.value === 'string' && re.test(c.value.trim())) cols[key] = splitRef(c.ref).col;
    if (cols.amount && Object.keys(cols).length >= 3) { header = { row, cols }; break; }
  }
  if (!header) throw new Error('Could not find the line table. The header row needs at least a description, a rate or quantity, and a TOTAL / AMOUNT column.');
  const mapped = Object.values(header.cols);
  const lineHas = r => mapped.some(col => str(cells.get(`${col}${r}`)) !== '' || cells.get(`${col}${r}`)?.formula);
  const firstRow = header.row + 1;
  let lastRow = header.row;
  for (let r = firstRow; r < firstRow + 2000 && lineHas(r); r++) lastRow = r;
  if (lastRow < firstRow) lastRow = firstRow;   // empty template: one styled row is still needed
  const table = book.tables.find(t => { const [a, b] = t.ref.split(':').map(splitRef); return a && b && a.row === header.row; }) || null;
  if (table) lastRow = Math.max(lastRow, splitRef(table.ref.split(':')[1]).row);

  // Header fields: a label, then its value in the next cell(s) to the right.
  const cellsList = [...cells.values()];
  const fields = {};
  for (const c of cellsList) {
    const { col, row } = splitRef(c.ref);
    if (row >= header.row || typeof c.value !== 'string') continue;
    for (const [key, re] of Object.entries(LABEL_RULES)) {
      if (fields[key] || !re.test(c.value.trim())) continue;
      const n = colToNum(col);
      let target = `${numToCol(n + 1)}${row}`;
      for (let k = 1; k <= 3; k++) { const ref = `${numToCol(n + k)}${row}`; if (cells.has(ref)) { target = ref; break; } }
      fields[key] = target;
    }
  }
  // Totals block below the table.
  const totals = {};
  for (const c of cellsList) {
    const { row } = splitRef(c.ref);
    if (row <= lastRow || typeof c.value !== 'string') continue;
    for (const [key, re] of TOTAL_RULES) {
      if (totals[key] || !re.test(c.value.trim())) continue;
      const amountRef = `${header.cols.amount}${row}`;
      const rowCells = cellsList.filter(x => splitRef(x.ref).row === row && (x.formula || typeof x.value === 'number'));
      totals[key] = cells.get(amountRef)?.formula || typeof cells.get(amountRef)?.value === 'number' ? amountRef : rowCells.at(-1)?.ref;
      break;
    }
  }
  if (header.cols.qty) {
    const count = cellsList.find(c => c.formula && splitRef(c.ref).row > lastRow && splitRef(c.ref).col === header.cols.qty && /sum\(/i.test(c.formula));
    if (count) totals.count = count.ref;
  }
  const first = col => col ? str(cells.get(`${col}${firstRow}`)) : '';
  const taxFormula = totals.tax ? cells.get(totals.tax)?.formula || '' : '';
  // VAT on expenses when the tax formula covers the whole line table, or points at the expenses total.
  const vatOnExpenses = new RegExp(`${header.cols.amount}\\$?${firstRow}:\\$?${header.cols.amount}\\$?${lastRow}`, 'i').test(taxFormula)
    || Boolean(totals.expenses && new RegExp(`\\b${totals.expenses}\\b`, 'i').test(taxFormula));
  const pct = taxFormula.match(/\*\s*(\d+(?:\.\d+)?)\s*%/), dec = taxFormula.match(/\*\s*(0?\.\d+)/);
  const taxRate = pct ? Number(pct[1]) : dec ? Math.round(Number(dec[1]) * 1000) / 10 : 10;
  const maxCol = Math.max(...cellsList.map(c => colToNum(splitRef(c.ref).col)), ...book.cols.map(c => Math.min(c.max, 26)));
  return {
    sheet: book.sheet.name, headerRow: header.row, firstRow, lastRow, cols: header.cols,
    laborStyleRow: firstRow, expenseStyleRow: lastRow > firstRow ? firstRow + 1 : firstRow,
    fixed: { project: first(header.cols.project), costCentre: first(header.cols.costCentre), currency: first(header.cols.currency) || 'KRW' },
    fields, totals, maxCol: Math.min(maxCol, 26), table: table ? table.ref : '',
    guess: {
      vatOnExpenses, taxRate,
      invoiceNumber: fields.invoiceNumber ? str(cells.get(fields.invoiceNumber)) : '',
      location: fields.location ? str(cells.get(fields.location)) : '',
      terms: fields.terms ? str(cells.get(fields.terms)) : '',
      po: fields.po ? str(cells.get(fields.po)) : '',
      laborMemo: first(header.cols.memo), laborRate: Number(cells.get(`${header.cols.rate}${firstRow}`)?.value) || 0,
      clientName: (() => { const bill = cellsList.find(c => /^bill\s*to/i.test(str(c))); if (!bill) return ''; const { col, row } = splitRef(bill.ref); return str(cells.get(`${col}${row + 1}`)); })()
    },
    vatFormula: taxFormula
  };
}

// ---- Writing a new invoice into the workbook ---------------------------------------------------
const xmlEscape = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
export const toSerial = iso => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; };

function setValue(doc, c, value, { formula = null } = {}) {
  for (const child of [...c.children]) c.removeChild(child);
  c.removeAttribute('t');
  if (formula !== null) {
    const f = doc.createElementNS(NS, 'f'); f.textContent = formula; c.appendChild(f);
    if (value !== undefined && value !== null && value !== '') {
      if (typeof value === 'string') c.setAttribute('t', 'str');
      const v = doc.createElementNS(NS, 'v'); v.textContent = String(value); c.appendChild(v);
    }
    return;
  }
  if (value === null || value === undefined || value === '') return;
  if (typeof value === 'number') { const v = doc.createElementNS(NS, 'v'); v.textContent = String(value); c.appendChild(v); return; }
  c.setAttribute('t', 'inlineStr');
  const is = doc.createElementNS(NS, 'is'), t = doc.createElementNS(NS, 't');
  t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); t.textContent = String(value); is.appendChild(t); c.appendChild(is);
}

function cellEl(doc, sheetData, ref) {
  const { row } = splitRef(ref);
  let rowEl = kids(sheetData, 'row').find(r => Number(r.getAttribute('r')) === row);
  if (!rowEl) {
    rowEl = doc.createElementNS(NS, 'row'); rowEl.setAttribute('r', row);
    const after = kids(sheetData, 'row').find(r => Number(r.getAttribute('r')) > row);
    sheetData.insertBefore(rowEl, after || null);
  }
  let c = kids(rowEl, 'c').find(x => x.getAttribute('r') === ref);
  if (!c) {
    c = doc.createElementNS(NS, 'c'); c.setAttribute('r', ref);
    const n = colToNum(splitRef(ref).col);
    const after = kids(rowEl, 'c').find(x => colToNum(splitRef(x.getAttribute('r')).col) > n);
    rowEl.insertBefore(c, after || null);
  }
  return c;
}

/** Expand shared formulas into ordinary ones so rows can be moved safely. */
function expandSharedFormulas(doc, sheetName) {
  const masters = new Map();
  for (const f of deep(doc, 'f')) if (f.getAttribute('t') === 'shared' && f.textContent) masters.set(f.getAttribute('si'), { formula: f.textContent, at: splitRef(f.parentElement.getAttribute('r')) });
  for (const f of deep(doc, 'f')) {
    if (f.getAttribute('t') !== 'shared') continue;
    const m = masters.get(f.getAttribute('si')), here = splitRef(f.parentElement.getAttribute('r'));
    if (m) {
      const dr = here.row - m.at.row, dc = colToNum(here.col) - colToNum(m.at.col);
      f.textContent = rewriteFormula(m.formula, sheetName, r => r + dr, dc);
    }
    for (const a of ['t', 'si', 'ref']) f.removeAttribute(a);
  }
}

const shiftSqref = (sqref, mapRow) => sqref.split(/\s+/).map(part => {
  const [a, b] = part.split(':'); const A = splitRef(a), B = b ? splitRef(b) : null;
  if (!A) return part;
  return B ? `${A.col}${mapRow(A.row, 'start')}:${B.col}${mapRow(B.row, 'end')}` : `${A.col}${mapRow(A.row, 'single')}`;
}).join(' ');

/**
 * Build a new .xlsx from the client template.
 * data = { fields: {invoiceDate:'2026-11-30', invoiceNumber, location, dueDate}, lines: [{kind, date, memo, qty, rate, currency, project, costCentre}], results: {labor, expenses, tax, total, count}, roundTax }
 */
export function fillWorkbook(templateBytes, mapping, data) {
  const files = unzipSync(templateBytes);
  const book = readBook(files, mapping.sheet);
  const sheetPath = book.sheet.path, sheetName = book.sheet.name;
  const doc = parseXML(strFromU8(files[sheetPath]));
  const sheetData = deep(doc, 'sheetData')[0];
  expandSharedFormulas(doc, sheetName);

  const { firstRow, lastRow, cols } = mapping;
  const lines = data.lines;
  const newLast = firstRow + Math.max(lines.length, 1) - 1;
  const delta = newLast - lastRow;
  const mapRow = (r, part) => {
    if (r > lastRow) return r + delta;
    if (part === 'end' && r === lastRow) return newLast;
    return r;
  };

  const rowEls = kids(sheetData, 'row');
  const styleRow = r => rowEls.find(x => Number(x.getAttribute('r')) === r)?.cloneNode(true) || null;
  const laborTpl = styleRow(mapping.laborStyleRow), expenseTpl = styleRow(mapping.expenseStyleRow) || laborTpl;

  // 1. Remove the old line rows, shift everything below.
  for (const row of rowEls) {
    const r = Number(row.getAttribute('r'));
    if (r >= firstRow && r <= lastRow) { sheetData.removeChild(row); continue; }
    if (r > lastRow) {
      row.setAttribute('r', r + delta);
      for (const c of kids(row, 'c')) { const ref = splitRef(c.getAttribute('r')); c.setAttribute('r', `${ref.col}${r + delta}`); }
    }
  }
  // 2. Fix every formula in the sheet for the new table length.
  for (const f of deep(doc, 'f')) f.textContent = rewriteFormula(f.textContent, sheetName, mapRow);

  // 3. Write the new lines, styled like the template's first service row and first expense row.
  const before = kids(sheetData, 'row').find(r => Number(r.getAttribute('r')) > newLast) || null;
  lines.forEach((line, i) => {
    const r = firstRow + i, tpl = (line.kind === 'labor' ? laborTpl : expenseTpl);
    const row = tpl ? tpl.cloneNode(true) : doc.createElementNS(NS, 'row');
    row.setAttribute('r', r);
    for (const c of kids(row, 'c')) { c.setAttribute('r', `${splitRef(c.getAttribute('r')).col}${r}`); setValue(doc, c, null); }
    sheetData.insertBefore(row, before);
    const put = (key, value, opts) => { if (cols[key]) setValue(doc, cellEl(doc, sheetData, `${cols[key]}${r}`), value, opts); };
    put('date', line.date);
    put('project', line.project);
    put('memo', line.memo);
    put('costCentre', line.costCentre);
    put('qty', Number(line.qty));
    put('rate', Number(line.rate));
    put('currency', line.currency);
    const amount = Math.round(Number(line.qty) * Number(line.rate) * 100) / 100;
    if (cols.qty && cols.rate) put('amount', amount, { formula: `${cols.qty}${r}*${cols.rate}${r}` });
    else put('amount', amount);
  });

  // 4. Header fields.
  const F = mapping.fields || {};
  const setField = (key, value, isDate) => {
    if (!F[key] || value === undefined || value === null) return;
    // A blank value clears the template's old text (e.g. last month's location).
    setValue(doc, cellEl(doc, sheetData, F[key]), value === '' ? null : isDate ? toSerial(value) : value);
  };
  setField('invoiceDate', data.fields.invoiceDate, true);
  setField('invoiceNumber', data.fields.invoiceNumber);
  setField('location', data.fields.location);
  setField('dueDate', data.fields.dueDate, true);

  // 5. Totals: keep the client's formulas, refresh cached results so viewers that do not recalculate still show the right numbers.
  const T = mapping.totals || {};
  const known = new Set();
  const shifted = ref => { const p = splitRef(ref); return `${p.col}${mapRow(p.row, 'single')}`; };
  for (const [key, ref] of Object.entries(T)) {
    if (!ref || data.results[key] === undefined) continue;
    const at = shifted(ref), c = cellEl(doc, sheetData, at);
    const f = kid(c, 'f');
    let formula = f ? f.textContent : null;
    if (key === 'tax' && formula && data.roundTax && !/^\s*round\(/i.test(formula)) formula = `ROUND(${formula},0)`;
    setValue(doc, c, data.results[key], formula !== null ? { formula } : {});
    known.add(at);
  }
  for (const row of kids(sheetData, 'row')) for (const c of kids(row, 'c')) {
    const f = kid(c, 'f'), v = kid(c, 'v'), r = Number(row.getAttribute('r'));
    if (f && v && !known.has(c.getAttribute('r')) && !(r >= firstRow && r <= newLast)) c.removeChild(v);   // stale cached value
  }

  // 6. Sheet bookkeeping: dimension, merges, conditional formats, validations, hyperlinks.
  const dim = deep(doc, 'dimension')[0];
  if (dim) { const [a, b] = dim.getAttribute('ref').split(':'); if (b) { const B = splitRef(b); dim.setAttribute('ref', `${a}:${B.col}${Math.max(B.row + delta, newLast)}`); } }
  for (const m of deep(doc, 'mergeCell')) m.setAttribute('ref', shiftSqref(m.getAttribute('ref'), mapRow));
  for (const el of [...deep(doc, 'conditionalFormatting'), ...deep(doc, 'dataValidation')]) if (el.getAttribute('sqref')) el.setAttribute('sqref', shiftSqref(el.getAttribute('sqref'), mapRow));
  for (const h of deep(doc, 'hyperlink')) h.setAttribute('ref', shiftSqref(h.getAttribute('ref'), mapRow));
  files[sheetPath] = strToU8(serialize(doc));

  // 7. The line table must cover the new rows, or Google Sheets and Excel lose its header colour and stripes.
  for (const t of book.tables) {
    const tdoc = parseXML(strFromU8(files[t.path])), root = tdoc.documentElement;
    root.setAttribute('ref', shiftSqref(root.getAttribute('ref'), mapRow));
    const af = kid(root, 'autoFilter'); if (af) af.setAttribute('ref', root.getAttribute('ref'));
    files[t.path] = strToU8(serialize(tdoc));
  }
  // 8. Workbook: shift named ranges on this sheet, force recalculation, drop the stale calculation chain.
  const wbDoc = parseXML(strFromU8(files['xl/workbook.xml']));
  for (const dn of deep(wbDoc, 'definedName')) dn.textContent = rewriteFormula(dn.textContent, sheetName, mapRow);
  let calcPr = deep(wbDoc, 'calcPr')[0];
  if (!calcPr) { calcPr = wbDoc.createElementNS(NS, 'calcPr'); wbDoc.documentElement.appendChild(calcPr); }
  calcPr.setAttribute('fullCalcOnLoad', '1');
  files['xl/workbook.xml'] = strToU8(serialize(wbDoc));
  if (files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml'];
    const rp = relsPathOf('xl/workbook.xml'), rels = parseXML(strFromU8(files[rp]));
    for (const r of kids(rels.documentElement, 'Relationship')) if (/calcChain/.test(r.getAttribute('Type'))) r.remove();
    files[rp] = strToU8(serialize(rels));
    const ct = parseXML(strFromU8(files['[Content_Types].xml']));
    for (const o of kids(ct.documentElement, 'Override')) if (/calcChain/.test(o.getAttribute('PartName'))) o.remove();
    files['[Content_Types].xml'] = strToU8(serialize(ct));
  }
  return zipSync(files, { level: 6 });
}

// ---- Rendering a sheet as HTML (preview and PDF) -----------------------------------------------
function hexColor(c, theme) {
  if (!c) return null;
  let hex = c.rgb ? c.rgb.slice(-6) : (c.theme != null && theme[Number(c.theme)]) || null;
  if (!hex) return null;
  if (c.tint) {
    const ch = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).map(v => c.tint < 0 ? v * (1 + c.tint) : v + (255 - v) * c.tint);
    hex = ch.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  return `#${hex}`;
}

const BUILTIN_FMT = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 14: 'm/d/yyyy', 22: 'm/d/yyyy h:mm', 49: '@' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatValue(value, code = 'General') {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'number') return String(value);
  const clean = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '').replace(/\\./g, '');
  if (code === '@') return String(value);
  if (/(d{1,4}|y{2,4})/i.test(clean) && !/[0#]/.test(clean)) {
    const ms = Math.round(value * 86400000) + Date.UTC(1899, 11, 30);
    const d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    if (/mmmm/i.test(clean)) return `${MONTHS[m - 1]} ${day}, ${y}`;
    if (/^m+\/d+\/y+/i.test(clean.trim())) return `${/mm\//i.test(clean) ? String(m).padStart(2, '0') : m}/${/dd/i.test(clean) ? String(day).padStart(2, '0') : day}/${/yyyy/i.test(clean) ? y : String(y).slice(2)}`;
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (/%/.test(clean)) return `${(value * 100).toFixed((clean.split('.')[1] || '').replace(/[^0]/g, '').length)}%`;
  const decimals = (clean.split(';')[0].split('.')[1] || '').replace(/[^0]/g, '').length;
  if (value === 0 && /"-"|\*\s*-/.test(code.split(';')[2] || '')) return '-';
  if (/[#0]/.test(clean)) {
    const s = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: /,/.test(clean) });
    return value < 0 && /\(/.test(code.split(';')[1] || '') ? `(${s})` : (value < 0 ? `-${s}` : s);
  }
  return String(Math.round(value * 1e6) / 1e6);
}

/** Resolve size and per-cell style of the used part of a sheet (shared by the HTML preview and the PDF canvas). */
export function layoutBook(book, { maxCol } = {}) {
  const { cells, styles, theme, cols, rows } = book;
  let lastRow = 0, lastCol = maxCol || 1;
  const hasBorder = c => { const bd = styles.borders[styles.xfs[c.s]?.borderId]; return bd && Object.values(bd).some(Boolean); };
  for (const c of cells.values()) {
    const { col, row } = splitRef(c.ref);
    if (c.value !== null && c.value !== '' || c.formula) { lastRow = Math.max(lastRow, row); if (!maxCol) lastCol = Math.max(lastCol, colToNum(col)); }
  }
  for (const c of cells.values()) { const { row } = splitRef(c.ref); if (row === lastRow + 1 && hasBorder(c)) lastRow = row; }   // closing border of a box
  // Google Sheets exports 100px columns as width 12.63, so one width unit is about 7.92px.
  const widthOf = n => { const c = cols.find(c => n >= c.min && n <= c.max); return c?.hidden ? 0 : Math.round(((c?.width) || book.defaultColWidth) * 7.92); };
  const widths = Array.from({ length: lastCol }, (_, i) => widthOf(i + 1));
  // Rows grow to fit their largest font, as spreadsheet apps do for big titles.
  const fontPx = new Map();
  for (const c of cells.values()) { const { row } = splitRef(c.ref); if (c.value !== null && c.value !== '') fontPx.set(row, Math.max(fontPx.get(row) || 0, (styles.fonts[styles.xfs[c.s]?.fontId]?.sz || 10) * 4 / 3)); }
  const heights = Array.from({ length: lastRow }, (_, i) => Math.max(Math.round((rows.get(i + 1)?.ht || book.defaultRowHeight) * 4 / 3), Math.ceil((fontPx.get(i + 1) || 0) * 1.25)));
  const zones = book.tables.map(t => {
    const [a, b] = t.ref.split(':').map(splitRef);
    return { r1: a.row, r2: b.row, c1: colToNum(a.col), c2: colToNum(b.col), header: t.headerRowCount, style: styles.tableStyles[t.style] || {}, stripes: t.rowStripes };
  });
  const out = [];
  for (let r = 1; r <= lastRow; r++) for (let n = 1; n <= lastCol; n++) {
    const c = cells.get(`${numToCol(n)}${r}`);
    const xf = styles.xfs[c?.s ?? 0] || {};
    const font = styles.fonts[xf.fontId] || {}, bd = styles.borders[xf.borderId] || {};
    let bg = hexColor(styles.fills[xf.fillId], theme), color = hexColor(font.color, theme) || '#000000', bold = font.b;
    const zone = zones.find(z => r >= z.r1 && r <= z.r2 && n >= z.c1 && n <= z.c2);
    if (zone) {   // table styles (header colour, banded rows) as Google Sheets shows them
      if (r < zone.r1 + zone.header) { const h = zone.style.headerRow; if (h?.fill) bg = hexColor(h.fill, theme); if (h?.font?.color) color = hexColor(h.font.color, theme); if (h?.font?.b) bold = true; }
      else if (zone.stripes) { const st = (r - zone.r1 - zone.header) % 2 === 0 ? zone.style.firstRowStripe : zone.style.secondRowStripe; if (st?.fill) bg = hexColor(st.fill, theme); }
    }
    const code = styles.numFmts[xf.numFmtId] || BUILTIN_FMT[xf.numFmtId] || 'General';
    const text = c ? formatValue(c.value, code) : '';
    const numeric = typeof c?.value === 'number' && code !== '@';
    const align = xf.h === 'centerContinuous' ? 'center' : (xf.h && xf.h !== 'general' && xf.h !== 'fill' && xf.h !== 'justify' ? xf.h : (numeric ? 'right' : 'left'));
    const borders = Object.fromEntries(['left', 'right', 'top', 'bottom'].map(side => [side, bd[side] ? { w: bd[side].style === 'medium' ? 2 : bd[side].style === 'thick' ? 3 : 1, color: hexColor(bd[side].color, theme) || '#000000', dash: /dash|dot/.test(bd[side].style) } : null]));
    out.push({ r, n, text, bg, color, bold, italic: font.i, size: font.sz || 10, align, valign: xf.v === 'center' ? 'middle' : xf.v || 'bottom', wrap: xf.wrap || /\n/.test(text), numeric, borders });
  }
  return { widths, heights, cells: out, lastRow, lastCol };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Render the used part of the sheet as a static table that looks like the spreadsheet. */
export function renderBookHTML(book, opts) {
  const L = layoutBook(book, opts);
  let html = `<table class="xlsx-render" style="width:${L.widths.reduce((a, b) => a + b, 0)}px"><colgroup>${L.widths.map(w => `<col style="width:${w}px">`).join('')}</colgroup><tbody>`;
  let k = 0;
  for (let r = 1; r <= L.lastRow; r++) {
    html += `<tr style="height:${L.heights[r - 1]}px">`;
    for (let n = 1; n <= L.lastCol; n++, k++) {
      const c = L.cells[k];
      const css = [`text-align:${c.align}`, `vertical-align:${c.valign}`, `font-size:${c.size}pt`, `color:${c.color}`, c.bold ? 'font-weight:700' : '', c.italic ? 'font-style:italic' : '',
        c.bg ? `background:${c.bg}` : '', c.wrap ? 'white-space:pre-wrap' : 'white-space:nowrap',
        ...Object.entries(c.borders).map(([side, b]) => b ? `border-${side}:${b.w}px ${b.dash ? 'dashed' : 'solid'} ${b.color}` : '')].filter(Boolean).join(';');
      // Unwrapped text spills over empty neighbours, as in a spreadsheet.
      const spill = c.text && !c.wrap && !c.numeric;
      html += `<td style="${css}${spill ? ';position:relative' : ''}">${spill ? `<span class="xl-spill xl-${c.align} xl-v-${c.valign}">${esc(c.text)}</span>` : esc(c.text)}</td>`;
    }
    html += '</tr>';
  }
  return `${html}</tbody></table>`;
}

/** Draw the sheet onto a canvas (used for the PDF; independent of html2canvas). Returns { canvas, rowBottoms, width, height } in CSS px. */
export function renderBookCanvas(book, { maxCol, scale = 2, fontFamily = 'Arial, "Noto Sans KR", WrapKorean, sans-serif' } = {}) {
  const L = layoutBook(book, { maxCol });
  const xs = [0]; for (const w of L.widths) xs.push(xs.at(-1) + w);
  const ys = [0]; for (const h of L.heights) ys.push(ys.at(-1) + h);
  const W = xs.at(-1), H = ys.at(-1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(W * scale); canvas.height = Math.ceil(H * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const box = c => ({ x: xs[c.n - 1], y: ys[c.r - 1], w: L.widths[c.n - 1], h: L.heights[c.r - 1] });
  for (const c of L.cells) if (c.bg) { const b = box(c); ctx.fillStyle = c.bg; ctx.fillRect(b.x, b.y, b.w, b.h); }
  for (const c of L.cells) {
    const b = box(c);
    for (const [side, s] of Object.entries(c.borders)) {
      if (!s) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.w; ctx.setLineDash(s.dash ? [3, 2] : []);
      ctx.beginPath();
      const o = s.w % 2 ? 0.5 : 0;
      if (side === 'left') { ctx.moveTo(b.x + o, b.y); ctx.lineTo(b.x + o, b.y + b.h); }
      if (side === 'right') { ctx.moveTo(b.x + b.w - o, b.y); ctx.lineTo(b.x + b.w - o, b.y + b.h); }
      if (side === 'top') { ctx.moveTo(b.x, b.y + o); ctx.lineTo(b.x + b.w, b.y + o); }
      if (side === 'bottom') { ctx.moveTo(b.x, b.y + b.h - o); ctx.lineTo(b.x + b.w, b.y + b.h - o); }
      ctx.stroke();
    }
  }
  ctx.setLineDash([]); ctx.textBaseline = 'alphabetic';
  for (const c of L.cells) {
    if (!c.text) continue;
    const b = box(c), px = c.size * 4 / 3, pad = 3;
    ctx.font = `${c.italic ? 'italic ' : ''}${c.bold ? '700 ' : ''}${px}px ${fontFamily}`;
    ctx.fillStyle = c.color;
    let lines = String(c.text).split('\n');
    if (c.wrap) {
      const wrapped = [];
      for (const line of lines) {
        let cur = '';
        for (const word of line.split(/(\s+)/)) {
          if (ctx.measureText(cur + word).width > b.w - pad * 2 && cur.trim()) { wrapped.push(cur.trimEnd()); cur = word.trimStart(); } else cur += word;
        }
        wrapped.push(cur);
      }
      lines = wrapped;
    }
    const lineH = px * 1.15, blockH = lines.length * lineH;
    let y = c.valign === 'top' ? b.y + 2 : c.valign === 'middle' ? b.y + (b.h - blockH) / 2 : b.y + b.h - blockH - 2;
    ctx.save();
    if (c.wrap || c.numeric) { ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip(); }   // only unwrapped text may spill
    for (const line of lines) {
      const tw = ctx.measureText(line).width;
      const x = c.align === 'right' ? b.x + b.w - pad - tw : c.align === 'center' ? b.x + (b.w - tw) / 2 : b.x + pad;
      ctx.fillText(line, x, y + px * 0.92);
      y += lineH;
    }
    ctx.restore();
  }
  return { canvas, rowBottoms: ys.slice(1), width: W, height: H };
}

export const loadTemplate = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
export const bytesToBase64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
export const openBook = (bytes, sheet) => readBook(unzipSync(bytes), sheet);

/** Styles the rendered sheet needs; injected once into the page and into PDF exports. */
export const SHEET_CSS = `
.xlsx-render{border-collapse:collapse;table-layout:fixed;font-family:Arial,'Noto Sans KR','WrapKorean',sans-serif;color:#000;background:#fff}
.xlsx-render td{padding:0 3px;overflow:visible;line-height:1.15;box-sizing:border-box}
.xlsx-render .xl-spill{position:absolute;top:0;bottom:0;display:flex;white-space:nowrap;z-index:1;pointer-events:none}
.xlsx-render .xl-left{left:3px}.xlsx-render .xl-right{right:3px}.xlsx-render .xl-center{left:50%;transform:translateX(-50%)}
.xlsx-render .xl-v-middle{align-items:center}.xlsx-render .xl-v-bottom{align-items:flex-end;padding-bottom:1px}.xlsx-render .xl-v-top{align-items:flex-start}
`;
