// Converts Stoneham Porchfest 2026 data (data.kml) into data.js for index.html.
// Source: the Stoneham Porchfest 2026 Google My Maps export.
// Map page: https://www.stonehamporchfest.com/map
// KML: https://www.google.com/maps/d/kml?mid=1D1waRyCIQy32pupe6MwCuVDvKVvNc4E&forcekml=1
// Downloaded 2026-10-16. Run: node convert-kml-to-data.mjs
// Porches that have no coordinates are geocoded with Nominatim (1 request/second, with a User-Agent).
import fs from 'fs/promises';
import https from 'node:https';

const outputPath = new URL('./data.js', import.meta.url);
const USER_AGENT = 'bostonopen-porchfest-converter/1.0 (https://github.com/bostonopen/porchfest)';

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\uFEFF/g, '').replace(/\s+/g, ' ').trim();
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(response.statusCode < 300 ? JSON.parse(body) : []));
    }).on('error', reject);
  });
}

// Nominatim: at most 1 request per second, with a User-Agent.
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
  const results = await getJson(url);
  await new Promise(resolve => setTimeout(resolve, 1100));
  return results.length ? { lat: String(results[0].lat), lng: String(results[0].lon) } : null;
}

// "1", "1:30", "12" -> 24h hour/minute; festival hours before 9 are PM.
function clockToTime(hourText, minuteText = '00', meridiem = '') {
  let hour = Number(hourText);
  const m = meridiem.toLowerCase();
  if (m.startsWith('p') && hour !== 12) hour += 12;
  else if (m.startsWith('a') && hour === 12) hour = 0;
  else if (!m && hour < 9) hour += 12;
  return { hour, minute: String(minuteText || '00').padStart(2, '0') };
}

function minutesBetween(start, end) {
  const d = (end.hour * 60 + Number(end.minute)) - (start.hour * 60 + Number(start.minute));
  return d > 0 ? d : 60;
}

const bands = {}, porches = {}, gigs = {};
const bandIdByKey = new Map(), porchIdByKey = new Map();
const skipped = [];
let geocoded = 0;

async function addPorch({ address, lat, lng, porchnum = '', geocodeQuery }) {
  const key = address.toLowerCase();
  if (porchIdByKey.has(key)) return porchIdByKey.get(key);
  if ((!lat || !lng) && geocodeQuery) {
    const result = await geocode(geocodeQuery);
    if (result) { ({ lat, lng } = result); geocoded += 1; }
  }
  if (!lat || !lng) { skipped.push(`${address} (no coordinates)`); return null; }
  const id = `porch_${String(porchIdByKey.size + 1).padStart(4, '0')}`;
  porchIdByKey.set(key, id);
  porches[id] = { address, lat: String(lat), lng: String(lng), porchnum: String(porchnum || ''), _id: id };
  return id;
}

function addBand(actname, extra = {}, key = actname.toLowerCase()) {
  if (bandIdByKey.has(key)) return bandIdByKey.get(key);
  const id = `band_${String(bandIdByKey.size + 1).padStart(4, '0')}`;
  bandIdByKey.set(key, id);
  bands[id] = {
    actname, genre: '', other_genre: '', website: '', facebook: '', instagram: '', bandcamp: '',
    spotify: '', apple: '', otheronline: '', description: '', image: '', ...extra, _id: id,
  };
  return id;
}

function addGig(bandid, porchid, { hour, minute }, duration = 60) {
  const id = `gig_${String(Object.keys(gigs).length + 1).padStart(5, '0')}`;
  gigs[id] = { bandid, porchid, starthour: String(hour), startminute: String(minute).padStart(2, '0'), duration: String(duration), _id: id };
}

async function writeOutput() {
  const output = `const bands = ${JSON.stringify(bands, null, 4)};\n\nconst porches = ${JSON.stringify(porches, null, 4)};\n\nconst gigs = ${JSON.stringify(gigs, null, 4)};\n`;
  await fs.writeFile(outputPath, output, 'utf8');
  console.log(`Bands: ${Object.keys(bands).length}`);
  console.log(`Porches: ${Object.keys(porches).length}`);
  console.log(`Gigs: ${Object.keys(gigs).length}`);
  console.log(`Geocoded: ${geocoded}`);
  console.log(`Skipped: ${skipped.length ? skipped.join('; ') : 'none'}`);
}

const CITY = 'Stoneham';
const TOWN_SUFFIX = /,?\s*(Stoneham|Stoneham)(,?\s*MA)?\s*\d{0,5}\s*$/i;

