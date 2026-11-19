#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import readline from 'node:readline';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SESSION_SECONDS = 8 * 60 * 60;
const PBKDF2_ROUNDS = 310_000;
const ACCESS_CODE_RE = /^[A-Za-z0-9-]{8,64}$/;
const loginFailures = new Map();

function loadEnv(contents) {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    process.env[key] ??= value;
  }
}
// Read .env before loading configuration.
let envContents = '';
try {
  envContents = await readFile(path.join(ROOT, '.env'), 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
loadEnv(envContents);

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || 'https://tgxpmteefsxuzafjbadl.supabase.co').replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('ตั้งค่า SUPABASE_URL และ SUPABASE_SECRET_KEY ก่อนเริ่มระบบ');
  if (!url.startsWith('https://')) throw new Error('SUPABASE_URL ต้องใช้ HTTPS');
  return { url, key };
}

class SupabaseError extends Error {
  constructor(status) { super(`Supabase request failed (${status})`); this.status = status; }
}

async function supabaseRequest(method, resource, payload, options = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${resource}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeout || 15_000),
  }).catch(() => { throw new Error('เชื่อมต่อ Supabase ไม่สำเร็จ'); });
  const raw = await response.text();
  if (!response.ok) throw new SupabaseError(response.status);
  return raw ? JSON.parse(raw) : null;
}

function restQuery(table, params) {
  const query = new URLSearchParams(params);
  return `${table}?${query.toString()}`;
}
function codeLookup(code) {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}
function codeDigest(code, salt = randomBytes(16)) {
  const digest = pbkdf2Sync(Buffer.from(code.trim().toLowerCase(), 'utf8'), salt, PBKDF2_ROUNDS, 32, 'sha256');
  return [digest.toString('base64'), salt.toString('base64')];
}
function equalStrings(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
async function createUser(code, displayName, position, role) {
  code = code.trim(); displayName = displayName.trim(); position = position.trim();
  if (!ACCESS_CODE_RE.test(code)) throw new Error('รหัสเข้าสู่ระบบต้องมี 8–64 ตัว และใช้ตัวอักษรอังกฤษ ตัวเลข หรือขีดกลาง');
  if (!displayName || displayName.length > 100) throw new Error('กรุณาระบุชื่อผู้ใช้ไม่เกิน 100 ตัวอักษร');
  if (position.length > 100) throw new Error('ตำแหน่งต้องไม่เกิน 100 ตัวอักษร');
  if (!['admin', 'judge'].includes(role)) throw new Error('สิทธิ์ผู้ใช้ไม่ถูกต้อง');
  const [digest, salt] = codeDigest(code);
  const rows = await supabaseRequest('POST', 'app_users?select=id,display_name,position,role,active,created_at', {
    display_name: displayName, position, role,
    access_code_lookup: codeLookup(code), access_code_hash: digest, access_code_salt: salt,
  });
  return rows?.[0] || {};
}
async function findUserByCode(code) {
  const query = restQuery('app_users', {
    select: 'id,display_name,position,role,access_code_hash,access_code_salt,active',
    access_code_lookup: `eq.${codeLookup(code)}`, active: 'eq.true', limit: '1',
  });
  const rows = await supabaseRequest('GET', query);
  return rows?.[0] || null;
}
async function findUserById(id) {
  const query = restQuery('app_users', { select: 'id,display_name,position,role,active', id: `eq.${id}`, active: 'eq.true', limit: '1' });
  const rows = await supabaseRequest('GET', query);
  return rows?.[0] || null;
}
function publicUser(row) {
  return Object.fromEntries(['id', 'display_name', 'position', 'role'].map(key => [key, row[key]]));
}

const DEFAULT_CRITERIA = {
  person: [
    { label: 'ผลงานและความโดดเด่นของกิจกรรม', max: 25 },
    { label: 'ประโยชน์และการสร้างคุณค่าต่อส่วนรวม', max: 25 },
    { label: 'ภาวะผู้นำและการทำงานเป็นทีม', max: 25 },
    { label: 'การนำเสนอและการตอบข้อซักถาม', max: 25 },
  ],
  project: [
    { label: 'ความสอดคล้องกับวัตถุประสงค์และเป้าหมาย', max: 25 },
    { label: 'การวางแผนและการบริหารจัดการโครงการ', max: 25 },
    { label: 'ผลสัมฤทธิ์และผลกระทบของโครงการ', max: 25 },
    { label: 'การนำเสนอและการตอบข้อซักถาม', max: 25 },
  ],
};

async function getSettings() {
  const rows = await supabaseRequest('GET', 'app_settings?select=*&id=eq.1&limit=1');
  const settings = rows?.[0] || {};
  if (!Array.isArray(settings.person_criteria) || !settings.person_criteria.length) {
    settings.person_criteria = DEFAULT_CRITERIA.person;
  }
  if (!Array.isArray(settings.project_criteria) || !settings.project_criteria.length) {
    settings.project_criteria = DEFAULT_CRITERIA.project;
  }
  return settings;
}
async function updateSettings(values) {
  const allowed = {};
  for (const key of ['submissions_open', 'submissions_start', 'submissions_end', 'success_message', 'scoring_open', 'homepage_title', 'homepage_intro', 'site_logo_path', 'results_content', 'results_committee', 'results_approved', 'results_approved_by', 'results_approved_at', 'person_criteria', 'project_criteria']) {
    if (key in values) allowed[key] = values[key];
  }
  allowed.updated_at = new Date().toISOString();
  const rows = await supabaseRequest('PATCH', 'app_settings?id=eq.1&select=*', allowed);
  return rows?.[0] || {};
}
async function storageRequest(resource, method, body, contentType = 'application/json', timeout = 30_000) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/storage/v1/${resource}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': contentType },
    body, signal: AbortSignal.timeout(timeout),
  }).catch(() => { throw new Error('เชื่อมต่อ Supabase Storage ไม่สำเร็จ'); });
  const raw = await response.text();
  if (!response.ok) throw new SupabaseError(response.status);
  return raw ? JSON.parse(raw) : null;
}
async function uploadStorageObject(objectPath, content, contentType) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  await storageRequest(`object/awards-submissions/${encoded}`, 'POST', content, contentType, 60_000);
}
async function deleteStorageObjects(paths) {
  if (!paths.length) return;
  try { await storageRequest('object/awards-submissions', 'DELETE', JSON.stringify({ prefixes: paths })); } catch { /* best effort cleanup */ }
}
const signedUrlCache = new Map();

