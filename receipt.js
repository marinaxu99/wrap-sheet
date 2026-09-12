import { validNumber, validDate } from './model.js';

export async function compressImage(file, max = 1200, quality = 0.82) {
  if (!/^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(file.type)) {
    throw new Error('Choose an image file (JPEG, PNG, WebP).');
  }
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('Image exceeds 25 MB.');
  }

  const url = URL.createObjectURL(file);
  const img = new Image();

  try {
    img.src = url;
    await img.decode();

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
    throw new Error(`Cannot process image: ${e.message}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalizeDate(raw) {
  if (!raw) return '';
  const clean = raw.trim().replace(/[./\s]/g, '-').replace(/[年月]/g, '-').replace(/[일]/g, '');
  const match = clean.match(/(\d{2,4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return '';
  let [_, y, m, d] = match;
  if (y.length === 2) y = `20${y}`;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return validDate(iso) ? iso : '';
}

export async function parseReceiptImage(image, key, currency, fetcher = fetch) {
  if (!key) {
    throw new Error('Add your Gemini API key in Settings.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  const prompt = `You are a film production accounting assistant. 
Analyze this receipt image. It may contain a single receipt, OR multiple transaction slips (such as a Korean Hi-Pass highway toll statement 확인증 with multiple boxed entries).
- If it has MULTIPLE slips/boxes (like toll transactions), extract EACH box as a separate item in the items array.
- For each item:
  - vendor: Merchant or Toll station name (e.g., "한국도로공사", "민자운영사 - 문산").
  - date: Transaction date formatted as YYYY-MM-DD.
  - total: Final amount paid (이용금액).
  - vat: VAT amount (부가세) if listed, otherwise 0.
  - category: Exactly one of: "Meals/Catering", "Coffee/Craft", "Transport/Gas/Parking", "Gear/Expendables", "Courier/Post", "Lodging", or "Other". (For tolls use "Transport/Gas/Parking").
  - currency: 3-letter currency code (default "${currency || 'KRW'}").`;

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
            { text: prompt },
            { inlineData: { mimeType: 'image/jpeg', data: image.split(',')[1] } }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              items: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    vendor: { type: 'STRING' },
                    date: { type: 'STRING' },
                    total: { type: 'NUMBER', nullable: true },
                    vat: { type: 'NUMBER', nullable: true },
                    category: { type: 'STRING' },
                    currency: { type: 'STRING' }
                  },
                  required: ['vendor', 'date', 'total', 'vat', 'category', 'currency']
                }
              }
            },
            required: ['items']
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`OCR scan failed (${response.status}).`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
    if (!text) throw new Error('No receipt data recognized.');

    const parsed = JSON.parse(text);
    const results = (parsed.items || []).map(item => ({
      vendor: (item.vendor || '').slice(0, 200),
      date: normalizeDate(item.date),
      total: typeof item.total === 'number' && validNumber(item.total) ? item.total : '',
      vat: typeof item.vat === 'number' && validNumber(item.vat) ? item.vat : 0,
      category: item.category || 'Transport/Gas/Parking',
      currency: (item.currency || currency || 'KRW').toUpperCase(),
      warning: !normalizeDate(item.date) ? 'Verify date' : ''
    }));

    return results.length > 0 ? results : [{
      vendor: '',
      date: '',
      total: '',
      vat: 0,
      category: 'Other',
      currency: currency || 'KRW',
      warning: 'Could not extract items cleanly'
    }];
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('OCR scan timed out.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}