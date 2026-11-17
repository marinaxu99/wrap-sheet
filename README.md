# WrapSheet

Invoices and expense receipts for film crew. Runs in the browser, stores everything on the device, no server.

## Two ways to use it

**1. Invoicing another company in their format**
- *Details* → **Billing format** → **Add client format from spreadsheet**. Choose a past invoice of theirs (.xlsx; from Google Sheets use File → Download → Microsoft Excel).
- WrapSheet finds the line table, the invoice date / number / location cells, the totals and the fixed codes (project, cost centre). Check them and save.
- Each month: upload receipts, import the Hi-pass statement after month end, then *Invoice* → **Download all**. You get the filled spreadsheet, the PDF, the receipts renamed (`yyyymmdd_category.pdf`, `_1` `_2` in time order) in the Drive folder name, and the expense log.
- **Start next month's invoice** carries the format and fee forward and adds one to the invoice number.
- If a company only has a PDF or Word invoice, ask Claude to make a WrapSheet format for it, then **Import format file**.

**2. Crew hired by arki pictures**
- Choose **arki pictures — crew invoice**, pick freelancer (3.3% withheld) or registered business (VAT), add work lines and receipts.
- *Invoice* → **Submission package (.zip)**. It can't be exported until every receipt is reviewed and the profile is complete.
- arki pictures opens the zip in Settings → **Review a crew submission**. Totals are recalculated and compared with the claimed totals, each line can be marked OK or Query, and **Copy feedback** writes the reply.

## Receipts

- PDF scans or photos. With a Gemini key (Settings) each receipt is read for date, time, vendor, location, amount actually charged, card and category. Gas-station pre-authorisation and cancellation lines are ignored.
- Statuses: **To review** (not billed), **Verified**, **Needs check** (billed, flagged for confirmation), **Excluded** (kept, never billed).
- **Import calendar (.ics)**: Google Calendar → Settings → Import & export → Export. Receipts are matched to shoot days. A receipt before 06:00 also matches the previous day's shoot as a return trip. Receipts on days with no shoot are flagged.
- **Hi-pass statement**: each trip becomes a line. The "balance after use" column is checked for gaps. A jump in round 10,000s is treated as a top-up; any other break means a missing or excluded trip.

## Files

`app.js` (interface) · `model.js` (data, totals) · `formats.js` (built-in formats, naming, checklist) · `sheet.js` (reads, fills and draws client .xlsx files at XML level, so styles and table styles survive) · `receipt.js` (PDF/image intake, Gemini reading, Hi-pass balance check) · `schedule.js` (.ics) · `exports.js` (zips, CSV, receipt PDFs, crew packages) · `invoice.js` (built-in invoice layouts) · `db.js` (IndexedDB).

Bundled: PDF.js 4.10.38 (Apache-2.0), html2pdf (MIT), fflate 0.8.3 (MIT), pdf-lib 1.17.1 (MIT), Noto Sans KR (OFL). ExcelJS is not used.

## Deploy

Upload the whole folder as static files over HTTPS. Local test: `python3 -m http.server 8765` in this folder. The service worker caches the app for offline use. Bump `CACHE` in `sw.js` on every release.

## Tested / not tested

Tested in headless Chrome: format detection on the Eyeline sheet; replaying October #007 gives 396,810 expenses, 539,681 VAT and 5,936,491 total; LibreOffice recalculates generated sheets to the same totals; the table range follows the rows; spreadsheet PDF; receipt renaming; CSV; next month; crew package export and review import; 390px phone layout.

Not tested: live Gemini responses (tests used mocked replies), real Hi-pass statement layouts, opening the generated .xlsx in Google Sheets, real iOS/Android devices.
