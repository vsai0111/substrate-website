# Book a Demo — architecture and setup

The site is no longer purely static. `/book-a-demo` writes to and reads from MySQL
through a small Express API. This document covers everything that feature adds.

```
Homepage CTA
     |
     v
/book-a-demo  ──GET  /api/demo-requests──>  Express  ──SELECT──>  MySQL
     |                                                              |
     └────────POST /api/demo-requests────>  Express  ──INSERT──>  demo_requests
                                                                    |
                        Recently Submitted Users  <──refetch────────┘
```

The frontend calls `/api` on its **own origin**. Vite proxies it in development,
nginx proxies it in production, so there is no API base URL to configure and no
CORS in production.

---

## 1. What was added

| Path | Purpose |
| --- | --- |
| `src/pages/BookDemo.jsx` + `.css` | The page: heading, description, form |
| `src/pages/Home.jsx` | The previous homepage sections, unchanged |
| `src/pages/NotFound.jsx` + `.css` | 404 for unknown client-side routes |
| `src/components/RecentRequests.jsx` + `.css` | The live list, with all four states |
| `src/components/ScrollManager.jsx` | Scroll to top / to `#hash` on route change |
| `src/lib/api.js` | `fetch` wrapper, typed errors, human error copy |
| `server/` | Express + mysql2 API |
| `deploy/nginx.conf` | SPA fallback + `/api` proxy |
| `deploy/substrate-api.service` | systemd unit for the API |

React Router was added because the project had no routing at all; the original
brief said to introduce it only if genuinely necessary, and a dedicated page is.

## 2. Database

The database and the least-privilege user already exist on the EC2 host:

- database `substrate_db`
- user `substrate_app`@`localhost`

Nothing in this repo creates either. `npm run migrate` only creates the **table**,
and fails with a clear message if the database is missing or the password is wrong.

```sql
CREATE TABLE IF NOT EXISTS demo_requests (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  full_name   VARCHAR(120)    NOT NULL,
  email       VARCHAR(254)    NOT NULL,
  company     VARCHAR(120)        NULL,
  message     TEXT                NULL,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_demo_requests_created_at (created_at DESC)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
```

`substrate_app` needs only `SELECT, INSERT` on `substrate_db.demo_requests`, plus
`CREATE` if you want it to run the migration itself.

## 3. Running it locally

```bash
# 1. API configuration
cp server/.env.example server/.env      # then fill in DB_PASSWORD

# 2. Dependencies
npm install            # frontend
npm install --prefix server            # API

# 3. Create the table (idempotent)
npm run migrate --prefix server

# 4. Two processes
npm run dev --prefix server            # API  on :4000
npm run dev                            # site on :5173, proxying /api to :4000
```

Reaching the EC2 database from a workstation needs a tunnel, because MySQL there
listens on localhost only — which is how it should stay:

```bash
ssh -L 3307:127.0.0.1:3306 <user>@<ec2-host>
# then set DB_PORT=3307 in server/.env
```

## 4. API

Base path `/api`. JSON in, JSON out.

### `GET /api/demo-requests`

Returns the 8 most recent requests, newest first.

```json
{ "data": [
  { "name": "Ada Lovelace",
    "email": "ada@example.com",
    "company": "Analytical Engines",
    "submittedAt": "2026-08-29T20:00:11.000Z" }
] }
```

The row `id` and the free-text `message` are deliberately **not** selected — the
page does not render them, so they never reach the browser.

### `POST /api/demo-requests`

```json
{ "fullName": "Ada Lovelace", "email": "ada@example.com",
  "company": "Analytical Engines", "message": "..." }
```

`fullName` and `email` are required; `company` and `message` are optional and are
stored as `NULL` when blank.

| Status | Meaning |
| --- | --- |
| `201` | Stored. Returns the row in the shape above. |
| `400` | Validation failed. `{ error, fields: { email: "..." } }` — the page maps `fields` onto the inputs. |
| `429` | More than 5 **successful** writes from one IP in a minute. Carries `Retry-After`. |
| `500` | Logged server-side; the client gets an opaque message, never SQL. |

