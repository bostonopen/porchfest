// Converts Somerville PorchFest 2026 performer listings (data.json) into data.js.
// Source map: https://somervilleartscouncil.org/porchfest/porchfest-map/
// That map (a GravityView/Gravity Forms view) embeds one marker per performer with
// lat/lng already set; the name, address, set time, genre and description were read
// from each performer's public entry page (linked by `url` in data.json).
// No geocoding is needed. Performers at the same address share one porch.
import fs from 'fs/promises';

const inputPath = new URL('./data.json', import.meta.url);
const outputPath = new URL('./data.js', import.meta.url);

function parseClock(text) {
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (match[3].toLowerCase() === 'am' && hour === 12) hour = 0;
  return hour * 60 + Number(match[2]);
}

function parseRange(text) {
  const [start, end] = String(text || '').split(/\s*-\s*/).map(parseClock);
  if (start == null || end == null || end < start) return null;
  // One listing has the same start and end time; show it as a one-hour set.
  if (end === start) return { start, duration: 60 };
  return { start, duration: end - start };
}

function normalizeAddress(address) {
  return String(address || '').replace(/\s+/g, ' ').trim();
}

function pickLink(links, pattern) {
  return links.find(link => pattern.test(link)) || '';
}

async function runConversion() {
  const entries = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const bands = {}, porches = {}, gigs = {};
  const porchIdByAddress = new Map();
  let porchCounter = 0, bandCounter = 0, gigCounter = 0;
  const skipped = [];

  for (const entry of entries) {
    const address = normalizeAddress(entry.address);
    const range = parseRange(entry.time);
    if (!address || !entry.lat || !entry.lng) { skipped.push(`${entry.name} (no address/coordinates)`); continue; }
    if (!range) { skipped.push(`${entry.name} at ${address} (no set time: "${entry.time}")`); continue; }

    const key = address.toLowerCase();
    let porchId = porchIdByAddress.get(key);
    if (!porchId) {
      porchCounter += 1;
      porchId = `porch_${String(porchCounter).padStart(4, '0')}`;
      porchIdByAddress.set(key, porchId);
      porches[porchId] = { address: `${address}, Somerville, MA`, lat: String(entry.lat), lng: String(entry.lng), porchnum: '', _id: porchId };
    }

    const links = entry.links || [];
    bandCounter += 1;
    const bandId = `band_${String(bandCounter).padStart(4, '0')}`;
    bands[bandId] = {
      actname: entry.name,
      genre: (entry.genres || []).join(', '),
      other_genre: '',
      website: links.find(link => !/instagram|facebook|bandcamp|spotify|apple\.com|youtube|youtu\.be/i.test(link)) || '',
      facebook: pickLink(links, /facebook/i),
      instagram: pickLink(links, /instagram/i),
      bandcamp: pickLink(links, /bandcamp/i),
      spotify: pickLink(links, /spotify/i),
      apple: pickLink(links, /apple\.com/i),
      otheronline: pickLink(links, /youtube|youtu\.be/i),
      description: entry.description || '',
      image: '',
      _id: bandId,
    };

    gigCounter += 1;
    const gigId = `gig_${String(gigCounter).padStart(5, '0')}`;
    gigs[gigId] = {
      bandid: bandId, porchid: porchId,
      starthour: String(Math.floor(range.start / 60)),
      startminute: String(range.start % 60).padStart(2, '0'),
      duration: String(range.duration), _id: gigId,
    };
  }

  const output = `const bands = ${JSON.stringify(bands, null, 4)};\n\nconst porches = ${JSON.stringify(porches, null, 4)};\n\nconst gigs = ${JSON.stringify(gigs, null, 4)};\n`;
  await fs.writeFile(outputPath, output, 'utf8');
  console.log(`Bands: ${Object.keys(bands).length}`);
  console.log(`Porches: ${Object.keys(porches).length}`);
  console.log(`Gigs: ${Object.keys(gigs).length}`);
  console.log(`Skipped: ${skipped.length ? skipped.join('; ') : 'none'}`);
}

runConversion();
