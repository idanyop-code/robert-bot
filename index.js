require('dotenv').config();

const http = require('http');

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // בדיקה שהשרת עובד
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200);
    return res.end('Server is running');
  }

  // אימות מול Meta
  if (req.method === 'GET' && url.pathname === '/webhook') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.writeHead(200);
      return res.end(challenge);
    }

    res.writeHead(403);
    return res.end('Verification failed');
  }

  // קבלת הודעות (בעתיד)
  if (req.method === 'POST' && url.pathname === '/webhook') {
    res.writeHead(200);
    return res.end('EVENT_RECEIVED');
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});