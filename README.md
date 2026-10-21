
## October 21 update — personal PDF templates

Existing WrapSheet presets, branding settings, and HTML uploads remain available.

- The invoice preview hint now follows the pointer with a dark, themed design. Touch users keep the Edit & Zoom button.
- Switching tax mode selects 10% for VAT or 3.3% for withholding. The percentage remains editable; these are convenience defaults, not a determination of your applicable tax.
- In Invoice → Export & Storage → **Upload PDF template**, choose an unlocked PDF (maximum 15 MB, 5 pages). The app detects recognizable English/Korean labels and named text form fields locally.
- Review every suggested box. Drag boxes or adjust their coordinates, size and text size. Add missing fields, especially Work items and Expense items. Confirm each field, then Save & use template. Saved PDF templates appear in Layout Preset and can be reused across projects on this device.
- For complex/scanned layouts, expand Optional automatic layout analysis. **Send pages to Gemini & detect fields** sends images of every page to Google using your configured key; it replaces draft suggestions. This is optional and requires internet. Detection is advisory, never guaranteed.
- Edit actual values in Project, Work and Receipts. PDF mappings fill from those values. Built-in invoice editing is unchanged. Branding and custom headings apply to WrapSheet templates; the uploaded PDF supplies its own design.
- A blank template works best. Existing printed content is retained; enable **Cover existing value with white** to hide old values inside a reviewed box. This can also cover lines in that box. This is an overlay workflow, not arbitrary PDF text reconstruction.
- Exports preserve source page proportions and use flattened images with Korean-capable text. They are not interactive PDF forms or vector/searchable text. Reviewed receipts can be appended as separate proof pages.
- Export requires client, invoice number, total, and any applicable work/expense/tax mappings. Oversized content blocks export with a message. Automatic table pagination is not supported: enlarge the table box, reduce text size, or use a built-in template for long invoices.
- Templates and rendered page images stay in IndexedDB. Clearing site data removes them. The original uploaded PDF is not stored; keep your own source copy. Editing a saved mapping affects every project using it on this device.

### Deployment / dependencies

Upload this **entire folder**, including new `pdf-template.js`, `pdf-editor.js`, `preview-hint.js` and `vendor/pdfjs/`. PDF.js 4.10.38 and its Apache-2.0 license are bundled for local/offline parsing. The service worker cache is versioned; close all app tabs and reopen after deploying to activate the update. First load must finish online before offline use.

Local preview: from this folder run `python3 -m http.server 8765`, then visit `http://localhost:8765`. Deploy as static files over HTTPS for PWA install and camera support. Configure your Gemini key in Settings; it remains in this browser's localStorage. No build step or backend is required.

### Validation

Checked in headless Chromium: tax mode defaults, pointer-following hint, local PDF label detection, field confirmation and save, Korean PDF export with visual inspection, overflow rejection, 390px viewport width, IndexedDB persistence and offline reopening. Gemini layout analysis has not been tested against a live paid API. Real-device iOS/Android testing and representative customer PDF templates remain recommended before a public release.
