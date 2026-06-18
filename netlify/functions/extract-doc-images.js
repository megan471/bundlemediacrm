const https = require('https');
const http = require('http');
const zlib = require('zlib');

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Proper ZIP parser that handles deflate compression
function parseZip(buffer) {
  const files = {};
  let offset = 0;

  while (offset < buffer.length - 4) {
    // Local file header: PK\x03\x04
    if (buffer[offset] !== 0x50 || buffer[offset+1] !== 0x4b ||
        buffer[offset+2] !== 0x03 || buffer[offset+3] !== 0x04) {
      offset++;
      continue;
    }

    const compression  = buffer.readUInt16LE(offset + 8);
    const compressedSize   = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const filenameLen  = buffer.readUInt16LE(offset + 26);
    const extraLen     = buffer.readUInt16LE(offset + 28);
    const filename     = buffer.slice(offset + 30, offset + 30 + filenameLen).toString('utf8');
    const dataStart    = offset + 30 + filenameLen + extraLen;
    const compressedData = buffer.slice(dataStart, dataStart + compressedSize);

    let data;
    if (compression === 0) {
      data = compressedData; // stored
    } else if (compression === 8) {
      try { data = zlib.inflateRawSync(compressedData); } catch(e) { data = compressedData; }
    } else {
      data = compressedData;
    }

    files[filename] = data;
    offset = dataStart + compressedSize;
  }
  return files;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { docId, accessToken } = JSON.parse(event.body || '{}');
    if (!docId || !accessToken) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing docId or accessToken' }) };

    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // Step 1: Get doc JSON structure
    const docRes = await fetchUrl(`https://docs.googleapis.com/v1/documents/${docId}`, authHeaders);
    if (docRes.status !== 200) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not read Doc: ' + docRes.status }) };
    const doc = JSON.parse(docRes.body.toString());

    // Step 2: Export as DOCX zip
    const zipRes = await fetchUrl(
      `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
      authHeaders
    );

    const imagesByIndex = {};
    let debugInfo = { zipStatus: zipRes.status, fileCount: 0, imageFiles: [] };

    if (zipRes.status === 200) {
      const files = parseZip(zipRes.body);
      const allFiles = Object.keys(files);
      debugInfo.fileCount = allFiles.length;
      debugInfo.allFiles = allFiles.slice(0, 20); // first 20 for debug

      // Images in DOCX are in word/media/
      const imageFiles = allFiles
        .filter(f => f.match(/\.(png|jpg|jpeg|gif|webp|emf|wmf)$/i))
        .sort((a, b) => {
          // Sort numerically: image1.png before image2.png
          const aNum = parseInt(a.match(/\d+/) || [0]);
          const bNum = parseInt(b.match(/\d+/) || [0]);
          return aNum - bNum;
        });

      debugInfo.imageFiles = imageFiles;

      for (let i = 0; i < imageFiles.length; i++) {
        const imgData = files[imageFiles[i]];
        const ext = imageFiles[i].split('.').pop().toLowerCase();
        const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
                   : ext === 'png' ? 'image/png'
                   : ext === 'gif' ? 'image/gif'
                   : 'image/png';
        imagesByIndex[i] = `data:${mime};base64,${imgData.toString('base64')}`;
      }
    }

    // Step 3: Get plain text
    const txtRes = await fetchUrl(
      `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`,
      authHeaders
    );
    const textContent = txtRes.status === 200 ? txtRes.body.toString('utf8') : '';

    // Step 4: Parse table structure from Docs API JSON
    const pairedPosts = [];
    const body = doc.body && doc.body.content ? doc.body.content : [];

    for (const el of body) {
      if (!el.table) continue;
      for (const row of el.table.tableRows || []) {
        const cells = row.tableCells || [];
        if (cells.length < 2) continue;

        // Cell 1 = caption text
        let captionText = '';
        for (const c of cells[1].content || []) {
          if (c.paragraph) {
            for (const pe of c.paragraph.elements || []) {
              if (pe.textRun) captionText += pe.textRun.content;
            }
            captionText += '\n';
          }
        }

        if (captionText.trim().length > 5) {
          const idx = pairedPosts.length;
          pairedPosts.push({
            imageBase64: imagesByIndex[idx] || '',
            captionText: captionText.trim()
          });
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        pairedPosts,
        textContent,
        imageCount: Object.keys(imagesByIndex).length,
        debug: debugInfo
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack }) };
  }
};
