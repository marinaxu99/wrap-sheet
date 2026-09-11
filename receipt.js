import { validNumber, validDate } from './model.js';

/**
 * Optimizes the image for rapid mobile OCR transmission.
 * 960px provides crisp character fidelity while cutting payload size by ~60%.
 */
export async function compressImage(file, max = 960, quality = 0.78) {
  if (!/^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(file.type)) {
    throw new Error('Choose a photo (JPEG, PNG, WebP, or camera photo). PDF receipts must be uploaded as a screenshot.');
  }
  if (file.size > 25 * 1024 * 1024) throw new Error('Photo exceeds 25 MB.');

  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    if (img.naturalWidth * img.naturalHeight > 80000000) throw new Error('Image dimensions are too large.');

    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch (e) {
    throw new Error(`Cannot process photo: ${e.message}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Normalizes Korean/international date strings (e.g. 2026.09.11, 26/9/11, 2026년 9월 11일) to YYYY-MM-DD
 */
function normalizeDate(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const str = raw.trim().replace(/[년월]/g, '-').replace(/[일\.]/g, '-').replace(/\//g, '-').replace(/\s+/g, '');
  const match = str.match(/(\d{2,4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return '';
  let [_, y, m, d] = match;
  if (y.length === 2) y = `20${y}`;
  m = m.padStart(2, '0');
  d = d.padStart(2, '0');
  const formatted = `${y}-${m}-${d}`;
  return validDate(formatted) ? formatted : '';
}

export async function parseReceiptImage(image, key, currency, fetcher = fetch) {
  if (!key) throw new Error('Add your Gemini API key in Settings before scanning.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);

  const promptText = `Extract data from this Korean/English physical or digital receipt slip.
Rules:
1. Vendor: Exact business/store name in its original language (e.g. GS25, CU, 스타벅스, 다이소, 파리바게뜨).
2. Date: Exact transaction date printed on the slip. Convert whatever format is on the slip to YYYY-MM-DD. Never return today's date if another date is visible.
3. Total: Final amount paid (numbers only).
4. VAT: Included tax/VAT (0 if none or unstated).
5. Category: Choose strictly from: "Meals/Catering", "Coffee/Craft", "Transport/Gas/Parking", "Gear/Expendables", "Courier/Post", "Lodging", "Other".
   - Convenience stores, bakeries, snacks -> "Coffee/Craft" or "Meals/Catering"
   - Taxis, fuel, tolls, parking -> "Transport/Gas/Parking"
   - Hardware, tape, office/photo supplies -> "Gear/Expendables"
6. Warning: Note any unreadable fields or leave blank if clean.`;

  try {
    const response = await fetcher('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inlineData: { mimeType: 'image/jpeg', data: image.split(',')[1] } }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              vendor: { type: 'STRING' },
              date: { type: 'STRING' },
              total: { type: 'NUMBER', nullable: true },
              vat: { type: 'NUMBER', nullable: true },
              currency: { type: 'STRING' },
              category: { type: 'STRING' },
              warning: { type: 'STRING' }
            },
            required: ['vendor', 'date', 'total', 'vat', 'currency', 'category', 'warning']
          }
        }
      })
    });

    if (!response.ok) {
      const messages = {
        400: 'The scan request was rejected. Check your API key and image format.',
        401: 'Invalid API key. Check Google AI Studio.',
        403: 'This API key lacks permission. Check Google AI Studio.',
        404: 'Gemini 2.5 Flash is unavailable for this key region.',
        429: 'Gemini quota reached. Wait a minute and retry.'
      };
      throw new Error(messages[response.status] || `Gemini scan failed (${response.status}).`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (!text) throw new Error('Unreadable receipt photo. Please enter details manually.');

    let r;
    try { r = JSON.parse(text); } catch { throw new Error('Malformed receipt response. Please enter manually.'); }

    const parsedDate = normalizeDate(r.date);

    return {
      vendor: (r.vendor || 'Expense').slice(0, 300),
      date: parsedDate,
      total: r.total ?? '',
      vat: r.vat ?? 0,
      currency: typeof r.currency === 'string' && r.currency ? r.currency.toUpperCase() : currency,
      category: r.category || 'Gear/Expendables',
      warning: [
        r.warning || '',
        !parsedDate ? 'Check transaction date.' : '',
        r.total === null ? 'Amount unreadable.' : ''
      ].filter(Boolean).join(' ')
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Scan timed out. Please retry or enter manually.');
    if (e instanceof TypeError) throw new Error('Network error. Check your connection.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}