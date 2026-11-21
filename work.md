---
project: "PSU Student Activity Quality Awards (เวทีคุณภาพกิจกรรมนักศึกษา ม.อ. สุราษฎร์ธานี)"
version: "1.2.0"
last_updated: "2026-11-18"
environment:
  runtime: "Node.js 20+ (No third-party packages, zero-dependency)"
  server: "server.js (Node.js built-in http, fs, crypto)"
  frontend: "Vanilla HTML5 / CSS3 / JavaScript (SPA in index.html)"
  database: "Supabase (PostgreSQL via REST API with service-role key)"
  storage: "Supabase Storage (private bucket: awards-submissions)"
  hosting: "Netlify (Static site + Netlify Functions api.mjs) / Local (node server.js)"
critical_rules_for_ai:
  - "STRICT: DO NOT USE PYTHON. Use Node.js for backend scripts."
  - "STRICT: Do NOT add MutationObserver on document.body or parent containers that mutate DOM."
  - "STRICT: Do NOT put Supabase service-role/secret keys in client-side HTML or JS."
  - "STRICT: Client-side index.html communicates with backend via `/api/...` endpoints."
  - "ROLE HIERARCHY: Admin is the highest role and can publish results directly without president approval."
  - "EVALUATION CRITERIA: System provides 4 standard criteria (25 pts each = 100 pts) as default fallback if empty in database."
---

# Project Work Log & AI Context (work.md)

This file maintains a persistent, machine-readable and human-readable record of system changes, architecture conventions, and historical bug fixes for AI assistants and human developers.

---

## 1. System Architecture & Tech Stack

```
[ Browser / Client ] 
       │
       ▼
[ index.html ] (Vanilla HTML/CSS/JS, Single Page App)
       │
       │ HTTP /api/* requests (Cookie-based session)
       ▼
[ server.js ] (Node.js HTTP Server, Port 8000)
       │
       │ HTTPS REST API with Service Role Key
       ▼
[ Supabase Backend ]
  ├── Database: PostgreSQL (app_users, submissions, app_settings, etc.)
  └── Storage: awards-submissions (Private bucket for PDF/PPT files)
```

---

## 2. Changelog & Work History

### [2026-11-18] - Optimization: Reliable File Viewing with Expiring Links

#### 2.10 Performance Optimization: Instant File Viewing
* **User Feedback**: "ฉันดูไฟล์ผลงานรู้สึกว่าตอบสนองช้า ทำให้ไวขึ้นได้ไหม" (File viewing responds slowly, make it faster).
* **Bottleneck Analysis**:
  1. **Multi-hop Network Roundtrips**: Previously, clicking "แบบฟอร์ม" or "ไฟล์นำเสนอ" required 3 consecutive remote calls on the server: session check in DB -> query file path in DB -> call Supabase Storage sign API -> return signed URL to browser. This added 1.5–3.5s of latency on every click.
  2. **No Visual Feedback**: The button remained static during the API request, making users feel the application froze or was unresponsive.
  3. **Duplicate Requests**: Clicking the same file repeatedly re-generated signed URLs from scratch each time.
* **Optimizations Implemented**:
  1. **Server-Side Signed URL Cache (`signedUrlCache`)**:
     - Signed URLs are cached for 15 days, while each URL itself is valid for 30 days; files remain private in Storage.
     - Submission file paths use a short 5-minute cache. The server caps this cache at 1,000 entries and clears entries when a submission is deleted.
  2. **No Client-Side Signed URL Cache**:
     - The browser requests a fresh URL when a file is opened. This avoids reusing a URL after it expires.
  3. **Reliable Browser Opening**:
     - A new tab is opened synchronously from the click. If the browser blocks pop-ups, the page stays in place and shows a separate link the user can click.
  4. **Immediate Visual Feedback**:
     - The button changes to `กำลังเปิด...` and is disabled during the request to prevent duplicate clicks.

### [2026-11-18] - Fix: "Cannot set properties of null (setting 'textContent')"

#### 2.9 Bug Fix: Missing Element Reference in `loadDashboard()`
* **Symptoms**:
  - Admin panel displayed toast error: `Cannot set properties of null (setting 'textContent')`.
