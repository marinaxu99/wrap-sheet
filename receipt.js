import { validNumber, validDate } from './model.js';

export async function compressImage(file, max = 960, quality = 0.80) {
  if (!/^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(file.type)) {
    throw new Error('Choose an image file (JPEG, PNG, WebP).');
  }
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('Image exceeds 25 MB. Please choose a smaller photo.');
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
    throw new Error(`Cannot process this photo: ${e.message}`);
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
    throw new Error('Add your Gemini API key in Settings, or enter receipt details manually.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  const prompt = `You are a film production accounting assistant. Extract data from this Korean or English receipt.
- Vendor: Merchant/Store name.
- Date: Date of transaction in YYYY-MM-DD. Normalize YY.MM.DD or YYYY년 MM월 DD일.
- Total: Final amount paid including VAT.
- VAT: Extracted VAT/부가세 amount (0 if not indicated).
- Category: Pick exactly one: "Meals/Catering", "Coffee/Craft", "Transport/Gas/Parking", "Gear/Expendables", "Courier/Post", "Lodging", or "Other".
- Currency: 3-letter ISO code (default to "${currency || 'KRW'}").`;

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
              vendor: { type: 'STRING' },
              date: { type: 'STRING' },
              total: { type: 'NUMBER', nullable: true },
              vat: { type: 'NUMBER', nullable: true },
              category: { type: 'STRING' },
              currency: { type: 'STRING' },
              warning: { type: 'STRING' }
            },
            required: ['vendor', 'date', 'total', 'vat', 'category', 'currency']
          }
        }
      })
    });

    if (!response.ok) {
      const msgs = {
        400: 'Invalid request or model configuration.',
        401: 'API key is invalid. Please check Settings.',
        403: 'API key does not have permission for Gemini 2.5 Flash.',
        429: 'Gemini rate limit reached. Please wait a moment.'
      };
      throw new Error(msgs[response.status] || `OCR scan error (${response.status}).`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
    if (!text) throw new Error('No receipt text extracted.');

    const parsed = JSON.parse(text);
    const dateFormatted = normalizeDate(parsed.date);

    return {
      vendor: (parsed.vendor || '').slice(0, 200),
      date: dateFormatted,
      total: typeof parsed.total === 'number' && validNumber(parsed.total) ? parsed.total : '',
      vat: typeof parsed.vat === 'number' && validNumber(parsed.vat) ? parsed.vat : 0,
      category: parsed.category || 'Other',
      currency: (parsed.currency || currency || 'KRW').toUpperCase(),
      warning: parsed.warning || (!dateFormatted ? 'Verify receipt date.' : '')
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('OCR scan timed out. Try again or enter manually.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}