async function createSignedFileUrl(objectPath) {
  if (!objectPath) return '';
  if (objectPath.startsWith('data:') || /^https?:\/\//.test(objectPath)) return objectPath;
  const now = Date.now();
  const cached = signedUrlCache.get(objectPath);
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.url;
  }
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  const result = await storageRequest(`object/sign/awards-submissions/${encoded}`, 'POST', JSON.stringify({ expiresIn: 86400 * 30 }));
  let signed = result?.signedURL || '';
  if (!signed) throw new Error('ไม่สามารถสร้างลิงก์สำหรับเปิดไฟล์ได้');
  if (!/^https?:\/\//.test(signed)) {
    if (signed.startsWith('/storage/v1/')) signed = `${supabaseConfig().url}${signed}`;
    else signed = `${supabaseConfig().url}/storage/v1${signed.startsWith('/') ? signed : `/${signed}`}`;
  }
  signedUrlCache.set(objectPath, { url: signed, expiresAt: now + 86400_000 * 15 });
  return signed;
}

function json(res, status, data, headers = {}) {
  const payload = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': payload.length, ...headers });
  res.end(payload);
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    if (req.headers['sec-fetch-site'] === 'same-origin') return true;
    return false;
  }
  try {
    const parsed = new URL(origin);
    const hostHeaders = [
      req.headers['x-forwarded-host'],
      req.headers.host
    ].filter(Boolean).map(h => String(h).toLowerCase());
    const originHost = parsed.host.toLowerCase();
    if (hostHeaders.some(h => h === originHost || h.split(',')[0].trim() === originHost)) return true;
    const isLocalOrigin = originHost.startsWith('localhost:') || originHost.startsWith('127.0.0.1:') || originHost === 'localhost' || originHost === '127.0.0.1';
    const isLocalHost = hostHeaders.some(h => h.startsWith('localhost:') || h.startsWith('127.0.0.1:') || h === 'localhost' || h === '127.0.0.1');
    if (isLocalOrigin && isLocalHost) return true;
    return false;
  } catch { return false; }
}
async function readJson(req, maxBytes = 65_536) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('ขนาดข้อมูลไม่ถูกต้อง');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('รูปแบบข้อมูลไม่ถูกต้อง'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
  return value;
}
function sessionToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
async function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const rows = await supabaseRequest('GET', restQuery('app_sessions', {
    select: 'user_id', token_hash: `eq.${tokenHash}`, expires_at: `gt.${Math.floor(Date.now() / 1000)}`, limit: '1',
  }));
  return rows?.length ? findUserById(Number(rows[0].user_id)) : null;
}
function requireSameOrigin(req, res) {
  if (sameOrigin(req)) return true;
  json(res, 403, { error: 'คำขอไม่ผ่านการตรวจสอบต้นทาง' });
  return false;
}
function failureList(ip) {
  const now = Date.now();
  const list = (loginFailures.get(ip) || []).filter(time => now - time < 15 * 60_000);
  loginFailures.set(ip, list);
  return list;
}
async function requireAdmin(req, res) {
  const user = await currentUser(req);
  if (!user) { json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' }); return null; }
  if (user.role !== 'admin') { json(res, 403, { error: 'เฉพาะแอดมินเท่านั้น' }); return null; }
  return user;
}
async function adminGet(req, res, pathName) {
  if (pathName === '/api/admin/settings') {
    if (!await requireAdmin(req, res)) return true;
    json(res, 200, { settings: await getSettings() }); return true;
  }
  if (pathName === '/api/admin/dashboard') {
    if (!await requireAdmin(req, res)) return true;
    const [submissions, judges, settings] = await Promise.all([
      supabaseRequest('GET', 'submissions?select=id&limit=1000'),
      supabaseRequest('GET', restQuery('app_users', { select: 'id', role: 'eq.judge', active: 'eq.true', limit: '1000' })),
      getSettings(),
    ]);
    json(res, 200, { submissions_count: submissions?.length || 0, submissions_count_capped: (submissions?.length || 0) === 1000, active_judges_count: judges?.length || 0, scoring_open: !!settings.scoring_open, results_approved: !!settings.results_approved }); return true;
  }
  if (pathName === '/api/admin/scores') {
    if (!await requireAdmin(req, res)) return true;
    const [scores, submissions, judges, settings] = await Promise.all([
      supabaseRequest('GET', 'submission_scores?select=submission_id,judge_user_id,scores,total,updated_at&order=updated_at.desc'),
      supabaseRequest('GET', 'submissions?select=id,category_type,category,title,submitter_name,student_id'),
      supabaseRequest('GET', 'app_users?select=id,display_name,position&role=eq.judge'),
      getSettings(),
    ]);
    const bySubmission = new Map((submissions || []).map(row => [Number(row.id), row]));
    const byJudge = new Map((judges || []).map(row => [Number(row.id), row]));
    json(res, 200, {
      scores: (scores || []).map(score => ({ ...score, submission: bySubmission.get(Number(score.submission_id)) || null, judge: byJudge.get(Number(score.judge_user_id)) || null })),
      criteria: { person: settings.person_criteria || [], project: settings.project_criteria || [] }
    });
    return true;
  }
  if (pathName === '/api/admin/results') {
    if (!await requireAdmin(req, res)) return true;
    const s = await getSettings();
    json(res, 200, { results_content: s.results_content || '', results_committee: s.results_committee || '', results_approved: !!s.results_approved, results_approved_at: s.results_approved_at, results_approved_by: s.results_approved_by }); return true;
  }
  if (pathName === '/api/admin/judges') {
    if (!await requireAdmin(req, res)) return true;
    const rows = await supabaseRequest('GET', restQuery('app_users', { select: 'id,display_name,position,role,active,created_at', role: 'eq.judge', order: 'id.desc' }));
    json(res, 200, { judges: rows || [] }); return true;
  }
  if (pathName === '/api/admin/submissions') {
    if (!await requireAdmin(req, res)) return true;
    const rows = await supabaseRequest('GET', restQuery('submissions', {
      select: 'id,category_type,category,title,submitter_name,student_id,faculty,phone,email,organization_position,video_url,details,proposal_file_name,presentation_file_name,status,created_at',
      order: 'created_at.desc',
    }));
    json(res, 200, { submissions: rows || [] }); return true;
  }
  if (pathName === '/api/admin/announcements') {
    if (!await requireAdmin(req, res)) return true;
    const rows = await supabaseRequest('GET', restQuery('announcements', { select: 'id,title,body,published,published_at,created_at', order: 'created_at.desc' }));
    json(res, 200, { announcements: rows || [] }); return true;
  }
  if (pathName === '/api/admin/homepage-cards') {
    if (!await requireAdmin(req, res)) return true;
    const rows = await supabaseRequest('GET', restQuery('homepage_cards', { select: 'slug,title,description,badge,link_label,target_url,published,updated_at', order: 'slug.asc' }));
    json(res, 200, { cards: rows || [] }); return true;
  }
  if (pathName === '/api/admin/project-details') {
    if (!await requireAdmin(req, res)) return true;
    const rows = await supabaseRequest('GET', restQuery('project_details', { select: 'id,title,body,published,published_at,created_at', order: 'created_at.desc' }));
    json(res, 200, { details: rows || [] }); return true;
  }
  return false;
}

async function validateSettings(body) {
  const result = {};
  if ('submissions_open' in body) {
    if (typeof body.submissions_open !== 'boolean') throw new Error('สถานะเปิดรับผลงานไม่ถูกต้อง');
    result.submissions_open = body.submissions_open;
  }
  for (const key of ['submissions_start', 'submissions_end']) {
    if (key in body) {
      const value = body[key] || null;
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
      result[key] = value;
    }
  }
  if ('success_message' in body) {
    const message = String(body.success_message).trim();
    if (!message || message.length > 500) throw new Error('ข้อความยืนยันต้องมีความยาว 1–500 ตัวอักษร');
    result.success_message = message;
  }
  if ('scoring_open' in body) {
    if (typeof body.scoring_open !== 'boolean') throw new Error('สถานะรับคะแนนไม่ถูกต้อง');
    result.scoring_open = body.scoring_open;
  }
  for (const key of ['person_criteria', 'project_criteria']) {
    if (key in body) {
      const criteria = body[key];
      if (!Array.isArray(criteria) || !criteria.length || criteria.length > 10) throw new Error('แต่ละประเภทต้องมีเกณฑ์ 1–10 ข้อ');
      let sum = 0;
      result[key] = criteria.map(item => {
        const label = String(item?.label || '').trim(); const max = item?.max;
        if (!label || label.length > 160 || !Number.isInteger(max) || max < 1 || max > 100) throw new Error('เกณฑ์ต้องมีชื่อและคะแนนเต็มเป็นจำนวนเต็ม 1–100');
        sum += max; return { label, max };
      });
      if (sum !== 100) throw new Error('คะแนนเต็มของเกณฑ์ต้องรวมกันได้ 100');
    }
  }
  for (const [key, max, label] of [['homepage_title', 160, 'ชื่อเว็บไซต์'], ['homepage_intro', 1000, 'ข้อความประชาสัมพันธ์']]) {
    if (key in body) {
      const value = String(body[key] ?? '').trim();
      if (key === 'homepage_title' && !value) throw new Error('กรุณาระบุชื่อเว็บไซต์');
      if (value.length > max) throw new Error(`${label}ยาวเกินกำหนด`);
      result[key] = value;
    }
  }
  if ('results_content' in body || 'results_committee' in body) {
    for (const [key, max, label] of [['results_content', 10000, 'ผลการคัดเลือก'], ['results_committee', 5000, 'รายชื่อคณะกรรมการ']]) {
      if (key in body) {
        const value = String(body[key] ?? '').trim();
        if (value.length > max) throw new Error(`${label}ยาวเกินกำหนด`);
        result[key] = value;
      }
    }
    result.results_approved = false;
    result.results_approved_by = null;
    result.results_approved_at = null;
  }
  if (result.submissions_start && result.submissions_end && result.submissions_start > result.submissions_end) throw new Error('วันเริ่มรับต้องไม่อยู่หลังวันปิดรับ');
  return result;
}

function safeFilename(value) {
  const name = path.basename(String(value).replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '').trim().replace(/^[ .]+|[ .]+$/g, '').slice(0, 160);
  if (!name || !path.extname(name)) throw new Error('ชื่อไฟล์ไม่ถูกต้อง');
  return name;
}
function signatureMatches(extension, content) {
  const signatures = {
    '.pdf': Buffer.from('%PDF-'), '.doc': Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    '.docx': Buffer.from('PK\x03\x04'), '.ppt': Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    '.pptx': Buffer.from('PK\x03\x04'),
  };
  const signature = signatures[extension];
  return signature && content.length >= signature.length && content.subarray(0, signature.length).equals(signature);
}
async function parseMultipart(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 55 * 1024 * 1024) throw new Error('ขนาดข้อมูลรวมต้องไม่เกิน 55 MB');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const contentType = String(req.headers['content-type'] || '');
  const request = new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body: raw, duplex: 'half' });
  let form;
  try { form = await request.formData(); } catch (err) {
    console.error('Multipart form parse error:', err);
    throw new Error('อ่านข้อมูลฟอร์มไม่สำเร็จ');
  }
  const fields = {}; const files = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
    else files[key] = { filename: value.name, content: Buffer.from(await value.arrayBuffer()), contentType: value.type };
  }
  return { fields, files };
}
function validateSubmission(fields, files) {
  const categoryType = fields.type || '';
  if (!['person', 'project'].includes(categoryType)) throw new Error('กรุณาเลือกประเภทผลงาน');
  const categories = {
    person: new Set(['ด้านผู้นำ', 'ด้านวิชาการ', 'ด้านศิลปวัฒนธรรม', 'ด้านการบำเพ็ญประโยชน์ต่อเพื่อนมนุษย์', 'ด้านกีฬา', 'ด้านสันทนาการ']),
    project: new Set(['ด้านวิชาการ', 'ด้านศิลปวัฒนธรรมและศาสนา', 'ด้านการบำเพ็ญประโยชน์ของเพื่อนมนุษย์', 'ด้านกีฬา', 'ด้านนันทนาการ']),
  };
  if (!categories[categoryType].has(fields.category)) throw new Error('ด้านที่เลือกไม่ตรงกับประเภทผลงาน');
  for (const key of ['submitter_name', 'student_id', 'faculty', 'phone']) if (!String(fields[key] || '').trim()) throw new Error('กรุณากรอกชื่อ รหัสนักศึกษา คณะ และเบอร์โทรศัพท์ให้ครบ');
  if (!/^[0-9]{8,12}$/.test(fields.student_id)) throw new Error('รหัสนักศึกษาต้องเป็นตัวเลข 8–12 หลัก');
  let title = String(fields.title || '').trim() || null;
  let organizationPosition = String(fields.organization_position || '').trim() || null;
  if (categoryType === 'project' && (!title || !organizationPosition)) throw new Error('ผลงานประเภทโครงการต้องระบุชื่อโครงการและตำแหน่งในองค์กร');
  if (categoryType === 'person') { title = null; organizationPosition = null; }
  const limits = { submitter_name: 120, student_id: 30, faculty: 160, phone: 40, email: 254, title: 250, organization_position: 120, video_url: 2000, details: 5000 };
  for (const [key, limit] of Object.entries(limits)) if (String(fields[key] || '').length > limit) throw new Error('ข้อมูลบางช่องยาวเกินกำหนด');
  const email = String(fields.email || '').trim() || null;
  if (email && (!email.includes('@') || email.includes(' '))) throw new Error('รูปแบบอีเมลไม่ถูกต้อง');
  const videoUrl = String(fields.video_url || '').trim() || null;
  if (videoUrl) { let parsed; try { parsed = new URL(videoUrl); } catch { throw new Error('ลิงก์วิดีโอต้องขึ้นต้นด้วย http:// หรือ https://'); } if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('ลิงก์วิดีโอต้องขึ้นต้นด้วย http:// หรือ https://'); }
  if (Object.keys(files).sort().join(',') !== 'presentation,proposal') throw new Error('กรุณาแนบแบบฟอร์มและไฟล์นำเสนอให้ครบ');
  const allowed = { proposal: new Set(['.pdf', '.doc', '.docx']), presentation: new Set(['.pdf', '.ppt', '.pptx']) };
  const maxBytes = { proposal: 20 * 1024 * 1024, presentation: 30 * 1024 * 1024 };
  const cleanedFiles = {};
  for (const [field, file] of Object.entries(files)) {
    const filename = safeFilename(file.filename); const extension = path.extname(filename).toLowerCase();
    if (!allowed[field].has(extension)) throw new Error('ชนิดไฟล์ไม่รองรับ');
    if (!file.content.length || file.content.length > maxBytes[field]) throw new Error('ขนาดไฟล์ไม่ถูกต้องหรือเกินกำหนด');
    if (!signatureMatches(extension, file.content)) throw new Error('เนื้อหาไฟล์ไม่ตรงกับนามสกุลไฟล์');
    cleanedFiles[field] = { ...file, filename, extension };
  }
  return {
    row: {
      category_type: categoryType, category: fields.category, title,
      submitter_name: fields.submitter_name, student_id: fields.student_id,
      faculty: fields.faculty, phone: fields.phone, email,
      organization_position: organizationPosition, video_url: videoUrl,
      details: String(fields.details || '').trim() || null,
    }, files: cleanedFiles,
  };
}
function submissionsAreOpen(settings) {
  if (!settings.submissions_open) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return (!settings.submissions_start || today >= settings.submissions_start) && (!settings.submissions_end || today <= settings.submissions_end);
}
async function createSubmission(req, res) {
  const uploaded = [];
  try {
    const settings = await getSettings();
    if (!submissionsAreOpen(settings)) return json(res, 403, { error: 'ขณะนี้ปิดรับผลงานแล้ว' });
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data;')) throw new Error('รูปแบบฟอร์มไม่ถูกต้อง');
    const { fields, files } = await parseMultipart(req);
    const { row, files: cleanFiles } = validateSubmission(fields, files);
    const id = randomUUID().replaceAll('-', '');
    for (const key of ['proposal', 'presentation']) {
      const file = cleanFiles[key];
      const objectPath = `submissions/${id}/${key}${file.extension}`;
      await uploadStorageObject(objectPath, file.content, file.contentType || 'application/octet-stream');
      uploaded.push(objectPath);
      row[`${key}_file_path`] = objectPath;
      row[`${key}_file_name`] = file.filename;
    }
    const rows = await supabaseRequest('POST', 'submissions?select=id,created_at', row);
    json(res, 201, { submission_id: rows?.[0]?.id, message: settings.success_message || 'ส่งผลงานสำเร็จ ระบบได้รับข้อมูลของท่านแล้ว' });
  } catch (error) {
    await deleteStorageObjects(uploaded);
    if (error instanceof SupabaseError) {
      console.error(`Supabase submission error: HTTP ${error.status}`);
      json(res, 503, { error: 'บันทึกผลงานไม่สำเร็จ กรุณาลองใหม่' });
    } else if (error.message?.includes('Supabase')) {
      console.error('Supabase submission error:', error.message);
      json(res, 503, { error: 'เชื่อมต่อฐานข้อมูลหรือพื้นที่เก็บไฟล์ไม่สำเร็จ' });
    } else json(res, 400, { error: error.message || 'บันทึกผลงานไม่สำเร็จ' });
  }
}