* **Root Cause**:
  - The "ผลการคัดเลือก (รออนุมัติจากประธาน)" card containing `<h3 id="dashboardResultsStatus">` was removed from `index.html` per user request.
  - In `loadDashboard()`, the JavaScript still attempted to execute:
    `$('#dashboardResultsStatus').textContent = ...`
  - Since the element no longer existed in the DOM, `$('#dashboardResultsStatus')` returned `null`, triggering `Cannot set properties of null (setting 'textContent')`.
* **Resolution**:
  - Updated `loadDashboard()` in `index.html` with defensive existence checks (`if (resStatus) resStatus.textContent = ...`) for all dashboard metric targets.

### [2026-11-18] - Fix: Submission "Unexpected end of JSON input" & Robust Form Handling

#### 2.8 Bug Fix: Submission Error (`Unexpected end of JSON input`)
* **Symptoms**:
  - Student/user clicking "ส่งผลงานเข้าประกวด" received error toast:
    `Failed to execute 'json' on 'Response': Unexpected end of JSON input`.
* **Root Causes**:
  1. **Direct `response.json()` Call**: In `index.html`, `#submission.onsubmit` called `await response.json()` directly without safety. If the backend returned an empty response, HTTP error without body, or non-JSON body, `JSON.parse("")` threw this native JavaScript SyntaxError, masking the real status or error message.
  2. **Strict `sameOrigin` Origin Mismatch**: `sameOrigin(req)` checked `origin.host === host` strictly. When accessing `http://localhost:8000` while the backend host header reported `127.0.0.1:8000` (or behind Netlify proxy with `x-forwarded-host`), it rejected the request or aborted without origin fallback.
  3. **Multipart Parser Header Contamination**: `parseMultipart(req)` passed all incoming Node headers (`req.headers`) into `new Request('http://localhost/', ...)` which can fail on Node fetch spec due to forbidden or mismatched headers.
  4. **Async Server Listener Error Unhandled**: In `server.js`, `createServer` did not `await` `handleApi` inside a try/catch, risking socket closure with 0 bytes on unhandled async rejections.
* **Resolutions**:
  - **`index.html`**:
    - Replaced unsafe `response.json()` with `response.text()` safe parser.
    - Added user feedback state on submit button: `กำลังส่งผลงานและอัปโหลดไฟล์...`.
    - Added human-readable error messages for status 413 (ไฟล์ใหญ่เกินไป), 502/504 (หมดเวลาการอัปโหลด), etc.
  - **`server.js`**:
    - Enhanced `sameOrigin()` to treat `localhost` and `127.0.0.1` interchangeably, inspect `x-forwarded-host`, and accept `sec-fetch-site: same-origin`.
    - Cleaned `parseMultipart()` to only forward necessary `content-type` with boundary to `new Request()`.
    - Wrapped `createServer` request handler in `try/catch` and awaited `handleApi()`.
  - **`netlify/functions/api.mjs`**:
    - Guaranteed valid JSON error response if `responseBody` is empty.

### [2026-11-18] - Feature: Admin Edit & Customize Scoring Criteria (จัดการเกณฑ์การให้คะแนน)

#### 2.7 Feature Addition: Interactive Criteria Editor for Admin
* **User Request**: "ให้เเอดมินสามารถเเก้ไขเกณฑ์การให้คะเเนนได้" (Allow admin to edit/manage scoring criteria).
* **Problem Analysis**:
  - Previously, criteria editing was buried at the bottom of the "เนื้อหาเว็บไซต์" (Website Content) tab rather than having its own clear tab in the Admin navigation bar.
  - The old editor was a plain `<textarea>` that expected raw pipe syntax (`ชื่อเกณฑ์|คะแนนเต็ม`), which was unintuitive, prone to formatting mistakes, and gave no immediate feedback on whether points summed to 100.
