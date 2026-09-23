import fs from 'fs/promises';
import * as vm from 'node:vm';
import https from 'node:https';

const inputPath = new URL('./data.kml', import.meta.url);
const outputPath = new URL('./data.js', import.meta.url);
const legacyDataPath = new URL('../2025/data.js', import.meta.url);
const shouldGeocode = process.argv.includes('--geocode');
const manualGeocodes = new Map([
  // Nominatim has no point result for this intersection; this is the
  // approximate crossing of the two OSM street geometries.
  ['franklin st & rice st, brookline, ma', { lat: '42.3274', lng: '-71.1232', query: 'Franklin St & Rice St, Brookline, MA' }],
]);

async function loadLegacyPorches() {
  try {
    const source = await fs.readFile(legacyDataPath, 'utf8');
    return vm.runInNewContext(`(() => { ${source}; return porches; })()`);
  } catch {
    return {};
  }
}

function normalizeAddress(address) {
  return String(address || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body });
      });
    }).on('error', reject);
  });
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function unwrapCdata(value) {
  const trimmed = String(value || '').trim();
  const cdataMatch = trimmed.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdataMatch ? cdataMatch[1].trim() : trimmed;
}

function to24Hour(hourText, minuteText, ampmText) {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const ampm = ampmText.toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function parsePerformanceLine(value) {
  const normalized = decodeXml(unwrapCdata(value));
  const pattern = /^(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)\s*-\s*(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)\s*:\s*(.+)$/i;
  const match = normalized.match(pattern);
  if (!match) return null;

  const [, startHour, startMinute, startAmPm, endHour, endMinute, endAmPm, actnameRaw] = match;
  const startTime = to24Hour(startHour, startMinute, startAmPm);
  const endTime = to24Hour(endHour, endMinute, endAmPm);

  const startMinutesTotal = startTime.hour * 60 + startTime.minute;
  const endMinutesTotal = endTime.hour * 60 + endTime.minute;
  const duration = Math.max(1, endMinutesTotal - startMinutesTotal);

  return {
    actname: actnameRaw.trim(),
    starthour: String(startTime.hour),
    startminute: String(startTime.minute).padStart(2, '0'),
    duration: String(duration),
  };
}

async function geocodeAddress(address) {
  const normalized = address.replace(/\s+/g, ' ').trim();
  const candidateAddresses = [
    normalized,
    normalized.replace(/\s+Unit\s+[^,]+/i, ''),
    normalized.replace(/\s+#\d+\s*(,|$)/, '$1'),
    normalized.replace(/,\s*Brookline,\s*MA\s*$/i, ', Brookline, MA'),
  ];

  const dedupedCandidates = [...new Set(candidateAddresses.filter(Boolean))];

  for (const candidate of dedupedCandidates) {
    const geocodeUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(candidate)}`;
    try {
      const response = await getJson(geocodeUrl, {
        'User-Agent': 'a-better-porchfest-bot/1.0 (brookline conversion)'
      });
      if (!response.ok) {
        console.warn(`Geocoding ${candidate} returned HTTP ${response.status}`);
        continue;
      }
      const results = JSON.parse(response.body);
      if (Array.isArray(results) && results.length > 0) {
        return { lat: String(results[0].lat), lng: String(results[0].lon), query: candidate };
      }
    } catch (error) {
      console.warn(`Geocoding ${candidate} failed: ${error.message}`);
    }
  }

  return null;
}

async function runConversion() {
  const xmlContent = await fs.readFile(inputPath, 'utf8');

  const bands = {};
  const porches = {};
  const gigs = {};
  const bandIdByName = new Map();
  const legacyPorches = await loadLegacyPorches();
  const legacyPorchesByAddress = new Map(
    Object.values(legacyPorches).map(porch => [normalizeAddress(porch.address), porch])
  );

  let porchCounter = 0;
  let bandCounter = 0;
  let gigCounter = 0;
  let geocodeMisses = 0;

  const placemarkPattern = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let placemarkMatch;

  while ((placemarkMatch = placemarkPattern.exec(xmlContent)) !== null) {
    const placemarkXml = placemarkMatch[1];
    const addressMatch = placemarkXml.match(/<address>([\s\S]*?)<\/address>/);
    const nameMatch = placemarkXml.match(/<name>([\s\S]*?)<\/name>/);

    const address = decodeXml(unwrapCdata(addressMatch?.[1] || nameMatch?.[1] || ''));
    if (!address || /^Brookline Porchfest/i.test(address)) continue;

    porchCounter += 1;
    const porchId = `porch_${String(porchCounter).padStart(4, '0')}`;

    const legacyPorch = legacyPorchesByAddress.get(normalizeAddress(address));
    const geocode = manualGeocodes.get(normalizeAddress(address)) || (legacyPorch
      ? { lat: legacyPorch.lat, lng: legacyPorch.lng, query: 'Brookline 2025 data' }
      : shouldGeocode ? await geocodeAddress(address) : null);
    if (!geocode) geocodeMisses += 1;

    porches[porchId] = {
      address,
      lat: geocode?.lat || '42.338504',
      lng: geocode?.lng || '-71.125672',
      porchnum: '',
      _id: porchId,
    };

    const performancePattern = /<Data\s+name="(?:Performance\s+\d+|\d+)">[\s\S]*?<value>([\s\S]*?)<\/value>[\s\S]*?<\/Data>/g;
    let performanceMatch;

    while ((performanceMatch = performancePattern.exec(placemarkXml)) !== null) {
      const parsed = parsePerformanceLine(performanceMatch[1]);
      if (!parsed) continue;

      let bandId = bandIdByName.get(parsed.actname);
      if (!bandId) {
        bandCounter += 1;
        bandId = `band_${String(bandCounter).padStart(4, '0')}`;
        bandIdByName.set(parsed.actname, bandId);
        bands[bandId] = {
          actname: parsed.actname,
          genre: '',
          other_genre: '',
          website: '',
          facebook: '',
          instagram: '',
          bandcamp: '',
          spotify: '',
          apple: '',
          otheronline: '',
          description: '',
          image: '',
          _id: bandId,
        };
      }

      gigCounter += 1;
      const gigId = `gig_${String(gigCounter).padStart(5, '0')}`;
      gigs[gigId] = {
        bandid: bandId,
        porchid: porchId,
        starthour: parsed.starthour,
        startminute: parsed.startminute,
        duration: parsed.duration,
        _id: gigId,
      };
    }

    if (shouldGeocode) {
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  }

  const output = `const bands = ${JSON.stringify(bands, null, 4)};\n\nconst porches = ${JSON.stringify(porches, null, 4)};\n\nconst gigs = ${JSON.stringify(gigs, null, 4)};\n`;
  await fs.writeFile(outputPath, output, 'utf8');

  console.log(`Wrote ${outputPath.pathname}`);
  console.log(`Bands: ${Object.keys(bands).length}`);
  console.log(`Porches: ${Object.keys(porches).length}`);
  console.log(`Gigs: ${Object.keys(gigs).length}`);
  console.log(`Missed geocodes: ${geocodeMisses}`);
}

runConversion();
