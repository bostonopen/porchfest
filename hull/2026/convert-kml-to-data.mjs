// Converts Hull Porchfest 2026 data (data.kml) into data.js for index.html.
// Source: the Hull PorchFest 2026 Google My Maps export.
// Map page: https://hullporchfest.com/
// KML: https://www.google.com/maps/d/kml?mid=1w7UCErnSnzfvthBrbYTo5AMj7skjJb8&forcekml=1
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

const CITY = 'Hull';
const TOWN_SUFFIX = /,?\s*(Hull|Hull)(,?\s*MA)?\s*\d{0,5}\s*$/i;

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
  if (!m || !m[1].trim()) return null;
  const start = clockToTime(m[2], m[3]);
  const end = clockToTime(m[4], m[5]);
  return { actname: m[1].trim(), start, duration: minutesBetween(start, end) };
}

// Placemarks are named "Stage N - <address>"; descriptions list "1:00 BAND NAME".
// Sets start at 1:00, 2:45 and 4:30, so each set is taken as 90 minutes.
async function runConversion() {
  const xml = await fs.readFile(inputPath, 'utf8');
  for (const placemark of readPlacemarks(xml)) {
    const stage = placemark.name.match(/^Stage\s*(\d+)\s*-\s*(.+)$/i);
    if (!stage) { skipped.push(`${placemark.name} (not a stage)`); continue; }
    const acts = descriptionLines(placemark.description)
      .map(line => line.match(/^(\d{1,2}):(\d{2})\s+(.+)$/)).filter(Boolean)
      .map(m => ({ start: clockToTime(m[1], m[2]), actname: m[3].trim() }));
    if (!acts.length) { skipped.push(`${placemark.name} (no performances)`); continue; }
    const porchId = await addPorch({
      address: `${stage[2].trim()}, ${CITY}, MA`, lat: placemark.lat, lng: placemark.lng, porchnum: stage[1],
      geocodeQuery: `${stage[2].trim()}, ${CITY}, MA`,
    });
    if (!porchId) continue;
    for (const act of acts) addGig(addBand(act.actname), porchId, act.start, 90);
  }
  await writeOutput();
}

runConversion();
