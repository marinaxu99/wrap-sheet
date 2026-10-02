// Compress and downscale receipt images to avoid payload errors
export async function compressImage(file, maxDimension = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Parse receipt image with Gemini Flash OCR & Auto-Fallback Cascade
export async function parseReceiptImage(base64DataUrl, apiKey, fallbackCurrency = 'KRW') {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Please enter a valid Google AI Studio API key in Settings.');
  }

  // Strip all invisible linebreaks, tabs, or whitespace from copy-paste
  const cleanKey = apiKey.trim().replace(/\s+/g, '');
  const base64Data = base64DataUrl.split(',')[1];
  const mimeType = base64DataUrl.split(';')[0].split(':')[1] || 'image/jpeg';

  const prompt = `You are an audit OCR assistant for production receipts.
Analyze this receipt image and extract:
1. vendor: Name of the business/merchant (in Korean or English as printed).
2. date: Purchase date in YYYY-MM-DD format (if only year/month/day or 2-digit year is visible, infer the full year accurately).
3. total: Final total amount paid as a pure number without currency symbols or commas.
4. vat: Included tax/VAT as a pure number (or 0 if not stated).
5. category: One short category (e.g., Catering, Parking, Toll / Hi-Pass, Equipment, Fuel, Supplies).
6. currency: ISO 3-letter currency code (e.g., KRW, USD, EUR). Default to "${fallbackCurrency}" if Korean won or not specified.

Respond ONLY with valid JSON in this exact structure:
[
  {
    "vendor": "Merchant Name",
    "date": "YYYY-MM-DD",
    "total": 15000,
    "vat": 1363,
    "category": "Catering",
    "currency": "${fallbackCurrency}",
    "warning": ""
  }
]`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: base64Data
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  // Model cascade: Tries 2.5-flash -> 2.0-flash -> 1.5-flash-latest -> 1.5-flash
  const candidateModels = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash'
  ];

  let lastError = null;

  for (const model of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      // If this specific model returns 404 (model not found on his account/tier), continue to the next model
      if (response.status === 404) {
        lastError = new Error(`Model ${model} not found (404)`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('No legible text found on this receipt.');

      const parsed = JSON.parse(rawText);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      // If it's a 404 error, try next candidate model
      if (err.message && err.message.includes('404')) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  // If all models in the cascade returned 404, throw informative error
  throw lastError || new Error('Could not connect to Gemini OCR. Please verify your Google AI Studio key has API access enabled.');
}