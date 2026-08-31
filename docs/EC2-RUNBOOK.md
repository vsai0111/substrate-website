# First deployment runbook (EC2)

Run these on the EC2 host. Everything is idempotent — safe to re-run.

Adjust two things for your distro first:
- **Service user.** `deploy/substrate-api.service` says `User=www-data` (Debian/Ubuntu).
  On Amazon Linux use `nginx`. Check with `id www-data || id nginx`.
- **nginx paths.** `sites-available/sites-enabled` is Debian/Ubuntu. On Amazon Linux
  drop the file into `/etc/nginx/conf.d/substrate.conf` instead and skip the symlink.

---

## 0. Prerequisites

```bash
node -v          # must be >= 20; the API uses ESM + node:module hooks
nginx -v
systemctl is-active mysql || systemctl is-active mysqld
```

If Node is missing (Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 1. Get the API onto the box

The GitHub Actions workflow only ships `dist/`, so `server/` has to arrive separately.
Cloning is the least fiddly:

```bash
sudo mkdir -p /var/www/substrate-website
sudo chown -R "$USER" /var/www/substrate-website
cd /var/www/substrate-website

# first time
git clone <your-repo-url> repo
# afterwards
cd repo && git pull

# link the API into place
sudo rm -rf /var/www/substrate-website/server
sudo cp -r /var/www/substrate-website/repo/server /var/www/substrate-website/server
```

## 2. Credentials (one file, root-owned)

```bash
sudo mkdir -p /etc/substrate
sudo tee /etc/substrate/api.env >/dev/null <<'EOF'
PORT=4000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=substrate_app
DB_PASSWORD=REPLACE_WITH_THE_REAL_PASSWORD
DB_NAME=substrate_db
CORS_ORIGINS=
EOF
sudo chmod 600 /etc/substrate/api.env
```

If the password contains spaces, `#`, or quotes, wrap it in single quotes:
`DB_PASSWORD='p@ss word#1'`. The file is sourced by a shell, so an unquoted
special character will silently truncate the value.

`CORS_ORIGINS` is intentionally empty: in production the browser talks to `/api` on the
same origin through nginx, so cross-origin access should be refused.

## 3. Install dependencies and create the table

```bash
cd /var/www/substrate-website/server
npm ci --omit=dev

# api.env is root-only, so source it inside a root shell rather than
# exporting the password into your own session.
sudo bash -c 'set -a; . /etc/substrate/api.env; set +a; exec node src/migrate.js'
```

Expected:

```
[migrate] ok - `substrate_db`.demo_requests is ready (0 row(s))
```

If it says **access denied**, the password in `/etc/substrate/api.env` is wrong.
If it says **database does not exist**, `substrate_db` was never created.

Confirm the table and the grants:

```bash
mysql -u substrate_app -p substrate_db -e "SHOW CREATE TABLE demo_requests\G"
mysql -u substrate_app -p -e "SHOW GRANTS FOR CURRENT_USER;"
```

`substrate_app` needs at least `SELECT, INSERT ON substrate_db.demo_requests`.

## 4. Start the API as a service

```bash
sudo cp /var/www/substrate-website/repo/deploy/substrate-api.service \
        /etc/systemd/system/
# edit User= if you are not on Debian/Ubuntu
sudo systemctl daemon-reload
sudo systemctl enable --now substrate-api
systemctl status substrate-api --no-pager
```

Healthy output includes `[api] database connection ok` and
`[api] listening on http://127.0.0.1:4000`. If it exits immediately:

```bash
journalctl -u substrate-api -n 50 --no-pager
```

## 5. Point nginx at both

```bash
sudo cp /var/www/substrate-website/repo/deploy/nginx.conf \
        /etc/nginx/sites-available/substrate
sudo ln -sf /etc/nginx/sites-available/substrate /etc/nginx/sites-enabled/substrate
sudo rm -f /etc/nginx/sites-enabled/default        # if it would shadow this site
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Verify — paste this whole block and send me the output

```bash
echo "== 1. API health (expect status ok, database up) =="
curl -s http://127.0.0.1:4000/api/health; echo

echo "== 2. GET through nginx (expect {\"data\":[...]}) =="
curl -s http://127.0.0.1/api/demo-requests; echo

echo "== 3. POST a real row (expect HTTP 201 + the stored row) =="
curl -s -o /tmp/post.json -w "HTTP %{http_code}\n" \
  -X POST http://127.0.0.1/api/demo-requests \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"Deployment Check","email":"deploy-check@example.com","company":"Substrate","message":"Runbook verification."}'
cat /tmp/post.json; echo

echo "== 4. Validation rejected server-side (expect HTTP 400 + fields) =="
curl -s -o /tmp/bad.json -w "HTTP %{http_code}\n" \
  -X POST http://127.0.0.1/api/demo-requests \
  -H 'Content-Type: application/json' -d '{"fullName":"","email":"nope"}'
cat /tmp/bad.json; echo

echo "== 5. The row is really in MySQL (prompts for the password) =="
mysql -u substrate_app -p substrate_db \
  -e "SELECT id, full_name, email, company, created_at FROM demo_requests ORDER BY id DESC LIMIT 3;"

echo "== 6. SPA fallback (both must be HTTP 200) =="
curl -s -o /dev/null -w "/            -> %{http_code}\n" http://127.0.0.1/
curl -s -o /dev/null -w "/book-a-demo -> %{http_code}\n" http://127.0.0.1/book-a-demo

echo "== 7. Assets resolve from the site root (expect 200) =="
asset=$(grep -o '/assets/[^"]*\.js' /var/www/substrate-website/current/index.html | head -1)
curl -s -o /dev/null -w "$asset -> %{http_code}\n" "http://127.0.0.1$asset"
```

### Remove the test row afterwards

Step 3 writes a real row that will show up in *Recently Submitted Users*:

```bash
mysql -u substrate_app -p substrate_db \
  -e "DELETE FROM demo_requests WHERE email = 'deploy-check@example.com';"
```

(That needs `DELETE` on the table. If `substrate_app` only has `SELECT, INSERT`,
run it as an admin user instead - or just leave the row and delete it later.)

## 7. What "working" looks like

| Check | Expected |
| --- | --- |
| 1 | `{"status":"ok","database":"up"}` |
| 2 | `{"data":[]}` on a fresh table |
| 3 | `HTTP 201` and a row with `name`, `email`, `company`, `submittedAt` — **no `id`, no `message`** |
| 4 | `HTTP 400` with `fields.fullName` and `fields.email` |
| 5 | The row present in MySQL, `company` populated |
| 6 | Both `200` — a `404` on `/book-a-demo` means the nginx fallback is not active |
| 7 | `200` — a `404` means `base` is wrong or `dist/` was built before the `base: '/'` change |

Then open `http://<ec2-host>/book-a-demo` in a browser: the form should submit and the
new entry should appear in *Recently Submitted Users* **without a page refresh**.

## 8. Note on redeploys

The Actions workflow wipes and replaces `/var/www/substrate-website/current`, which is
only the frontend — it does not touch `server/` or restart `substrate-api`. After any
change under `server/`, repeat steps 1, 3 and:

```bash
sudo systemctl restart substrate-api
```

Until the workflow gains those steps (sketched in `docs/BOOK-A-DEMO.md` §6c), the API
is deployed by hand.