* **Frontend Implementation (`index.html`)**:
  - Added dedicated navigation tab in Admin navbar: `<button data-admin="criteria">เกณฑ์การให้คะแนน</button>`.
  - Added shortcut button inside "เนื้อหาเว็บไซต์" to jump to criteria editor (`#openCriteriaEditor`).
  - Created a modern, interactive Rubrics Builder panel (`#admin-criteria`):
    - Separate cards for **นักกิจกรรมดีเด่น (ประเภทบุคคล)** and **โครงการดีเด่น (ประเภทโครงการ)**.
    - Each criterion row contains: Item number badge (`[ 1 ]`), Criterion label input, Max score input (points), and Delete button (`✕`).
    - Real-time score calculator with visual status badges:
      - Valid (sum = 100): Green badge `✓ รวม 100 / 100 คะแนน`.
      - Invalid (sum ≠ 100): Warning badge `⚠️ รวม X / 100 คะแนน (ขาดอีก ... / เกินไป ...)`.
    - **＋ เพิ่มเกณฑ์บุคคล / ＋ เพิ่มเกณฑ์โครงการ** buttons: Add new criteria with auto-calculated remaining points (capped at 10 items max).
    - **↺ คืนค่าเกณฑ์เริ่มต้น**: Restores the 4 standard criteria (25 pts each = 100 pts) with confirmation dialog.
    - **✓ บันทึกเกณฑ์การให้คะแนน**: Validates that all fields have non-empty labels, integer points (1–100), and each category's total equals 100 points, then patches via `PATCH /api/admin/settings`.
* **Backend Integration (`server.js`)**:
  - `GET /api/admin/scores` now includes `criteria: { person, project }` from `getSettings()`, allowing the admin score view to dynamically show actual criterion names and max scores rather than hardcoded `/25`.
  - `PATCH /api/admin/settings` enforces 1–10 criteria and 100-point total validation.
  - Changes take effect immediately across both judge scoring interfaces (`/api/judge/submissions`) and admin oversight.

### [2026-11-18] - UI Cleanup: Remove Preview Buttons & Modal

#### 2.6 Removal of Preview Button and Modal
* **User Request**: "ลบปุ่มพรีวิวออก" (Remove the preview button).
* **Changes**:
  - Removed "ดูพรีวิว" button from Admin submissions table in `#admin-entries`.
  - Removed "ดูพรีวิว" button from Judge candidates list in `#judgePanel`.
  - Removed `#submissionPreviewModal` HTML container from `index.html`.
  - Cleaned up `showSubmissionPreview()` and preview event listeners from `index.html`.
  - Retained the file attachment buttons ("แบบฟอร์ม" / "ไฟล์นำเสนอ") and the "ลบ" button for admin.

### [2026-11-18] - Feature: Admin Delete Submissions (ลบข้อมูลผลงานที่ส่ง)

#### 2.5 Feature Addition: Admin Ability to Delete Submissions
* **Requirement**: "ให้เเอดมินสามารถลบข้อมูล ผลงานที่ส่งได้" (Allow admin to delete submitted submissions and their files).
* **Backend Implementation (`server.js`)**:
  - Added `DELETE /api/admin/submissions/:id` route protected by `requireAdmin(req, res)`.
  - Automatically queries the submission's `proposal_file_path` and `presentation_file_path`.
  - Deletes the stored files from Supabase Storage (`awards-submissions` bucket) via `deleteStorageObjects()`.
  - Deletes the submission record from the `submissions` table (which automatically cascades to delete related scores in `submission_scores`).
* **Frontend Implementation (`index.html`)**:
  - In `#admin-entries` (รายการผลงานที่ส่งเข้าประกวด), added a red `ลบ` button to each submission action cell.
  - In `showSubmissionPreview()` (หน้าต่างพรีวิวผลงาน), added a `🗑️ ลบผลงานนี้` button visible only to admins.
  - Includes confirmation dialog `confirm(...)` before deletion to prevent accidental removal.
  - Automatically refreshes the submissions table and updates dashboard counts upon deletion.

### [2026-11-18] - Fix: Judge Scoring Criteria Missing & Enabled Immediate Scoring

#### 2.4 Bug Fix: "แอดมินยังไม่ได้กำหนดเกณฑ์ประเมินสำหรับประเภทนี้" Despite Scoring Being Open
* **Symptoms**:
  - Admin checked "เปิดรับคะแนน" (Scoring Open), but on the Judge panel (`#judgePanel`), each submission showed:
    `แอดมินยังไม่ได้กำหนดเกณฑ์ประเมินสำหรับประเภทนี้`
  - Judges were unable to input score rubrics or submit evaluation scores.
* **Root Cause**:
  - In Supabase `app_settings`, `person_criteria` and `project_criteria` defaulted to empty arrays `[]`.
  - When the judge loaded submissions via `/api/judge/submissions`, `data.criteria[row.category_type]` was empty (`length === 0`), causing the frontend to render the warning message instead of the scoring form.
