/**
 * gaia-api.js
 * Browser-side Gaia DR3 TAP bridge for GitHub Pages demos.
 *
 * Important: this module does not generate fake stars. It fetches real Gaia rows.
 * Large requests are chunked into 10k pages using source_id keyset pagination so
 * public CORS bridges are less likely to reject the payload with HTTP 413.
 */

export const GAIA_TAP_SYNC_ENDPOINT = 'https://gea.esac.esa.int/tap-server/tap/sync';

export const GAIA_BUFFER_STRIDE = Object.freeze({ POSITION: 3, HR: 2, PHOTOMETRY: 6 });

export function buildGaiaQuery(limit = 10000, mode = 'single page', lastSourceId = null) {
  const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 10000));
  const sourceFilter = lastSourceId ? `\nAND source_id > ${lastSourceId}` : '';
  return `SELECT TOP ${safeLimit} source_id, ra, dec, parallax, bp_rp, phot_g_mean_mag
FROM gaiadr3.gaia_source
WHERE parallax > 2
AND parallax_over_error > 20
AND bp_rp IS NOT NULL
AND phot_g_mean_mag IS NOT NULL${sourceFilter}
ORDER BY source_id
-- mode: ${mode}`;
}

export function formatTelemetryNumber(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function degreesToRadians(degrees) { return degrees * Math.PI / 180; }
export function distanceParsecFromParallaxMas(parallaxMas) { return 1000 / parallaxMas; }
export function absoluteMagnitudeG(apparentG, parallaxMas) { return apparentG + 5 + 5 * Math.log10(parallaxMas / 1000); }
export function raDecParallaxToCartesian(raDeg, decDeg, parallaxMas, scale = 1) {
  const distancePc = distanceParsecFromParallaxMas(parallaxMas);
  const ra = degreesToRadians(raDeg);
  const dec = degreesToRadians(decDeg);
  const cosDec = Math.cos(dec);
  return {
    x: distancePc * cosDec * Math.cos(ra) * scale,
    y: distancePc * cosDec * Math.sin(ra) * scale,
    z: distancePc * Math.sin(dec) * scale,
    distancePc
  };
}

export class GaiaDataError extends Error {
  constructor(message, cause = null) { super(message); this.name = 'GaiaDataError'; this.cause = cause; }
}

function buildTapParams(query, format = 'csv') {
  const params = new URLSearchParams();
  params.set('REQUEST', 'doQuery');
  params.set('LANG', 'ADQL');
  params.set('FORMAT', format);
  params.set('QUERY', query);
  return params;
}
function buildTapGetUrl(query, format = 'csv') { return `${GAIA_TAP_SYNC_ENDPOINT}?${buildTapParams(query, format).toString()}`; }
function buildBridgeUrls(query, format = 'csv') {
  const directGet = buildTapGetUrl(query, format);
  return [
    { label: 'ESA TAP DIRECT GET', url: directGet },
    { label: 'ALLORIGINS CORS BRIDGE', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directGet)}` },
    { label: 'CORSPROXY.IO BRIDGE', url: `https://corsproxy.io/?${encodeURIComponent(directGet)}` }
  ];
}

export class GaiaDataBridge {
  constructor(options = {}) {
    this.targetRows = options.targetRows ?? 10000;
    this.pageSize = Math.min(10000, Math.max(1000, options.pageSize ?? 10000));
    this.format = options.format ?? 'csv';
    this.positionScale = options.positionScale ?? 1;
    this.signal = options.signal ?? null;
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    this.syncTimeoutMs = options.syncTimeoutMs ?? 120000;
    this.workingRouteLabel = null;
  }

