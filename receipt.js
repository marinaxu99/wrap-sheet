// Receipt intake: images and PDFs, local preview rendering, Gemini OCR.

const readAsDataURL = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

function drawScaled(source, width, height, maxDimension, quality) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// Compress and downscale receipt images to avoid upload payload timeouts
export async function compressImage(file, maxDimension = 1200, quality = 0.8) {
  const url = await readAsDataURL(file);
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error(`${file.name || 'Image'} could not be read.`)); img.src = url; });
  return drawScaled(img, img.naturalWidth, img.naturalHeight, maxDimension, quality);
}

let pdfjs;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('./vendor/pdfjs/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

/** Render page 1 of a PDF (plus a tall strip of every page for multi-page statements). */
export async function renderPdfPreview(bytes, maxDimension = 1400) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(bytes.slice(0)), isEvalSupported: false,
    cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href
  }).promise;
  try {
    const canvases = [];
    for (let n = 1; n <= Math.min(doc.numPages, 6); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2.5, maxDimension / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      canvases.push(canvas);
    }
    const first = canvases[0];
    // Stack pages vertically so the inspector shows the whole statement.
    const stack = document.createElement('canvas');
    stack.width = Math.max(...canvases.map(c => c.width));
    stack.height = canvases.reduce((h, c) => h + c.height, 0);
    const sctx = stack.getContext('2d');
    sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, stack.width, stack.height);
    let y = 0; for (const c of canvases) { sctx.drawImage(c, 0, y); y += c.height; }
    return {
      pages: doc.numPages,
      imageFull: drawScaled(stack, stack.width, stack.height, Math.max(1800, maxDimension), 0.85),
      imageThumbnail: drawScaled(first, first.width, first.height, 400, 0.72)
    };
  } finally { doc.destroy(); }
}

/** Turn an uploaded File into a stored receipt record. PDFs keep their original bytes. */
export async function readReceiptFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const bytes = await file.arrayBuffer();
    const preview = await renderPdfPreview(bytes);
    return { mime: 'application/pdf', name: file.name, original: bytes, pages: preview.pages, imageFull: preview.imageFull, imageThumbnail: preview.imageThumbnail };
  }
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|heic|webp)$/i.test(file.name)) throw new Error(`${file.name} is not an image or PDF.`);
  return { mime: 'image/jpeg', name: file.name, imageFull: await compressImage(file, 1600, 0.85), imageThumbnail: await compressImage(file, 400, 0.72) };
}

export const isReceiptFile = f => f.type.startsWith('image/') || f.type === 'application/pdf' || /\.(pdf|jpe?g|png|heic|webp)$/i.test(f.name);

const bufferToBase64 = buffer => {
  const bytes = new Uint8Array(buffer); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** What Gemini sees: the original PDF when there is one, otherwise the JPEG. */
export function ocrPayload(record) {
  if (record.original && record.mime === 'application/pdf') return { mimeType: 'application/pdf', data: bufferToBase64(record.original) };
  const url = record.imageFull;
  return { mimeType: url.split(';')[0].split(':')[1] || 'image/jpeg', data: url.split(',')[1] };
}

// High-volume, rate-resilient model hierarchy (Flash-Lite first for maximum RPM/RPD)
const MODEL_TIERS = ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash'];
export let lastModelUsed = '';

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = (hash << 5) - hash + str.charCodeAt(i); hash |= 0; }
  return hash.toString(36);
}

async function askGemini(prompt, payload, apiKey, cacheTag) {
  const cleanKey = apiKey?.trim().replace(/\s+/g, '');
  if (!cleanKey) throw new Error('Add a Google AI Studio API key in API & Setup to read receipts automatically.');
  const cacheKey = `wrapsheet_ocr_${cacheTag}_${hashString(payload.data.slice(0, 600) + payload.data.length + prompt.length)}`;
  try { const cached = sessionStorage.getItem(cacheKey); if (cached) return JSON.parse(cached); } catch { }

  let lastError = null;
  for (const model of MODEL_TIERS) {
    try {
      const generationConfig = { responseMimeType: 'application/json', maxOutputTokens: 8000, temperature: 0.1 };
      if (model === 'gemini-2.5-flash') generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: payload }] }], generationConfig })
      });
      if (!response.ok) { lastError = new Error(`${model} failed (${response.status}): ${(await response.text()).slice(0, 200)}`); continue; }
      const result = await response.json();
      const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Empty response from AI.');
      const parsed = JSON.parse(rawText);
      lastModelUsed = model;
      try { sessionStorage.setItem(cacheKey, JSON.stringify(parsed)); } catch { }
      return parsed;
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('All AI OCR tiers are temporarily unavailable. Check your API key or network connection.');
}

