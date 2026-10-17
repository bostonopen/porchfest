// Converts Melrose Porchfest 2026 data (data.json) into data.js for index.html.
// Source: the porchfest.info map page https://melroseporchfest.org/map/
// (the bands/porches/gigs objects embedded in the page, saved as data.json).
// Downloaded from: https://melroseporchfest.org/map/
// Downloaded 2026-10-16. Run: node convert-json-to-data.mjs
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

const CITY = 'Melrose';
const TOWN_SUFFIX = /,?\s*(Melrose|Melrose)(,?\s*MA)?\s*\d{0,5}\s*$/i;

const inputPath = new URL('./data.json', import.meta.url);

async function runConversion() {
  const source = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const scheduled = Object.values(source.gigs)
    .filter(g => source.bands[g.bandid] && source.porches[g.porchid])
    .sort((a, b) => (Number(a.starthour) * 60 + Number(a.startminute)) - (Number(b.starthour) * 60 + Number(b.startminute)));
  const usedPorches = new Set(scheduled.map(g => g.porchid));
  const porchIds = new Map();
  const sorted = Object.entries(source.porches).sort((a, b) => (Number(a[1].porchnum) || 9999) - (Number(b[1].porchnum) || 9999));
  for (const [sourceId, porch] of sorted) {
    const street = decodeEntities(porch.address).replace(TOWN_SUFFIX, '');
    if (!usedPorches.has(sourceId)) { skipped.push(`${street} (no performances)`); continue; }
    porchIds.set(sourceId, await addPorch({
      address: `${street}, ${CITY}, MA`, lat: porch.lat, lng: porch.lng, porchnum: porch.porchnum,
      geocodeQuery: `${street}, ${CITY}, MA`,
    }));
  }
  for (const gig of scheduled) {
    const porchId = porchIds.get(gig.porchid);
    if (!porchId) continue;
    const band = source.bands[gig.bandid];
    const bandId = addBand(decodeEntities(band.actname), {
      genre: decodeEntities(band.genre), other_genre: decodeEntities(band.other_genre),
      website: band.website || '', facebook: band.facebook || '', instagram: band.instagram || '',
      bandcamp: band.bandcamp || '', spotify: band.spotify || '', apple: band.apple || '',
      otheronline: band.otheronline || '', description: decodeEntities(band.description),
    }, gig.bandid);
    addGig(bandId, porchId, { hour: Number(gig.starthour), minute: gig.startminute }, Number(gig.duration) || 60);
  }
  const unscheduled = Object.keys(source.bands).length - new Set(scheduled.map(g => g.bandid)).size;
  if (unscheduled) skipped.push(`${unscheduled} registered acts with no scheduled set`);
  await writeOutput();
}

runConversion();