* **Resolution**:
  - In `server.js`, defined `DEFAULT_CRITERIA` for both `person` and `project` (4 standard criteria, 25 points each, totaling 100 points).
  - Updated `getSettings()` in `server.js` so that if `person_criteria` or `project_criteria` in the database is empty or not configured, it automatically supplies the default rubrics.
  - Judges can now score immediately as soon as scoring is open, while admins still retain full ability to customize criteria anytime via the admin back-office.
  - Updated validation toast in `index.html` to be dynamic.

### [2026-11-18] - Localhost Freeze Resolution, Preview Modal & Admin Direct Publish

#### 2.1 Critical Bug Fix: Localhost Freeze & Refresh Hang
* **Symptoms**:
  - The site on `http://127.0.0.1:8000` became completely unresponsive after loading.
  - Page could scroll slightly but no buttons/inputs could be clicked.
  - Refreshing or closing the tab hung the browser process.
* **Root Cause**:
  - ~230 lines of redundant/duplicate code had been appended to the bottom of `index.html`.
  - Contained `MutationObserver` observing `document.body` with `{ attributes: true, childList: true, subtree: true }`.
  - The observer callback called `loadSubmissions()`, which in turn modified `container.innerHTML` and appended DOM nodes.
  - Modifying the DOM triggered the observer callback again, creating an **Infinite Loop on the JavaScript main thread** and freezing the browser.
  - Contained placeholder Supabase credentials (`https://YOUR-PROJECT.supabase.co`) causing uncaught network exceptions.
* **Resolution**:
  - Completely purged lines 56–287 of `index.html`.
  - Re-anchored clean DOM closure `</script></body></html>`.

#### 2.2 Feature Addition: Submission Preview Modal (ดูพรีวิวผลงาน)
* **Target Audience**: Both Admin (`#admin-entries`) and Judges (`#judgePanel`).
* **Implementation Details**:
  - Added `#submissionPreviewModal` in `index.html` with clean responsive layout.
  - Added "ดูพรีวิว" button (`data-preview-submission="${row.id}"`) to each row in the admin submissions table and judge candidates list.
  - `showSubmissionPreview(row)` displays:
    - Submission title, category, and type (บุคคล / โครงการ).
    - Submitter details: Full name, Student ID, Faculty/Department, Phone, Email, Organization position.
    - Project details and video links.
    - Download/View action buttons for proposal (`proposal`) and presentation (`presentation`) files.

#### 2.3 Feature Adjustment: Admin Direct Publish (แอดมินเผยแพร่ผลได้ทันที)
* **Background**: The admin is the superuser role and should not be blocked waiting for committee chair ("ประธาน") approval.
* **Backend Changes (`server.js`)**:
  - Updated `PATCH /api/admin/results`:
    - Added support for `publish_immediately: true` (sets `results_approved = true`, records `results_approved_by` and timestamp).
    - Added support for `unpublish: true` (sets `results_approved = false`).
  - Added `POST /api/admin/results/approve` endpoint allowing admin role to approve results.
* **Frontend Changes (`index.html`)**:
  - Updated `#admin-publish` panel with 3 action buttons:
    1. `✓ บันทึกและเผยแพร่ทันที` (`#saveAndPublishResults`)
    2. `บันทึกเป็นฉบับร่าง` (`#saveDraftResults`)
    3. `ยกเลิกการเผยแพร่` (`#unpublishResults`)
  - Updated status display to show current state: "เผยแพร่แล้ว" (Published) or "แบบร่าง (ยังไม่เผยแพร่)" (Draft).

---

## 3. Key Conventions for Any AI Agent Working on This Repository

1. **Language & Environment**:
   - Backend is pure **Node.js** (ES Modules, `node:http`, `node:crypto`, `node:fs`).
   - Do NOT run or create Python scripts.
   - Run server locally with: `node server.js` (port `8000`).

2. **Frontend Guidelines**:
   - Everything is in `index.html` (single-file architecture).
   - Use helper utilities `$` and `$$` defined at the top of the `<script>` tag.
   - All API calls must go through the async `api(path, options)` function with credentials `'same-origin'`.
   - Never use `MutationObserver` on `document.body` or mutating containers.

3. **Database & API Security**:
   - Database operations are authenticated via server sessions (`app_sessions`).
   - Do not attempt direct client-side Supabase connections from `index.html`.
   - Admin routes require the `admin` role checked via cookie session token.

4. **Continuous Documentation**:
   - Always update this `work.md` file whenever making changes so subsequent agents have full context.