### `GET /api/health`

`{ "status": "ok", "database": "up" }`, or `503` when the pool cannot reach MySQL.
Useful as a load-balancer or monitoring check.

## 5. Security notes

- **Every query is parameterised.** No string interpolation reaches SQL.
- **Validation is server-side and authoritative.** The client validates too, but
  only for feedback; the server re-checks and is the copy that is trusted.
- **Rate limiting counts successful writes only.** A visitor who mistypes their
  email five times is not an attacker and must not be locked out — and failed
  validation never touches the database, so there is nothing to protect there.
- **Errors are opaque to the client.** Driver messages and SQL are logged, not returned.
- **Body cap of 16 kB**, plus per-field length limits mirrored in the column widths.
- **Credentials come from the environment.** `server/.env` is git-ignored; in
  production they live in `/etc/substrate/api.env`, read by systemd.

> **Privacy note.** The page publicly displays the name, email and company of
> everyone who submits, because that is what was specified. Real submitter email
> addresses on a public page are worth a second thought — masking to
> `a••@example.com`, or dropping the column, is a one-line change in
> `server/src/routes/demoRequests.js`.

## 6. Deployment

Two changes to how this repo is deployed.

### a. nginx must serve the SPA and proxy the API

`vite.config.js` now uses `base: '/'` instead of `'./'`. It has to: with a real
route, relative asset URLs would resolve against `/book-a-demo/` and 404. The
consequence is that the host must serve `index.html` for unknown paths, or a
refresh on `/book-a-demo` returns 404.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/substrate
sudo ln -sf /etc/nginx/sites-available/substrate /etc/nginx/sites-enabled/substrate
sudo nginx -t && sudo systemctl reload nginx
```

The important lines:

```nginx
location /api/ { proxy_pass http://127.0.0.1:4000; }
location /     { try_files $uri $uri/ /index.html; }
```

### b. The API needs to run as a service

```bash
sudo mkdir -p /etc/substrate
sudo cp server/.env.example /etc/substrate/api.env   # fill in the password
sudo chmod 600 /etc/substrate/api.env

sudo cp deploy/substrate-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now substrate-api
sudo systemctl status substrate-api
```

### c. The GitHub Actions workflow does not yet deploy the API

`.github/workflows/deploy.yml` builds the frontend and copies `dist/` to
`/var/www/substrate-website/current`. It does **not** ship `server/`, install its
dependencies, or restart the service — so the API has to be deployed by hand
until the workflow gains roughly these steps:

```yaml
- name: Ship the API
  uses: appleboy/scp-action@v0.1.7
  with:
    host: ${{ secrets.EC2_HOST }}
    username: ${{ secrets.EC2_USERNAME }}
    key: ${{ secrets.EC2_SSH_KEY }}
    source: "server/**"
    target: "/tmp/substrate-api"

- name: Install and restart
  uses: appleboy/ssh-action@v1.0.3
  with:
    host: ${{ secrets.EC2_HOST }}
    username: ${{ secrets.EC2_USERNAME }}
    key: ${{ secrets.EC2_SSH_KEY }}
    script: |
      sudo rsync -a --delete /tmp/substrate-api/server/ /var/www/substrate-website/server/
      cd /var/www/substrate-website/server && sudo npm ci --omit=dev
      sudo node src/migrate.js
      sudo systemctl restart substrate-api
```

## 7. Where the CTAs point

| Location | Before | After |
| --- | --- | --- |
| Navbar (desktop) | "Start a project" → `#contact` | "Book a demo" → `/book-a-demo` |
| Navbar (mobile menu) | — | "Book a demo" added as item 05 |
| Closing CTA section | mailto only | "Book a demo" button added, mailto kept as the secondary path |
| Footer, Contact column | mailto only | "Book a demo" link added |

The existing primary CTA was repointed rather than duplicated. The closing section
and footer gained a link because otherwise neither offered a route to the page.
