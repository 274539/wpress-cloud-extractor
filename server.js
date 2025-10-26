import express from 'express';
import morgan from 'morgan';
import Busboy from 'busboy';
import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';
import tar from 'tar-stream';
import archiver from 'archiver';
import fs from 'fs';

const LOG_PATH = '/tmp/upload_log.txt';
const app = express();
const PORT = process.env.PORT || 3000;

const TMP_DIR = process.env.TMP_DIR || os.tmpdir();
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '1024', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// basic middleware
app.disable('x-powered-by');
app.use(morgan('tiny'));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// simple health
app.get('/health', (req, res) => res.json({ ok: true }));
// optional second health for uptime monitors
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

/**
 * Helper: detect gzip by magic number
 */
function isGzip(buffer) {
  return buffer && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/**
 * Extract a .wpress (tar or tar.gz) stream to a folder
 */
async function extractWpressToFolder(wpressPath, outDir) {
  await fse.ensureDir(outDir);

  // Read a small header to detect gzip
  const fd = await fs.promises.open(wpressPath, 'r');
  const header = Buffer.alloc(2);
  await fd.read(header, 0, 2, 0);
  await fd.close();

  const extract = tar.extract();
  const gunzip = isGzip(header) ? zlib.createGunzip() : null;

  const addFilePromises = [];
  extract.on('entry', (header, stream, next) => {
    const destPath = path.join(outDir, header.name.replace(/^\.\/+/, ''));
    if (header.type === 'directory') {
      fse.ensureDir(destPath).then(() => { stream.resume(); next(); }).catch(next);
    } else if (header.type === 'file') {
      addFilePromises.push((async () => {
        await fse.ensureDir(path.dirname(destPath));
        const write = fs.createWriteStream(destPath, { mode: header.mode || 0o644 });
        await pipeline(stream, write);
      })());
      stream.on('end', () => next());
      stream.resume();
    } else {
      // skip other types (symlink, etc.)
      stream.resume(); next();
    }
  });

  const readStream = fs.createReadStream(wpressPath);
  if (gunzip) {
    await pipeline(readStream, gunzip, extract);
  } else {
    await pipeline(readStream, extract);
  }
  await Promise.all(addFilePromises);
}

/**
 * Zip a folder and stream to response
 */
async function zipFolderToResponse(folder, res, outName = 'extracted.zip') {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', err => console.warn('zip warn', err));
  archive.on('error', err => { throw err; });

  archive.directory(folder + '/', false);
  archive.pipe(res);
  await archive.finalize();
}

/**
 * POST /extract
 * Multipart form field name: "wpress"
 * Streams upload to disk, extracts to folder, zips folder, streams zip back.
 */
app.post('/extract', async (req, res) => {
  req.setTimeout(60 * 60 * 1000); // up to 60 min
  res.setTimeout(60 * 60 * 1000);

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      fileSize: MAX_UPLOAD_MB * 1024 * 1024,   // enforce 1 GB (or env)
      files: 1
    }
  });

  let tmpFilePath = null;
  let tmpOutDir = null;
  let filename = 'backup.wpress';
  let gotFile = false;

  const cleanup = async () => {
    try { if (tmpFilePath) await fse.remove(tmpFilePath); } catch {}
    try { if (tmpOutDir) await fse.remove(tmpOutDir); } catch {}
  };

  busboy.on('file', (fieldname, file, info) => {
    if (fieldname !== 'wpress') {
      file.resume();
      return;
    }
    gotFile = true;
    filename = info.filename || filename;
    tmpFilePath = path.join(TMP_DIR, `upload-${Date.now()}-${Math.random().toString(16).slice(2)}.wpress`);
    const write = fs.createWriteStream(tmpFilePath);
    file.on('limit', () => {
      // file too large
      write.destroy();
      file.unpipe(write);
      res.status(413).json({ error: `File too large. Limit is ${MAX_UPLOAD_MB} MB.` });
      file.resume();
    });
    file.pipe(write);
  });

  busboy.on('error', async (err) => {
    console.error('busboy error', err);
    await cleanup();
    if (!res.headersSent) res.status(400).json({ error: 'Upload failed' });
  });

  busboy.on('finish', async () => {
    if (!gotFile || !tmpFilePath || !fs.existsSync(tmpFilePath)) {
      await cleanup();
      return res.status(400).json({ error: 'No file uploaded as "wpress"' });
    }

    try {
      tmpOutDir = path.join(TMP_DIR, `out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await extractWpressToFolder(tmpFilePath, tmpOutDir);

      const base = path.basename(filename).replace(/\.(wpress|tar\.gz|tar)$/i, '') || 'extracted';
      const outName = `${base}.zip`;

      // Stream zip back to client; delete tmp after stream finishes
      res.on('close', cleanup);
      await zipFolderToResponse(tmpOutDir, res, outName);
    } catch (e) {
      console.error('extract error', e);
      await cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'Extraction failed. The backup may be corrupted or too large for this tier.' });
    }
  });

  req.pipe(busboy);
});

/* ===================================================================
   NEW: POST /convert  (ZIP -> .wpress lightweight)
   - Accepts multipart/form-data with a single field named "zip"
   - Saves upload to /tmp
   - Best-effort check: looks for "wp-content/" and "database.sql" in ZIP
     central directory by scanning the last ~200KB for filenames
   - Streams back the same bytes with a .wpress filename
   - Cleans up tmp file after streaming
   NOTE: This is a rename/validation helper, not a full packer.
=================================================================== */
app.post('/convert', async (req, res) => {
  req.setTimeout(60 * 60 * 1000);
  res.setTimeout(60 * 60 * 1000);

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      fileSize: MAX_UPLOAD_MB * 1024 * 1024, // same size policy
      files: 1
    }
  });

  let tmpPath = null;
  let filename = 'backup.zip';
  let gotFile = false;

  const cleanup = async () => {
    try { if (tmpPath) await fse.remove(tmpPath); } catch {}
  };

  busboy.on('file', (fieldname, file, info) => {
    if (fieldname !== 'zip') {
      // ignore any unexpected fields
      file.resume();
      return;
    }
    gotFile = true;
    filename = info.filename || filename;
    tmpPath = path.join(TMP_DIR, `zip-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);

    const write = fs.createWriteStream(tmpPath);
    file.on('limit', () => {
      write.destroy();
      file.unpipe(write);
      res.status(413).json({ error: `File too large. Limit is ${MAX_UPLOAD_MB} MB.` });
      file.resume();
    });
    file.pipe(write);
  });

  busboy.on('error', async (err) => {
    console.error('convert busboy error', err);
    await cleanup();
    if (!res.headersSent) res.status(400).json({ error: 'Upload failed' });
  });

  busboy.on('finish', async () => {
    if (!gotFile || !tmpPath || !fs.existsSync(tmpPath)) {
      await cleanup();
      return res.status(400).json({ error: 'No file uploaded as "zip"' });
    }

    try {
      // Quick central directory sniff: read the last ~200KB of the file
      const stat = await fs.promises.stat(tmpPath);
      const tailSize = Math.min(stat.size, 200 * 1024);
      const fd = await fs.promises.open(tmpPath, 'r');
      const buf = Buffer.alloc(tailSize);
      await fd.read(buf, 0, tailSize, Math.max(0, stat.size - tailSize));
      await fd.close();

      const text = buf.toString('utf8');
      const hasWpContent = /wp-content\//i.test(text);
      const hasDbSql = /(?:^|\/)(?:database|db)\.sql/i.test(text);

      const base = path.basename(filename).replace(/\.zip$/i, '') || 'backup';
      const outName = `${base}.wpress`;

      // Set headers so the browser downloads with .wpress filename
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
      // Optional: quick-result headers (useful for debugging)
      res.setHeader('X-WP-ZIP-Check', JSON.stringify({ hasWpContent, hasDbSql }));

      const stream = fs.createReadStream(tmpPath);
      stream.on('close', () => cleanup());
      stream.pipe(res);
    } catch (e) {
      console.error('convert error', e);
      await cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'Conversion failed' });
    }
  });

  req.pipe(busboy);
});

app.listen(PORT, () => {
  console.log(`Cloud extractor listening on :${PORT}`);
});
