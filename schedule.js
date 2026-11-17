// Shoot calendar: parse .ics exports (Google Calendar, Apple Calendar) and match receipts to shoot days.
import { unzipSync, strFromU8 } from './vendor/fflate.js';

const pad = n => String(n).padStart(2, '0');

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
const unescapeText = v => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

/** Wall-clock date/time of an iCal value in the given time zone. */
function toLocal(value, params, timeZone) {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, time: '', allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!z) return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, allDay: false };   // TZID or floating: keep wall time
  const instant = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, allDay: false };
}

export function parseICS(text, { timeZone = 'Asia/Seoul', calendar = '' } = {}) {
  const events = [];
  let cur = null, calName = calendar;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur?.start && cur.summary && cur.status !== 'CANCELLED') {
        let end = cur.end || cur.start;
        // An all-day DTEND is exclusive: a one-day event ends the same day.
        if (end.allDay && cur.end) { const d = new Date(end.date + 'T00:00:00'); d.setDate(d.getDate() - 1); end = { ...end, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }; }
        events.push({
          id: `ics:${cur.uid || ''}:${cur.start.date}${cur.start.time}:${cur.summary}`,
          uid: cur.uid || '', title: cur.summary, location: cur.location || '', calendar: calName,
          date: cur.start.date, startTime: cur.start.time, endDate: end.date < cur.start.date ? cur.start.date : end.date, endTime: end.time, allDay: cur.start.allDay
        });
      }
      cur = null; continue;
    }
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const [nameAndParams, value] = [line.slice(0, sep), line.slice(sep + 1)];
    const [name, ...rawParams] = nameAndParams.split(';');
    const params = Object.fromEntries(rawParams.map(p => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
    if (!cur) { if (name === 'X-WR-CALNAME' && !calendar) calName = unescapeText(value); continue; }
    if (name === 'SUMMARY') cur.summary = unescapeText(value);
    else if (name === 'LOCATION') cur.location = unescapeText(value);
    else if (name === 'UID') cur.uid = value.trim();
    else if (name === 'STATUS') cur.status = value.trim().toUpperCase();
    else if (name === 'DTSTART') cur.start = toLocal(value.trim(), params, timeZone);
    else if (name === 'DTEND') cur.end = toLocal(value.trim(), params, timeZone);
  }
  return events;
}

/** Accept a single .ics, or the .zip Google Calendar exports. */
export async function readCalendarFile(file, opts) {
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    return Object.entries(entries).filter(([n]) => /\.ics$/i.test(n))
      .flatMap(([n, bytes]) => parseICS(strFromU8(bytes), { ...opts, calendar: n.replace(/\.ics$/i, '').replace(/_.*$/, '') }));
  }
  return parseICS(await file.text(), opts);
}

const prevDay = iso => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/**
 * Suggest shoot-day labels for a receipt.
 * Same-day events come first. A receipt before 06:00 also matches the previous day's shoot as a return trip.
 */
export function suggestShootDays(events, date, time = '', returnLabel = 'return') {
  if (!date) return [];
  const out = [];
  for (const ev of events) if (ev.date <= date && ev.endDate >= date) out.push({ label: ev.title, event: ev, kind: 'same' });
  if (!time || time < '06:00') {
    const yday = prevDay(date);
    for (const ev of events) if (ev.date <= yday && ev.endDate >= yday && !out.some(o => o.event === ev)) out.push({ label: `${ev.title} ${returnLabel}`, event: ev, kind: 'return' });
  }
  return out;
}

export const eventsInRange = (events, start, end) => events.filter(ev => ev.endDate >= start && ev.date <= end).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
