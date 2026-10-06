// Compress and downscale receipt images to avoid upload payload timeouts
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

// 1. High-volume, rate-resilient model hierarchy (Flash-Lite first for maximum RPM/RPD)
const MODEL_TIERS = [
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.5-flash"
];

// Hash helper for client-side session caching of receipt payloads
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

// 2. Parse receipt image with Gemini OCR & Automatic Multi-Tier Fallback Loop
export async function parseReceiptImage(base64DataUrl, apiKey, fallbackCurrency = 'KRW') {
  // 1. Aggressive API key sanitization (removes trailing spaces, newlines, tabs)
  const cleanKey = apiKey?.trim().replace(/\s+/g, '');
  if (!cleanKey) {
    throw new Error('Please enter a valid Google AI Studio API key in Settings.');
  }

  const base64Data = base64DataUrl.split(',')[1];
  const mimeType = base64DataUrl.split(';')[0].split(':')[1] || 'image/jpeg';

  // 2. Client-side Session Caching (0 token cost on duplicate rescans/reloads)
  const cacheKey = `wrapsheet_ocr_${hashString(base64Data.slice(0, 500) + base64Data.length)}_${fallbackCurrency}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch { }

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

  // 3. Automated Model Fallback Loop
  for (const model of MODEL_TIERS) {
    try {
      const generationConfig = {
        responseMimeType: "application/json",
        maxOutputTokens: 2500, // Ample headroom prevents JSON parse cutoffs from reasoning
        temperature: 0.1
      };

      // Only add thinkingBudget to standard 2.5-flash to prevent 400 errors on Lite tiers
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

      // If rate-limited (429), not found (404), invalid parameter (400), or busy (503),
      // capture error and silently cascade to the next tier in the loop
      if (!response.ok) {
        const errorText = await response.text();
        lastError = new Error(`${model} failed (${response.status}): ${errorText}`);
        continue;
      }

      const result = await response.json();
      const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error("Empty response from AI.");

      const parsed = JSON.parse(rawText);
      const finalResult = Array.isArray(parsed) ? parsed : [parsed];

      // Cache valid result in session storage
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(finalResult));
      } catch { }

      return finalResult;

    } catch (err) {
      lastError = err;
      continue; // Fail over to next tier
    }
  }

  throw lastError || new Error("All AI OCR tiers are temporarily unavailable. Please check your API key or network connection.");
}