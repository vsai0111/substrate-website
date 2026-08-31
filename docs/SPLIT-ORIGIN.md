# Temporary split-origin setup (S3 frontend + EC2 API)

CloudFront is pending AWS account verification. Until then the frontend is served
from S3 and the API from EC2 — two different origins — so the browser needs to be
told where the API lives, and the API needs to be told which page origin may read
its responses.

```
Browser
  ├── GET  http://<bucket>.s3-website.<region>.amazonaws.com/   -> S3 (HTML, JS, CSS)
  └── POST http://<ec2-public-ip>/api/demo-requests             -> EC2 nginx :80
                                                                   -> node 127.0.0.1:4000
                                                                   -> MySQL
```

Two independent settings make this work. They solve different problems, live on
different machines, and are applied at different times:

| | `VITE_API_BASE_URL` | `CORS_ORIGINS` |
| --- | --- | --- |
| Question | Where does the browser send the request? | Which page origins may read the reply? |
| Applied | **Build time**, on the GitHub runner | **Runtime**, on EC2 |
| Lives in | Repository *variable* (not a secret) | `/etc/substrate/api.env` |
| Value | the **API** origin (EC2) | the **frontend** origin (S3) |
| Changing it needs | a rebuild + redeploy | `systemctl restart substrate-api` |

They point at each other — a common source of confusion. The frontend build is
told the *backend's* address; the backend is told the *frontend's* address.

## Why relative `/api` stops working on S3

`src/lib/api.js` builds every request as `` fetch(`${BASE}${path}`) ``. With `BASE`
empty, `/api/demo-requests` is resolved by the browser against the page's own
origin. Served from S3 that is the bucket, which has no `/api` object and no
proxy, so the request never reaches EC2. Nginx's `/api/` rule lives on EC2 and is
never consulted.

Setting `VITE_API_BASE_URL` makes `BASE` an absolute origin, so the request is
addressed to EC2 instead.

## CORS matching is exact

Verified against the real `server/src/index.js`:

| `CORS_ORIGINS` | Browser `Origin` | Result |
| --- | --- | --- |
| `http://site.example.com` | `http://site.example.com` | allowed |
| `http://site.example.com/` | `http://site.example.com` | **blocked** — trailing slash |
| `site.example.com` | `http://site.example.com` | **blocked** — scheme required |
| `https://site.example.com` | `http://site.example.com` | **blocked** — scheme must match |
| `http://a.com,http://site.example.com` | `http://site.example.com` | allowed — comma-separated |
| *(empty)* | anything | **blocked** |

Scheme + host (+ port if non-default). No trailing slash, no path.

## S3: use the website endpoint, not the REST endpoint

| | Website endpoint | REST endpoint |
| --- | --- | --- |
| Form | `http://BUCKET.s3-website.REGION.amazonaws.com` | `https://BUCKET.s3.REGION.amazonaws.com` |
| SPA fallback (error document) | **yes** | **no** |
| HTTPS | **no** | yes |
| `/book-a-demo` on refresh | serves index.html | XML 404 — app never loads |

The app has client-side routes, so the **website endpoint is required**. That makes
the frontend HTTP-only for now, which is also why the API must be called over
plain HTTP: an HTTPS page calling an HTTP API is blocked as mixed content.

Required bucket settings:

- Static website hosting: **Enabled**
- Index document: `index.html`
- Error document: `index.html`  ← without this, refreshing `/book-a-demo` 404s

Note the error document is returned with HTTP **404**, not 200. The page renders
correctly; only the status line is wrong. CloudFront custom error responses fix
that properly later.

## What changes when CloudFront arrives

Everything here is reversible in two settings and no code change:

1. Delete the `VITE_API_BASE_URL` repository variable and re-run the frontend
   workflow. `BASE` falls back to `''` and requests go same-origin again.
2. Blank `CORS_ORIGINS` in `/etc/substrate/api.env` and restart the service.
   CloudFront serves the site and `/api` under one origin, so the browser sends
   no `Origin` header for these requests and CORS stops being involved.

The build guard in `frontend.yml` currently *fails* the build when the variable is
missing. When you migrate, remove that guard in the same commit.
