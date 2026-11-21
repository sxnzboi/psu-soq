# PSU Student Activity Awards

## Run locally

The site uses Node.js 20+ built-in modules and Supabase's REST API; no third-party packages are required.

1. Create a Supabase project. In its SQL Editor, run [`supabase/schema.sql`](supabase/schema.sql). This creates the private app tables for users, sessions, submission settings, student submissions, homepage cards, project details, and judge scores. The script adds the evaluation and result approval settings to `app_settings` without deleting existing records.

   In **Storage**, create a **private** bucket named `awards-submissions`, with a 30 MB file limit. Student proposal and presentation files are uploaded there; the database stores their private object paths and original filenames.

2. Copy `.env.example` to `.env` and add a server-only Supabase secret key from **Project Settings > API Keys**. The project URL is already set to the provided project. The `sb_publishable_...` key is for public clients and cannot authorize this server's private database operations. Never add a secret key to `index.html`, commit it to Git, or send it to a browser.

   ```sh
   cp .env.example .env
   ```

3. Create the first administrator account:

   ```sh
   node server.js create-admin
   ```

   Enter an admin login code twice, or press Enter at the first prompt to generate a random code. Codes must be 8–64 letters, numbers, or hyphens. Generated codes are shown once in the terminal and stored only as a hash. The Node.js server reads `.env` automatically.

4. Start the site and authentication API:

   ```sh
   node server.js
   ```

5. Open <http://127.0.0.1:8000> and use the admin icon to sign in. Create individual committee accounts in **คณะกรรมการ**. Each account has one unique login code. The admin enters each committee member’s name, position, and code in the back office.

User accounts and sessions are stored in `app_users` and `app_sessions`; form submissions and receiving settings are stored in `submissions` and `app_settings`. The admin dashboard counts actual database records. Admins can edit the three homepage promotion cards in **เนื้อหาเว็บไซต์**, manage announcements, set evaluation criteria, and add, edit, publish, or delete project details. Judge scores are saved separately in `submission_scores`; each judge can read and edit only their own scores while admins can view all submitted scores. The chair approves result text before it is made public. Login codes are PBKDF2-hashed and never displayed after account creation. RLS is enabled, browser roles have no direct table access, and the server checks the account role for protected routes. Submission files are held in a private Storage bucket and served with short-lived signed links.

No applicant, judge, score, or result examples are preloaded. Evaluation criteria start empty and must be entered by an admin using the official criteria before scoring can begin. The three homepage card rows are editable site content used to populate the designed announcement cards.

## Deployment notes

The built-in server binds to `127.0.0.1` by default for local use. For a deployment, put it behind a production-grade HTTPS server, set `HOST` and `PORT` as needed, and set `COOKIE_SECURE=1`. Do not expose the development server directly to the public internet. Student submissions, private files, judge scores, scoring windows, homepage content, announcements, project details, and result approval status are stored in Supabase. Judge scores are isolated per account; only admins can read all scores. The committee chair account (position containing “ประธาน”) is the only role allowed to approve public results.

### Deploy to Netlify

The site needs both the static page and the `api` Netlify Function. In Netlify project settings, add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as production environment variables. Use the Supabase server-side secret/service-role key for `SUPABASE_SECRET_KEY`, never the publishable key. Do not put either secret in `index.html` or the published `dist` folder.

Deploy from the project directory with Netlify CLI so it builds and includes the function:

```sh
npx netlify-cli link
npx netlify-cli deploy --build --prod
```

The first command links this folder to the existing `psu-soq` Netlify project. The build configuration publishes only `dist` and deploys `netlify/functions/api.mjs`; `/api/*` is routed to that function. After adding or changing environment variables, deploy again. Netlify Drop uploads static files but does not build this configured function.


### Change a login code through Supabase

Use `node server.js change-code-sql USER_ID` and enter the new code twice. Copy the generated `UPDATE public.app_users` statement into Supabase Dashboard > SQL Editor and run it. Find `USER_ID` in the `app_users` table first. Confirm the result is `UPDATE 1`; the query only contains derived hashes, not the login code.
# psu-soq
