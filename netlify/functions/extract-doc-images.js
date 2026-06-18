const https = require('https');
const http = require('http');

// Helper to make HTTPS requests
function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { docId, accessToken } = JSON.parse(event.body || '{}');
    if (!docId || !accessToken) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing docId or accessToken' }) };
    }

    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // Step 1: Get doc structure via Docs API
    const docRes = await fetchUrl(
      `https://docs.googleapis.com/v1/documents/${docId}`,
      authHeaders
    );
    if (docRes.status !== 200) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not read Doc. Check credentials.' }) };
    }
    const doc = JSON.parse(docRes.body.toString());

    // Step 2: Export as zip to get images
    const zipRes = await fetchUrl(
      `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=application/zip`,
      authHeaders
    );

    let imagesByIndex = {};

    if (zipRes.status === 200) {
      // Parse zip in-memory using built-in methods
      const zipBuffer = zipRes.body;

      // Simple ZIP parser - find all image files
      const images = [];
      let offset = 0;

      while (offset < zipBuffer.length - 4) {
        // Local file header signature: 0x04034b50
        if (zipBuffer[offset] === 0x50 && zipBuffer[offset+1] === 0x4b &&
            zipBuffer[offset+2] === 0x03 && zipBuffer[offset+3] === 0x04) {

          const compression = zipBuffer.readUInt16LE(offset + 8);
          const compressedSize = zipBuffer.readUInt32LE(offset + 18);
          const filenameLength = zipBuffer.readUInt16LE(offset + 26);
          const extraLength = zipBuffer.readUInt16LE(offset + 28);
          const filename = zipBuffer.slice(offset + 30, offset + 30 + filenameLength).toString('utf8');
          const dataOffset = offset + 30 + filenameLength + extraLength;

          if (filename.match(/\.(png|jpg|jpeg|gif|webp)$/i) && compression === 0) {
            const imgData = zipBuffer.slice(dataOffset, dataOffset + compressedSize);
            const ext = filename.split('.').pop().toLowerCase();
            const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : `image/${ext}`;
            const base64 = `data:${mime};base64,${imgData.toString('base64')}`;
            images.push({ filename, base64 });
          }

          offset = dataOffset + compressedSize;
        } else {
          offset++;
        }
      }

      // Sort images by filename (image1.png, image2.png etc)
      images.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
      images.forEach((img, i) => { imagesByIndex[i] = img.base64; });
    }

    // Step 3: Get plain text for caption parsing
    const txtRes = await fetchUrl(
      `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`,
      authHeaders
    );
    const textContent = txtRes.status === 200 ? txtRes.body.toString('utf8') : '';

    // Step 4: Parse table structure from Docs API JSON to pair images with captions
    const pairedPosts = [];
    const body = doc.body && doc.body.content ? doc.body.content : [];

    for (const el of body) {
      if (!el.table) continue;
      let imageIndex = 0;

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
          pairedPosts.push({
            imageBase64: imagesByIndex[pairedPosts.length] || '',
            captionText: captionText.trim()
          });
        }
        imageIndex++;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        pairedPosts,
        textContent,
        imageCount: Object.keys(imagesByIndex).length
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
