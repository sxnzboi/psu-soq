import { Readable } from 'node:stream';
import { handleApi } from '../../server.js';

function routeFor(requestUrl) {
  const pathname = new URL(requestUrl).pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) return pathname;
  const functionPrefix = '/.netlify/functions/api';
  if (pathname === functionPrefix) return '/api';
  if (pathname.startsWith(`${functionPrefix}/`)) return `/api${pathname.slice(functionPrefix.length)}`;
  return null;
}

export default async function handler(request, context) {
  const url = new URL(request.url);
  const route = routeFor(request.url);
  if (!route) return new Response(JSON.stringify({ error: 'ไม่พบปลายทาง' }), { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  const headers = Object.fromEntries(request.headers.entries());
  const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
  req.method = request.method;
  req.url = `${route}${url.search}`;
  req.headers = headers;
  req.socket = { remoteAddress: context.ip || headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown' };

  let statusCode = 200;
  const responseHeaders = {};
  let responseBody = Buffer.alloc(0);
  const res = {
    writeHead(status, values = {}) {
      statusCode = status;
      Object.assign(responseHeaders, values);
      return this;
    },
    end(body = Buffer.alloc(0)) {
      responseBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      return this;
    },
  };

  try {
    await handleApi(req, res, new URL(req.url, url.origin));
    if (responseBody.length === 0 && !responseHeaders['Content-Type'] && !responseHeaders['content-type']) {
      responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
      responseBody = Buffer.from(JSON.stringify({ error: 'ไม่พบข้อมูลตอบกลับจากระบบ' }));
      if (statusCode === 200) statusCode = 500;
    }
    return new Response(responseBody, { status: statusCode, headers: responseHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'ระบบเกิดข้อผิดพลาด' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}