const inputPath = new URL('./data.kml', import.meta.url);

function readPlacemarks(xml) {
  return [...xml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)].map(([, p]) => ({
    name: decodeEntities((p.match(/<name>([\s\S]*?)<\/name>/) || [])[1]),
    description: ((p.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1'),
    lng: (p.match(/<coordinates>\s*([-\d.]+),([-\d.]+)/) || [])[1],
    lat: (p.match(/<coordinates>\s*([-\d.]+),([-\d.]+)/) || [])[2],
    data: Object.fromEntries([...p.matchAll(/<Data name="([^"]+)">\s*<value>([\s\S]*?)<\/value>/g)].map(([, k, v]) => [decodeEntities(k), decodeEntities(v)])),
  }));
}

function descriptionLines(description) {
  return description.split(/<br\s*\/?>/i).map(line => decodeEntities(line.replace(/<[^>]+>/g, ' '))).filter(Boolean);
}

// "Band name: 12:00 - 1:00" or "Band name - 12:00-2:00" (also tolerates "12 :00" and "400").
const ACT_THEN_RANGE = /^(.*?)\s*[:\-–]\s*(\d{1,2})\s*:?\s*(\d{2})?\s*[-–]\s*(\d{1,2})\s*:?\s*(\d{2})?\s*$/;
function parseActThenRange(line) {
  const m = line.match(ACT_THEN_RANGE);
  if (!m || !m[1].trim() || /^[\d:\s]+$/.test(m[1].trim())) return null;
  const start = clockToTime(m[2], m[3]);
  const end = clockToTime(m[4], m[5]);
  return { actname: m[1].trim(), start, duration: minutesBetween(start, end) };
}

// "Band name - 3:00" (start time only). The set is taken to run until the next
// set at the same porch starts, or 60 minutes for the last set.
const ACT_THEN_START = /^(.*?)\s*[:\-–]\s*(\d{1,2}):(\d{2})\s*$/;
function parseActThenStart(line) {
  const m = line.match(ACT_THEN_START);
  if (!m || !m[1].trim() || /^[\d:\s]+$/.test(m[1].trim())) return null;
  return { actname: m[1].trim(), start: clockToTime(m[2], m[3]), duration: null };
}

function parseActLine(line) {
  return parseActThenRange(line) || parseActThenStart(line);
}

function fillOpenDurations(acts) {
  const sorted = [...acts].sort((a, b) => (a.start.hour * 60 + Number(a.start.minute)) - (b.start.hour * 60 + Number(b.start.minute)));
  sorted.forEach((act, i) => { if (act.duration == null) act.duration = sorted[i + 1] ? minutesBetween(act.start, sorted[i + 1].start) : 60; });
  return sorted;
}

// A bare "12:00-2:00" line gives its time to the untimed act lines just above it.
const BARE_RANGE = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/;
function parseActLines(lines) {
  const acts = [], pending = [], unparsed = [];
  for (const line of lines) {
    const act = parseActLine(line);
    const bare = line.match(BARE_RANGE);
    if (act) { acts.push(act); unparsed.push(...pending.splice(0)); }
    else if (bare && pending.length) {
      const start = clockToTime(bare[1], bare[2]);
      const duration = minutesBetween(start, clockToTime(bare[3], bare[4]));
      for (const actname of pending.splice(0)) acts.push({ actname, start, duration });
    } else if (!/^\(|^SUPPORTED BY|intermission/i.test(line)) pending.push(line);
    else unparsed.push(line);
  }
  unparsed.push(...pending);
  return { acts: fillOpenDurations(acts), unparsed };
}

async function runConversion() {
  const xml = await fs.readFile(inputPath, 'utf8');
  for (const placemark of readPlacemarks(xml)) {
    const { acts, unparsed } = parseActLines(descriptionLines(placemark.description));
    for (const line of unparsed) skipped.push(`"${line}" at ${placemark.name} (no set time)`);
    if (!acts.length) { skipped.push(`${placemark.name} (no performances)`); continue; }
    const porchId = await addPorch({
      address: `${placemark.name}, ${CITY}, MA`, lat: placemark.lat, lng: placemark.lng,
      geocodeQuery: `${placemark.name}, ${CITY}, MA`,
    });
    if (!porchId) continue;
    for (const act of acts) addGig(addBand(act.actname), porchId, act.start, act.duration);
  }
  await writeOutput();
}

runConversion();