export async function handleApi(req, res, url) {
  const route = url.pathname;
  try {
    if (req.method === 'GET') {
      if (route === '/api/auth/me') {
        const user = await currentUser(req);
        if (!user) return json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
        return json(res, 200, { user });
      }
      if (route === '/api/submission-settings') {
        const s = await getSettings();
        return json(res, 200, { settings: { submissions_open: s.submissions_open, submissions_start: s.submissions_start, submissions_end: s.submissions_end, success_message: s.success_message } });
      }
      if (route === '/api/site-content') {
        const s = await getSettings();
        let logo_url = null;
        if (s.site_logo_path) {
          if (s.site_logo_path.startsWith('data:') || /^https?:\/\//.test(s.site_logo_path)) {
            logo_url = s.site_logo_path;
          } else {
            try { logo_url = await createSignedFileUrl(s.site_logo_path); } catch { logo_url = null; }
          }
        }
        return json(res, 200, { title: s.homepage_title, intro: s.homepage_intro, logo_url });
      }
      if (route === '/api/results') {
        const s = await getSettings();
        return json(res, 200, { approved: !!s.results_approved, results: s.results_approved ? s.results_content : '', committee: s.results_approved ? s.results_committee : '', approved_at: s.results_approved_at });
      }
      if (route === '/api/judge/submissions') {
        const user = await currentUser(req);
        if (!user) return json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
        if (user.role !== 'judge') return json(res, 403, { error: 'เฉพาะกรรมการเท่านั้น' });
        const [settings, submissions, scores] = await Promise.all([
          getSettings(),
          supabaseRequest('GET', 'submissions?select=id,category_type,category,title,submitter_name,student_id,faculty,organization_position,video_url,details,proposal_file_name,presentation_file_name,created_at&status=eq.submitted&order=created_at.asc'),
          supabaseRequest('GET', restQuery('submission_scores', { select: 'submission_id,scores,total,updated_at', judge_user_id: `eq.${user.id}` })),
        ]);
        return json(res, 200, { submissions: submissions || [], scores: scores || [], scoring_open: !!settings.scoring_open, criteria: { person: settings.person_criteria || [], project: settings.project_criteria || [] } });
      }
      if (route === '/api/judge/results/approval') {
        const user = await currentUser(req);
        if (!user) return json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
        if (user.role !== 'judge' || !/ประธาน/.test(user.position || '')) return json(res, 200, { can_approve: false });
        const s = await getSettings();
        return json(res, 200, { can_approve: true, approved: !!s.results_approved, results_content: s.results_content || '', results_committee: s.results_committee || '' });
      }
      if (route === '/api/announcements') {
        const rows = await supabaseRequest('GET', restQuery('announcements', { select: 'id,title,body,published_at,created_at', published: 'eq.true', order: 'published_at.desc', limit: '30' }));
        return json(res, 200, { announcements: rows || [] });
      }
      if (route === '/api/homepage-cards') {
        const rows = await supabaseRequest('GET', restQuery('homepage_cards', { select: 'slug,title,description,badge,link_label,target_url,published,updated_at', published: 'eq.true', order: 'slug.asc' }));
        return json(res, 200, { cards: rows || [] });
      }
      if (route === '/api/project-details') {
        const rows = await supabaseRequest('GET', restQuery('project_details', { select: 'id,title,body,published_at,created_at', published: 'eq.true', order: 'created_at.asc', limit: '100' }));
        return json(res, 200, { details: rows || [] });
      }
      if (await adminGet(req, res, route)) return;
      const files = route.match(/^\/api\/submissions\/(\d+)\/files\/(proposal|presentation)$/);
      if (files) {
        const user = await currentUser(req);
        if (!user) return json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
        if (!['admin', 'judge'].includes(user.role)) return json(res, 403, { error: 'ไม่มีสิทธิ์เปิดไฟล์' });
        const column = `${files[2]}_file_path`;
        const cacheKey = `sub:${files[1]}:${column}`;
        let filePath = signedUrlCache.get(cacheKey);
        if (!filePath) {
          const rows = await supabaseRequest('GET', restQuery('submissions', { select: column, id: `eq.${files[1]}`, limit: '1' }));
          if (!rows?.length || !rows[0][column]) return json(res, 404, { error: 'ไม่พบไฟล์ผลงานนี้' });
          filePath = rows[0][column];
          signedUrlCache.set(cacheKey, filePath);
        }
        return json(res, 200, { url: await createSignedFileUrl(filePath) });
      }
      return json(res, 404, { error: 'ไม่พบปลายทาง' });
    }
    if (!requireSameOrigin(req, res)) return;
    if (req.method === 'PATCH' && route === '/api/admin/settings') {
      if (!await requireAdmin(req, res)) return;
      const body = await readJson(req);
      const values = await validateSettings(body);
      return json(res, 200, { settings: await updateSettings(values) });
    }
    if (req.method === 'DELETE' && route === '/api/admin/site-logo') {
      if (!await requireAdmin(req, res)) return;
      const oldPath = (await getSettings()).site_logo_path;
      await updateSettings({ site_logo_path: null });
      if (oldPath && !oldPath.startsWith('data:')) {
        await deleteStorageObjects([oldPath]);
      }
      return json(res, 200, { ok: true, logo_url: null });
    }
    if (req.method === 'POST' && route === '/api/admin/site-logo') {
      if (!await requireAdmin(req, res)) return;
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data;')) throw new Error('รูปแบบไฟล์โลโก้ไม่ถูกต้อง');
      const { files } = await parseMultipart(req);
      const file = files.logo;
      if (!file) throw new Error('กรุณาเลือกไฟล์โลโก้');
      const filename = safeFilename(file.filename);
      const extension = path.extname(filename).toLowerCase();
      const allowedExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif']);
      if (!allowedExts.has(extension)) {
        throw new Error('โลโก้ต้องเป็นไฟล์ PNG, JPG, WEBP, SVG หรือ GIF');
      }
      if (file.content.length > 5 * 1024 * 1024) {
        throw new Error('ไฟล์โลโก้ต้องมีขนาดไม่เกิน 5 MB');
      }
      let contentType = 'image/png';
      if (extension === '.jpg' || extension === '.jpeg') {
        if (file.content.length < 2 || file.content[0] !== 0xff || file.content[1] !== 0xd8) throw new Error('ไฟล์ JPEG/JPG ไม่ถูกต้อง');
        contentType = 'image/jpeg';
      } else if (extension === '.png') {
        const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        if (file.content.length < 8 || !file.content.subarray(0, 4).equals(pngSig)) throw new Error('ไฟล์ PNG ไม่ถูกต้อง');
        contentType = 'image/png';
      } else if (extension === '.webp') {
        if (file.content.length < 12 || file.content.subarray(0, 4).toString('ascii') !== 'RIFF' || file.content.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error('ไฟล์ WEBP ไม่ถูกต้อง');
        contentType = 'image/webp';
      } else if (extension === '.svg') {
        const textSample = file.content.toString('utf8', 0, Math.min(file.content.length, 1000)).toLowerCase();
        if (!textSample.includes('<svg') && !textSample.includes('<?xml')) throw new Error('ไฟล์ SVG ไม่ถูกต้อง');
        contentType = 'image/svg+xml';
      } else if (extension === '.gif') {
        const gifHeader = file.content.subarray(0, 6).toString('ascii');
        if (gifHeader !== 'GIF87a' && gifHeader !== 'GIF89a') throw new Error('ไฟล์ GIF ไม่ถูกต้อง');
        contentType = 'image/gif';
      }

      const oldPath = (await getSettings()).site_logo_path;
      const dataUrl = `data:${contentType};base64,${file.content.toString('base64')}`;
      let finalPath = dataUrl;

      try {
        const objectPath = `site/logo-${randomUUID()}${extension}`;
        await uploadStorageObject(objectPath, file.content, contentType);
        finalPath = objectPath;
      } catch (storageErr) {
        console.warn('Storage upload unavailable, saved as data URL in settings:', storageErr.message);
        finalPath = dataUrl;
      }

      await updateSettings({ site_logo_path: finalPath });
      if (oldPath && !oldPath.startsWith('data:') && finalPath !== oldPath) {
        await deleteStorageObjects([oldPath]);
      }
      let logo_url = finalPath;
      if (!finalPath.startsWith('data:')) {
        try { logo_url = await createSignedFileUrl(finalPath); } catch { logo_url = dataUrl; }
      }
      return json(res, 200, { logo_url });
    }
    if (req.method === 'PATCH' && route === '/api/admin/results') {
      const user = await requireAdmin(req, res);
      if (!user) return;
      const body = await readJson(req);
      const values = await validateSettings({
        results_content: body.results_content,
        results_committee: body.results_committee,
      });
      if (body.publish_immediately) {
        values.results_approved = true;
        values.results_approved_by = user.id;
        values.results_approved_at = new Date().toISOString();
      } else if (body.unpublish) {
        values.results_approved = false;
        values.results_approved_by = null;
        values.results_approved_at = null;
      }
      return json(res, 200, { settings: await updateSettings(values) });
    }
    if (req.method === 'POST' && route === '/api/admin/results/approve') {
      const user = await requireAdmin(req, res);
      if (!user) return;
      const settings = await getSettings();
      if (!String(settings.results_content || '').trim()) return json(res, 400, { error: 'ยังไม่มีผลการคัดเลือกให้อนุมัติ' });
      await updateSettings({ results_approved: true, results_approved_by: user.id, results_approved_at: new Date().toISOString() });
      return json(res, 200, { approved: true });
    }
    if (req.method === 'POST' && route === '/api/judge/results/approve') {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
      if (user.role !== 'judge' && user.role !== 'admin') return json(res, 403, { error: 'เฉพาะประธานโครงการหรือแอดมินเท่านั้นที่อนุมัติผลได้' });
      if (user.role === 'judge' && !/ประธาน/.test(user.position || '')) return json(res, 403, { error: 'เฉพาะประธานโครงการหรือแอดมินเท่านั้นที่อนุมัติผลได้' });
      const settings = await getSettings();
      if (!String(settings.results_content || '').trim()) return json(res, 400, { error: 'ยังไม่มีผลการคัดเลือกให้อนุมัติ' });
      await updateSettings({ results_approved: true, results_approved_by: user.id, results_approved_at: new Date().toISOString() });
      return json(res, 200, { approved: true });
    }
    if (req.method === 'POST' && /^\/api\/judge\/scores\/\d+$/.test(route)) {
      const user = await currentUser(req);
      if (!user) return json(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
      if (user.role !== 'judge') return json(res, 403, { error: 'เฉพาะกรรมการเท่านั้น' });
      const settings = await getSettings();
      if (!settings.scoring_open) return json(res, 403, { error: 'ปิดรับคะแนนแล้ว กรุณาติดต่อแอดมิน' });
      const submissionId = Number(route.split('/').at(-1));
      const submissions = await supabaseRequest('GET', restQuery('submissions', { select: 'id,category_type', id: `eq.${submissionId}`, status: 'eq.submitted', limit: '1' }));
      if (!submissions?.length) return json(res, 404, { error: 'ไม่พบผลงานที่ส่งเข้าประกวด' });
      const body = await readJson(req);
      const criteria = settings[`${submissions[0].category_type}_criteria`] || [];
      if (!criteria.length) return json(res, 400, { error: 'ยังไม่ได้กำหนดเกณฑ์การประเมินสำหรับประเภทนี้' });
      if (!Array.isArray(body.scores) || body.scores.length !== criteria.length || body.scores.some((score, index) => !Number.isInteger(score) || score < 0 || score > criteria[index].max)) throw new Error('คะแนนต้องอยู่ในช่วงคะแนนเต็มของแต่ละเกณฑ์');
      const total = body.scores.reduce((sum, score) => sum + score, 0);
      const rows = await supabaseRequest('POST', 'submission_scores?on_conflict=submission_id,judge_user_id', { submission_id: submissionId, judge_user_id: user.id, scores: body.scores, total, updated_at: new Date().toISOString() }, { headers: { Prefer: 'resolution=merge-duplicates,return=representation' } });
      return json(res, 200, { score: rows?.[0] || { submission_id: submissionId, scores: body.scores, total } });
    }
    if (req.method === 'PATCH' && /^\/api\/admin\/homepage-cards\/[a-z-]+$/.test(route)) {
      if (!await requireAdmin(req, res)) return;
      const slug = route.split('/').at(-1);
      if (!['schedule', 'committee-order', 'forms'].includes(slug)) return json(res, 404, { error: 'ไม่พบการ์ดประชาสัมพันธ์' });
      const body = await readJson(req);
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const badge = String(body.badge || '').trim();
      const linkLabel = String(body.link_label || '').trim();
      const targetUrl = String(body.target_url || '').trim();
      const published = body.published;
      if (!title || title.length > 160) throw new Error('กรุณาระบุหัวข้อไม่เกิน 160 ตัวอักษร');
      if (description.length > 1000 || badge.length > 120 || linkLabel.length > 80 || targetUrl.length > 500) throw new Error('ข้อมูลการ์ดยาวเกินกำหนด');
      if (targetUrl && !targetUrl.startsWith('#') && !/^https?:\/\//i.test(targetUrl) && !targetUrl.startsWith('/')) throw new Error('ลิงก์ต้องเริ่มด้วย https://, http://, / หรือ #');
      if (typeof published !== 'boolean') throw new Error('สถานะการเผยแพร่ไม่ถูกต้อง');
      const rows = await supabaseRequest('PATCH', restQuery('homepage_cards', { slug: `eq.${slug}`, select: 'slug,title,description,badge,link_label,target_url,published,updated_at' }), { title, description, badge, link_label: linkLabel, target_url: targetUrl, published, updated_at: new Date().toISOString() });
      if (!rows?.length) return json(res, 404, { error: 'ไม่พบการ์ดประชาสัมพันธ์' });
      return json(res, 200, { card: rows[0] });
    }
    if (req.method === 'PATCH') {
      const match = route.match(/^\/api\/admin\/project-details\/(\d+)$/);
      if (!match) return json(res, 404, { error: 'ไม่พบปลายทาง' });
      if (!await requireAdmin(req, res)) return;
      const body = await readJson(req);
      const title = String(body.title || '').trim(); const text = String(body.body || '').trim();
      const published = body.published ?? true;
      if (!title || title.length > 160) throw new Error('กรุณาระบุหัวข้อไม่เกิน 160 ตัวอักษร');
      if (!text || text.length > 10_000) throw new Error('กรุณาระบุรายละเอียดไม่เกิน 10,000 ตัวอักษร');
      if (typeof published !== 'boolean') throw new Error('สถานะการเผยแพร่ไม่ถูกต้อง');
      const rows = await supabaseRequest('PATCH', restQuery('project_details', { id: `eq.${match[1]}`, select: 'id,title,body,published,published_at,created_at' }), {
        title, body: text, published, published_at: published ? new Date().toISOString() : null,
      });
      if (!rows?.length) return json(res, 404, { error: 'ไม่พบรายละเอียดโครงการที่ต้องการแก้ไข' });
      return json(res, 200, { detail: rows[0] });
    }
    if (req.method === 'POST' && route === '/api/auth/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (failureList(ip).length >= 8) return json(res, 429, { error: 'พยายามเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่' });
      const body = await readJson(req);
      const code = String(body.code || '').trim().slice(0, 64);
      const expectedRole = body.role;
      if (!['admin', 'judge'].includes(expectedRole)) return json(res, 400, { error: 'ประเภทบัญชีไม่ถูกต้อง' });
      const user = code ? await findUserByCode(code) : null;
      let valid = false;
      if (user) {
        const salt = Buffer.from(user.access_code_salt, 'base64');
        const [digest] = codeDigest(code, salt);
        valid = equalStrings(digest, user.access_code_hash) && user.role === expectedRole;
      }
      if (!valid) {
        loginFailures.set(ip, [...failureList(ip), Date.now()]);
        return json(res, 401, { error: 'รหัสเข้าสู่ระบบไม่ถูกต้อง' });
      }
      loginFailures.delete(ip);
      const token = randomBytes(32).toString('base64url');
      const now = Math.floor(Date.now() / 1000); const expires = now + SESSION_SECONDS;
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await supabaseRequest('DELETE', restQuery('app_sessions', { expires_at: `lt.${now}` }));
      await supabaseRequest('POST', 'app_sessions', { token_hash: tokenHash, user_id: user.id, expires_at: expires, created_at: now });
      const secure = process.env.COOKIE_SECURE === '1' || process.env.NETLIFY === 'true' ? '; Secure' : '';
      return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}` });
    }
    if (req.method === 'POST' && route === '/api/auth/logout') {
      const token = sessionToken(req);
      if (token) {
        try { await supabaseRequest('DELETE', restQuery('app_sessions', { token_hash: `eq.${createHash('sha256').update(token).digest('hex')}` })); } catch { /* session cookie is cleared even if DB is unavailable */ }
      }
      const secure = process.env.COOKIE_SECURE === '1' || process.env.NETLIFY === 'true' ? '; Secure' : '';
      return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
    }
    if (req.method === 'POST' && route === '/api/admin/judges') {
      const admin = await requireAdmin(req, res); if (!admin) return;
      const body = await readJson(req);
      const judge = await createUser(String(body.code || ''), String(body.display_name || ''), String(body.position || ''), 'judge');
      return json(res, 201, { judge });
    }
    if (req.method === 'POST' && route === '/api/admin/project-details') {
      if (!await requireAdmin(req, res)) return;
      const body = await readJson(req);
      const title = String(body.title || '').trim(); const text = String(body.body || '').trim();
      const published = body.published ?? true;
      if (!title || title.length > 160) throw new Error('กรุณาระบุหัวข้อไม่เกิน 160 ตัวอักษร');
      if (!text || text.length > 10_000) throw new Error('กรุณาระบุรายละเอียดไม่เกิน 10,000 ตัวอักษร');
      if (typeof published !== 'boolean') throw new Error('สถานะการเผยแพร่ไม่ถูกต้อง');
      const rows = await supabaseRequest('POST', 'project_details?select=id,title,body,published,published_at,created_at', {
        title, body: text, published, published_at: published ? new Date().toISOString() : null,
      });
      return json(res, 201, { detail: rows?.[0] || {} });
    }
    if (req.method === 'POST' && route === '/api/admin/announcements') {
      if (!await requireAdmin(req, res)) return;
      const body = await readJson(req);
      const title = String(body.title || '').trim(); const text = String(body.body || '').trim();
      const published = body.published ?? true;
      if (!title || title.length > 160) throw new Error('กรุณาระบุหัวข้อข่าวไม่เกิน 160 ตัวอักษร');
      if (!text || text.length > 3000) throw new Error('กรุณาระบุเนื้อหาข่าวไม่เกิน 3,000 ตัวอักษร');
      if (typeof published !== 'boolean') throw new Error('สถานะการเผยแพร่ไม่ถูกต้อง');
      const rows = await supabaseRequest('POST', 'announcements?select=id,title,body,published,published_at,created_at', {
        title, body: text, published, published_at: published ? new Date().toISOString() : null,
      });
      return json(res, 201, { announcement: rows?.[0] || {} });
    }
    if (req.method === 'DELETE') {
      const judgeMatch = route.match(/^\/api\/admin\/judges\/(\d+)$/);
      const submissionMatch = route.match(/^\/api\/admin\/submissions\/(\d+)$/);
      const itemMatch = route.match(/^\/api\/admin\/(announcements|project-details)\/(\d+)$/);
      if (!judgeMatch && !submissionMatch && !itemMatch) return json(res, 404, { error: 'ไม่พบปลายทาง' });
      if (!await requireAdmin(req, res)) return;
      if (submissionMatch) {
        const id = submissionMatch[1];
        const rows = await supabaseRequest('GET', restQuery('submissions', { select: 'id,proposal_file_path,presentation_file_path', id: `eq.${id}`, limit: '1' }));
        if (!rows?.length) return json(res, 404, { error: 'ไม่พบผลงานนี้' });
        const sub = rows[0];
        const filesToDelete = [sub.proposal_file_path, sub.presentation_file_path].filter(Boolean);
        if (filesToDelete.length) {
          await deleteStorageObjects(filesToDelete);
        }
        await supabaseRequest('DELETE', restQuery('submissions', { id: `eq.${id}` }));
        return json(res, 200, { ok: true, message: 'ลบผลงานเรียบร้อยแล้ว' });
      }
      if (judgeMatch) {
        const deleted = await supabaseRequest('DELETE', restQuery('app_users', { id: `eq.${judgeMatch[1]}`, role: 'eq.judge', select: 'id' }));
        if (!deleted?.length) return json(res, 404, { error: 'ไม่พบบัญชีกรรมการนี้' });
        return json(res, 200, { ok: true });
      }
      const table = itemMatch[1] === 'announcements' ? 'announcements' : 'project_details';
      await supabaseRequest('DELETE', restQuery(table, { id: `eq.${itemMatch[2]}` }));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/api/submissions') return await createSubmission(req, res);
    return json(res, 404, { error: 'ไม่พบปลายทาง' });
  } catch (error) {
    if (error instanceof SupabaseError) {
      console.error(`Supabase API error: HTTP ${error.status}`);
      if (error.status === 409 && route === '/api/admin/judges') return json(res, 409, { error: 'รหัสนี้ถูกใช้แล้ว กรุณากำหนดรหัสใหม่' });
      return json(res, 503, { error: 'เชื่อมต่อหรือบันทึกข้อมูลไม่สำเร็จ' });
    }
    if (error.message?.includes('Supabase')) return json(res, 503, { error: 'เชื่อมต่อ Supabase ไม่สำเร็จ' });
    return json(res, 400, { error: error.message || 'เกิดข้อผิดพลาด' });
  }
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };
async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(ROOT, `.${pathname}`);
  if (!target.startsWith(`${ROOT}${path.sep}`) || target === path.join(ROOT, '.env') || target === path.join(ROOT, 'server.js')) { res.writeHead(404).end('Not found'); return; }
  try {
    const stat = await import('node:fs/promises').then(fs => fs.stat(target));
    if (!stat.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    createReadStream(target).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
}

async function askSecret(question) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(question);
    rl.close(); return answer;
  }
  return new Promise((resolve, reject) => {
    let answer = '';
    process.stdout.write(question);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true); process.stdin.resume();
    const cleanup = () => { process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); };
    const onKey = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') { cleanup(); process.stdout.write('\n'); reject(new Error('ยกเลิก')); return; }
      if (key.name === 'return' || key.name === 'enter') { cleanup(); process.stdout.write('\n'); resolve(answer); return; }
      if (key.name === 'backspace') { answer = answer.slice(0, -1); return; }
      if (character && !key.ctrl && !key.meta) answer += character;
    };
    process.stdin.on('keypress', onKey);
  });
}
async function createAdminCommand() {
  const admins = await supabaseRequest('GET', restQuery('app_users', { select: 'id', role: 'eq.admin', access_code_lookup: 'not.is.null', limit: '1' }));
  if (admins?.length) { console.error('มีบัญชีแอดมินที่ใช้รหัสเข้าสู่ระบบแล้ว'); return 1; }
  let code = (await askSecret('Admin login code (8–64 characters, Enter to generate): ')).trim();
  if (!code) { code = `PSU-${randomBytes(8).toString('hex').toUpperCase()}`; console.log(`รหัสแอดมินที่สร้าง: ${code}`); }
  else {
    const confirm = (await askSecret('Confirm login code: ')).trim();
    if (!equalStrings(code, confirm)) { console.error('รหัสไม่ตรงกัน'); return 1; }
  }
  await createUser(code, 'ผู้ดูแลระบบ', '', 'admin');
  console.log('สร้างบัญชีแอดมินเรียบร้อย'); return 0;
}
async function changeCodeSql(userId) {
  if (!/^\d+$/.test(String(userId)) || Number(userId) < 1) { console.error('ระบุ ID ผู้ใช้จาก app_users เป็นตัวเลขบวก'); return 1; }
  const code = (await askSecret('รหัสใหม่ (8–64 ตัวอักษร ตัวเลข หรือขีดกลาง): ')).trim();
  const confirm = (await askSecret('ยืนยันรหัสใหม่: ')).trim();
  if (!equalStrings(code, confirm)) { console.error('รหัสไม่ตรงกัน'); return 1; }
  if (!ACCESS_CODE_RE.test(code)) { console.error('รหัสเข้าสู่ระบบต้องมี 8–64 ตัว และใช้ตัวอักษรอังกฤษ ตัวเลข หรือขีดกลาง'); return 1; }
  const salt = randomBytes(16); const [digest, saltB64] = codeDigest(code, salt); const lookup = codeLookup(code);
  console.log('\n-- คัดลอกคำสั่งนี้ไปวางใน Supabase > SQL Editor แล้วกด Run');
  console.log('update public.app_users');
  console.log(`set access_code_lookup = '${lookup}',`);
  console.log(`    access_code_hash = '${digest}',`);
  console.log(`    access_code_salt = '${saltB64}'`);
  console.log(`where id = ${Number(userId)} and active = true and role in ('admin', 'judge');`);
  console.log('\nตรวจผลลัพธ์ให้เป็น UPDATE 1 ก่อนใช้งานรหัสใหม่');
  return 0;
}

async function main() {
  const [command = 'serve', argument] = process.argv.slice(2);
  try {
    if (command === 'create-admin') return await createAdminCommand();
    if (command === 'change-code-sql') return await changeCodeSql(argument || '');
    if (command !== 'serve') { console.error('คำสั่งไม่ถูกต้อง'); return 2; }
    const config = supabaseConfig();
    for (const [table, column] of [['app_users', 'id'], ['app_sessions', 'token_hash'], ['app_settings', 'id'], ['submissions', 'id'], ['announcements', 'id'], ['project_details', 'id'], ['homepage_cards', 'slug'], ['submission_scores', 'submission_id']]) {
      await supabaseRequest('GET', `${table}?select=${column}&limit=1`);
    }
    const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || '8000');
    const server = createServer(async (req, res) => {
      try {
        let url;
        try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { res.writeHead(400).end(); return; }
        if (url.pathname.startsWith('/api/')) {
          await handleApi(req, res, url);
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
        await serveStatic(req, res, url);
      } catch (err) {
        console.error('Unhandled server error:', err);
        if (!res.headersSent) {
          json(res, 500, { error: err.message || 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
        }
      }
    });
    server.listen(port, host, () => {
      console.log(`Serving PSU awards site at http://${host}:${port}`);
      console.log('Use HTTPS and set COOKIE_SECURE=1 when deploying outside localhost.');
    });
    process.on('SIGINT', () => server.close(() => process.exit(0)));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    return 0;
  } catch (error) {
    console.error(`เริ่มระบบไม่ได้: ${error.message}`);
    if (error instanceof SupabaseError) console.error('ตรวจสอบว่าได้รัน supabase/schema.sql และตั้งค่า secret key ถูกต้อง');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