  async fetchStars() {
    const targetRows = Math.max(1, Math.min(1000000, this.targetRows));
    const positions = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.POSITION);
    const hr = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.HR);
    const photometry = new Float32Array(targetRows * GAIA_BUFFER_STRIDE.PHOTOMETRY);
    const telemetry = this.#newTelemetry();

    let acceptedTotal = 0;
    let lastSourceId = null;
    let pageIndex = 0;

    this.#emitProgress({ phase: 'INITIALIZING GAIA BRIDGE', progress: 1, parsedRows: 0, acceptedRows: 0, rejectedRows: 0 });

    while (acceptedTotal < targetRows) {
      this.#throwIfAborted();
      pageIndex += 1;
      const rowsNeeded = Math.min(this.pageSize, targetRows - acceptedTotal);
      const query = buildGaiaQuery(rowsNeeded, `page ${pageIndex}`, lastSourceId);

      this.#emitProgress({
        phase: `FETCHING GAIA PAGE ${pageIndex} / NEED ${rowsNeeded.toLocaleString()} ROWS`,
        progress: Math.min(96, (acceptedTotal / targetRows) * 100),
        parsedRows: telemetry.parsedRows,
        acceptedRows: acceptedTotal,
        rejectedRows: telemetry.rejectedRows
      });

      const csv = await this.#fetchPageWithFallbackRoutes(query, pageIndex);
      const page = await this.#parsePage(csv, telemetry);

      if (page.rows.length === 0) {
        throw new GaiaDataError(`Gaia page ${pageIndex} returned zero valid stars.`);
      }

      for (const row of page.rows) {
        if (acceptedTotal >= targetRows) break;
        const p3 = acceptedTotal * 3;
        positions[p3] = row.x; positions[p3 + 1] = row.y; positions[p3 + 2] = row.z;
        const h2 = acceptedTotal * 2;
        hr[h2] = row.bpRp; hr[h2 + 1] = row.absoluteG;
        const p6 = acceptedTotal * 6;
        photometry[p6] = row.sourceIdLow;
        photometry[p6 + 1] = row.ra;
        photometry[p6 + 2] = row.dec;
        photometry[p6 + 3] = row.parallax;
        photometry[p6 + 4] = row.gMag;
        photometry[p6 + 5] = row.distancePc;
        acceptedTotal += 1;
        lastSourceId = row.sourceIdString;
      }

      telemetry.acceptedRows = acceptedTotal;

      this.#emitProgress({
        phase: `PACKED PAGE ${pageIndex} / ${acceptedTotal.toLocaleString()} STARS READY`,
        progress: Math.min(99, (acceptedTotal / targetRows) * 100),
        parsedRows: telemetry.parsedRows,
        acceptedRows: acceptedTotal,
        loadedRows: acceptedTotal,
        rejectedRows: telemetry.rejectedRows
      });

      if (page.rows.length < rowsNeeded) break;
      await this.#yieldToMainThread(250);
    }

    if (acceptedTotal === 0) throw new GaiaDataError('No valid Gaia rows survived physical validation.');

    this.#emitProgress({ phase: 'GAIA GPU BUFFERS READY', progress: 100, parsedRows: telemetry.parsedRows, acceptedRows: acceptedTotal, loadedRows: acceptedTotal, rejectedRows: telemetry.rejectedRows });

    return {
      count: acceptedTotal,
      positions: positions.subarray(0, acceptedTotal * 3),
      hr: hr.subarray(0, acceptedTotal * 2),
      photometry: photometry.subarray(0, acceptedTotal * 6),
      stride: GAIA_BUFFER_STRIDE,
      telemetry,
      source: 'ESA Gaia DR3',
      generatedAt: new Date().toISOString()
    };
  }

  async #fetchPageWithFallbackRoutes(query, pageIndex) {
    const errors = [];
    const routes = [];
    if (!this.workingRouteLabel) routes.push({ label: 'ESA TAP DIRECT POST', type: 'post' });
    const bridgeRoutes = buildBridgeUrls(query, this.format);
    if (this.workingRouteLabel) {
      const preferred = bridgeRoutes.find(route => route.label === this.workingRouteLabel);
      if (preferred) routes.push(preferred);
      for (const route of bridgeRoutes) if (route.label !== this.workingRouteLabel) routes.push(route);
    } else {
      routes.push(...bridgeRoutes);
    }

    for (const route of routes) {
      try {
        this.#throwIfAborted();
        this.#emitProgress({ phase: `PAGE ${pageIndex}: TRYING ${route.label}`, progress: 3 });
        let text;
        if (route.type === 'post') text = await this.#fetchViaDirectPost(query, pageIndex);
        else text = await this.#fetchViaGet(route.url, route.label, pageIndex);
        this.workingRouteLabel = route.label;
        return text;
      } catch (error) {
        errors.push(`${route.label}: ${error?.message || error}`);
        this.#emitProgress({ phase: `PAGE ${pageIndex}: ${route.label} FAILED`, progress: 5 });
        await this.#yieldToMainThread(200);
      }
    }

    throw new GaiaDataError(`All Gaia TAP browser routes failed on page ${pageIndex}. ${errors.join(' | ')}`);
  }

  async #fetchViaDirectPost(query, pageIndex) {
    const controller = this.#createLinkedAbortController(this.syncTimeoutMs);
    const response = await fetch(GAIA_TAP_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Accept': 'text/csv,text/plain,*/*' },
      body: buildTapParams(query, this.format),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store'
    });
    if (!response.ok) throw new GaiaDataError(`Gaia TAP returned HTTP ${response.status}`);
    return await this.#readResponseTextWithProgress(response, { phase: `PAGE ${pageIndex}: DOWNLOADING DIRECT POST`, startProgress: 8, endProgress: 58 });
  }

  async #fetchViaGet(url, label, pageIndex) {
    const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'text/csv,text/plain,*/*' }, signal: this.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new GaiaDataError(`${label} returned HTTP ${response.status}`);
    return await this.#readResponseTextWithProgress(response, { phase: `PAGE ${pageIndex}: DOWNLOADING VIA ${label}`, startProgress: 8, endProgress: 58 });
  }

  async #readResponseTextWithProgress(response, options) {
    const total = Number(response.headers.get('content-length')) || 0;
    if (!response.body || !response.body.getReader) {
      const text = await response.text(); this.#validateResponseText(text); this.#emitProgress({ phase: options.phase, progress: options.endProgress }); return text;
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); const chunks = [];
    let received = 0, syntheticProgress = options.startProgress;
    while (true) {
      this.#throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true })); received += value.byteLength;
      let progress;
      if (total > 0) progress = options.startProgress + (received / total) * (options.endProgress - options.startProgress);
      else { syntheticProgress = Math.min(options.endProgress - 2, syntheticProgress + 0.8); progress = syntheticProgress; }
      this.#emitProgress({ phase: `${options.phase} / ${(received/1024/1024).toFixed(1)} MB`, progress });
      await this.#yieldToMainThread(0);
    }
    chunks.push(decoder.decode());
    const text = chunks.join(''); this.#validateResponseText(text);
    this.#emitProgress({ phase: options.phase, progress: options.endProgress });
    return text;
  }

  #validateResponseText(text) {
    if (!text || text.trim().length < 20) throw new GaiaDataError('Gaia TAP returned an empty response.');
    const trimmed = text.trim(); const sample = trimmed.slice(0, 1400).toLowerCase();
    if (sample.includes('<html') || sample.includes('<!doctype html')) throw new GaiaDataError('Gaia TAP returned HTML instead of CSV.');
    if (sample.includes('error') && sample.includes('exception')) throw new GaiaDataError('Gaia TAP returned a service exception.');
    if (trimmed.startsWith('{') && sample.includes('error')) throw new GaiaDataError('A CORS bridge returned an error JSON response.');
    if (trimmed.startsWith('<')) throw new GaiaDataError('Gaia TAP returned XML/VOTable, but this app expects CSV.');
    const firstLine = trimmed.split(/\r?\n/, 1)[0].toLowerCase();
    if (!firstLine.includes('source_id') || !firstLine.includes('ra') || !firstLine.includes('parallax')) throw new GaiaDataError('Response did not look like the expected Gaia CSV table.');
  }

  async #parsePage(csvText, telemetry) {
    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) throw new GaiaDataError('Gaia CSV contained no data rows.');
    const header = this.#parseCsvLine(lines[0]).map(v => v.trim().toLowerCase());
    const indices = this.#resolveColumnIndices(header);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]; if (!line || !line.trim()) continue;
      telemetry.parsedRows += 1;
      const cols = this.#parseCsvLine(line);
      const sourceIdString = String(cols[indices.source_id]).trim();
      const sourceIdLow = Number(sourceIdString.slice(-12));
      const ra = Number(cols[indices.ra]); const dec = Number(cols[indices.dec]); const parallax = Number(cols[indices.parallax]); const bpRp = Number(cols[indices.bp_rp]); const gMag = Number(cols[indices.phot_g_mean_mag]);
      if (!sourceIdString || !Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(parallax) || !Number.isFinite(bpRp) || !Number.isFinite(gMag) || parallax <= 0) { telemetry.rejectedRows += 1; continue; }
      const cart = raDecParallaxToCartesian(ra, dec, parallax, this.positionScale);
      const absoluteG = absoluteMagnitudeG(gMag, parallax);
      if (!Number.isFinite(cart.x) || !Number.isFinite(cart.y) || !Number.isFinite(cart.z) || !Number.isFinite(cart.distancePc) || !Number.isFinite(absoluteG)) { telemetry.rejectedRows += 1; continue; }
      telemetry.minDistancePc = Math.min(telemetry.minDistancePc, cart.distancePc); telemetry.maxDistancePc = Math.max(telemetry.maxDistancePc, cart.distancePc);
      telemetry.minMG = Math.min(telemetry.minMG, absoluteG); telemetry.maxMG = Math.max(telemetry.maxMG, absoluteG);
      telemetry.minBpRp = Math.min(telemetry.minBpRp, bpRp); telemetry.maxBpRp = Math.max(telemetry.maxBpRp, bpRp);
      rows.push({ sourceIdString, sourceIdLow, ra, dec, parallax, bpRp, gMag, absoluteG, distancePc: cart.distancePc, x: cart.x, y: cart.y, z: cart.z });
      if (i % 3000 === 0) {
        this.#emitProgress({ phase: `PARSING PAGE / ${rows.length.toLocaleString()} VALID STARS`, progress: 62, parsedRows: telemetry.parsedRows, acceptedRows: telemetry.acceptedRows + rows.length, rejectedRows: telemetry.rejectedRows });
        await this.#yieldToMainThread(0);
      }
    }
    return { rows };
  }

  #newTelemetry() {
    return { parsedRows: 0, acceptedRows: 0, rejectedRows: 0, minDistancePc: Infinity, maxDistancePc: -Infinity, minMG: Infinity, maxMG: -Infinity, minBpRp: Infinity, maxBpRp: -Infinity };
  }
  #resolveColumnIndices(header) {
    const required = ['source_id', 'ra', 'dec', 'parallax', 'bp_rp', 'phot_g_mean_mag'];
    const indices = {};
    for (const col of required) { const idx = header.indexOf(col); if (idx === -1) throw new GaiaDataError(`Gaia CSV is missing required column "${col}".`); indices[col] = idx; }
    return indices;
  }
  #parseCsvLine(line) {
    const out = []; let current = ''; let quoted = false;
    for (let i=0; i<line.length; i++) { const ch = line[i]; if (ch === '"') { if (quoted && line[i+1] === '"') { current += '"'; i++; } else quoted = !quoted; } else if (ch === ',' && !quoted) { out.push(current); current = ''; } else current += ch; }
    out.push(current); return out;
  }
  #emitProgress(payload) { this.onProgress({ parsedRows: payload.parsedRows, acceptedRows: payload.acceptedRows, loadedRows: payload.loadedRows, rejectedRows: payload.rejectedRows, phase: payload.phase ?? 'PROCESSING', progress: Math.max(0, Math.min(100, Number(payload.progress ?? 0))) }); }
  #createLinkedAbortController(timeoutMs) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs); const abort = () => controller.abort();
    if (this.signal) { if (this.signal.aborted) controller.abort(); else this.signal.addEventListener('abort', abort, { once: true }); }
    controller.signal.addEventListener('abort', () => { clearTimeout(timeout); if (this.signal) this.signal.removeEventListener('abort', abort); }, { once: true });
    return controller;
  }
  #throwIfAborted() { if (this.signal?.aborted) throw new DOMException('Gaia data request was aborted.', 'AbortError'); }
  #yieldToMainThread(ms = 0) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

export async function fetchGaiaDR3Stars(options = {}) { const bridge = new GaiaDataBridge(options); return await bridge.fetchStars(); }
export function estimateGpuMemoryBytes(dataset) { if (!dataset) return 0; return (dataset.positions?.byteLength || 0) + (dataset.hr?.byteLength || 0) + (dataset.photometry?.byteLength || 0); }