const num = v => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : ''; };
const hhmm = v => { const m = String(v || '').match(/(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };

/** Normalise a free-form category to one of the format's categories. */
export function matchCategory(raw, categories) {
  if (!raw) return '';
  const s = String(raw).toLowerCase();
  const direct = categories.find(c => c.toLowerCase() === s);
  if (direct) return direct;
  const synonyms = [
    [/gas|fuel|주유|oil/, ['Gas', 'Fuel']],
    [/meal|food|cater|coffee|cafe|restaurant|식|카페|snack/, ['Meal', 'Meals']],
    [/toll|hi-?pass|하이패스|통행/, ['Toll']],
    [/park|주차/, ['Parking']],
    [/taxi|train|ktx|bus|transport|교통/, ['Transport']],
    [/soft|subscription|app/, ['Software']],
    [/suppl|tape|battery|소모품|문구/, ['Supplies']],
    [/rental|rent|equipment|장비/, ['Equipment rental']],
    [/hotel|lodg|숙박/, ['Lodging']]
  ];
  for (const [re, names] of synonyms) if (re.test(s)) { const hit = categories.find(c => names.includes(c)); if (hit) return hit; }
  return categories.includes('Other') ? 'Other' : raw;
}

/** Read an ordinary receipt. Returns one or more line items. */
export async function parseReceipt(record, apiKey, { currency = 'KRW', categories = [] } = {}) {
  const list = categories.length ? categories.join(', ') : 'Gas, Meal, Toll, Parking, Supplies, Other';
  const prompt = `You read production expense receipts (often Korean card slips, scanned to PDF).
If the document is a Korean Hi-pass toll usage statement (하이패스 사용내역/이용내역 확인증, a table of many toll trips), return exactly [{"documentType": "toll_statement"}] and nothing else.
Otherwise return a JSON array with one object per separate purchase on the document (normally exactly one):
{"documentType": "receipt", "vendor": merchant name as printed, "date": "YYYY-MM-DD", "time": "HH:MM" (24h, approval time if shown, else ""),
 "location": "short address: city and district, e.g. 충북 음성군 삼성면" or "",
 "total": amount actually charged to the card, a number, "vat": VAT included in the total, a number (0 if not shown),
 "currency": ISO code (default "${currency}"), "category": one of [${list}],
 "paidBy": card as printed, issuer plus last 4 visible digits, e.g. "현대카드 2608"; "" if none,
 "warning": short note in English about anything unusual, else ""}
Rules:
- Gas station slips often show a pre-authorization (선승인) and its cancellation (취소) before the real charge. Ignore both; use only the final approved amount.
- If points, coupons or a personal-cup discount were applied, use the amount actually paid by card.
- If sale date and approval date differ because of midnight, use the approval date and time.
- Coffee and snacks are "Meal" when Meal is in the list.
- Never invent a value; use "" when it is not printed.`;
  const parsed = await askGemini(prompt, ocrPayload(record), apiKey, 'r1');
  const found = Array.isArray(parsed) ? parsed : [parsed];
  if (found[0]?.documentType === 'toll_statement') return [{ documentType: 'toll_statement' }];
  return found.map(i => ({
    vendor: String(i.vendor || '').trim(), date: /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : '', time: hhmm(i.time),
    location: String(i.location || '').trim(), total: num(i.total), vat: num(i.vat) || 0, currency: i.currency || currency,
    category: matchCategory(i.category, categories), paidBy: String(i.paidBy || '').trim(), warning: String(i.warning || '').trim()
  }));
}

/** Read a Korean Hi-pass usage statement (하이패스 사용내역 확인증) into individual trips. */
export async function parseTollStatement(record, apiKey) {
  const prompt = `This is a Korean Hi-pass toll usage statement (하이패스 사용내역/이용내역 확인증).
Return JSON {"cardLast4": last 4 digits of the Hi-pass card number or "", "trips": [ ... ]} where every row of the trip table becomes one trip:
{"date": "YYYY-MM-DD" (통행일자), "time": "HH:MM" (통행시각, 24h), "entry": entry tollgate (입구영업소) or "", "exit": exit tollgate (출구영업소),
 "amount": toll paid as a number (통행요금/결제금액), "balanceAfter": balance after use (사용후 잔액) as a number or ""}
Keep the table order. Do not merge rows. Do not invent rows. Ignore totals rows.`;
  const parsed = await askGemini(prompt, ocrPayload(record), apiKey, 'h1');
  const trips = (parsed.trips || []).map(t => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : '', time: hhmm(t.time),
    entry: String(t.entry || '').trim(), exit: String(t.exit || '').trim(), amount: num(t.amount), balanceAfter: num(t.balanceAfter)
  })).filter(t => t.date || t.amount);
  return { cardLast4: String(parsed.cardLast4 || '').replace(/\D/g, '').slice(-4), trips };
}

/**
 * Check a statement's "balance after use" column.
 * Each trip should leave prev − amount. A positive jump in round 10,000s is an automatic top-up.
 * Anything else means a trip is missing between the two rows (often one you excluded on the site).
 */
export function checkBalanceChain(trips) {
  const rows = trips.filter(t => t.balanceAfter !== '' && t.amount !== '')
    .map((t, i) => ({ ...t, i })).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.i - b.i);
  const notes = [];
  for (let k = 1; k < rows.length; k++) {
    const prev = rows[k - 1], cur = rows[k];
    const diff = cur.balanceAfter - (prev.balanceAfter - cur.amount);
    if (diff === 0) continue;
    if (diff > 0 && diff % 10000 === 0) notes.push({ kind: 'topup', after: prev, at: cur, amount: diff });
    else notes.push({ kind: 'gap', after: prev, at: cur, amount: diff });
  }
  return { checked: rows.length, notes, ok: !notes.some(n => n.kind === 'gap') };
}
