import { handleApi } from '../server.js';

export default async function handler(req, res) {
  let url;
  try {
    url = new URL(req.url || '/api', `https://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'คำขอไม่ถูกต้อง' }));
    return;
  }

  try {
    await handleApi(req, res, url);
  } catch (error) {
    console.error('Unhandled Vercel API error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'ระบบเกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' }));
    }
  }
}
