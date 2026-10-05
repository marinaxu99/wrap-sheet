// Compress and downscale receipt images to avoid payload timeouts
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

// 1. High-volume, rate-resilient model hierarchy
const MODEL_TIERS = [
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.5-flash",
  "gemini-2.0-flash"
];

// 2. Parse receipt image with Gemini OCR & Automatic Fallback Loop
export async function parseReceiptImage(base64DataUrl, apiKey, fallbackCurrency = 'KRW') {
  const cleanKey = apiKey?.trim().replace(/\s+/g, '');
  if (!cleanKey) {
    throw new Error('Please enter a valid Google AI Studio API key in Settings.');
  }

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

  let lastError = null;

  for (const model of MODEL_TIERS) {
    try {
      const generationConfig = {
        responseMimeType: "application/json",
        maxOutputTokens: 2500,
        temperature: 0.1
      };

      // Only apply thinkingBudget to gemini-2.5-flash to prevent 400 errors on Lite tiers
      if (model === "gemini-2.5-flash") {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const payload = {
        contents: [
          {
            role: "user",
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
        generationConfig
      };

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        lastError = new Error(`${model} failed (${response.status}): ${errorText}`);
        continue;
      }

      const result = await response.json();
      const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error("Empty response from AI.");

      const parsed = JSON.parse(rawText);
      return Array.isArray(parsed) ? parsed : [parsed];

    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error("All AI OCR tiers are temporarily unavailable. Please check your API key or network connection.");
}