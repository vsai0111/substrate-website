# SUBSTRATE — Technology & Product Studio

A production-ready, static single-page marketing site for a fictional technology and
product studio. Built as a **React + Vite + JavaScript** application with **zero runtime
dependencies beyond React itself** — no UI kit, no animation library, no icon package,
no router, no backend, no database, no external API, and no network calls at runtime.

The site is designed to be built with `npm run build` and served as static files from
S3 + CloudFront (or any static host).

> Substrate is an invented brand. All copy, project names, statistics and social links
> are fictional placeholder content.

---

## 1. Install dependencies

```bash
npm install
```

Requires Node.js 20.19+ (developed on Node 24). Installs React, React DOM, Vite and the
Vite React plugin — 22 packages total, 0 vulnerabilities.

## 2. Run locally

```bash
npm run dev
```

Serves the app at <http://localhost:5173> with hot module replacement.

## 3. Create the production build

```bash
npm run build
```

Compiles, minifies and hashes everything into `dist/`. Typical output:

```
dist/index.html                  0.99 kB │ gzip:  0.47 kB
dist/assets/style-[hash].css    34.00 kB │ gzip:  7.32 kB
dist/assets/index-[hash].js    223.21 kB │ gzip: 69.80 kB
```

## 4. Preview the production build

```bash
npm run preview
```

Serves the contents of `dist/` at <http://localhost:4173> exactly as a static host would.
Use this to verify the build before deploying — it is the closest local equivalent to
S3 + CloudFront.

Any static server works too:

```bash
npx serve dist
python -m http.server 8000 --directory dist
```

## 5. What is generated inside `dist/`

```
dist/
├── index.html                 entry document; references the hashed assets below
├── favicon.svg                copied verbatim from public/
└── assets/
    ├── index-[hash].js        the whole application (React + all components)
    └── style-[hash].css       every stylesheet, concatenated and minified
```

Notes that matter for deployment:

- **Content-hashed filenames.** `index-a1b2c3d4.js` changes whenever its content changes,
  so `assets/*` can be cached immutably and forever.
- **`index.html` is never hashed.** It must be served with a short/no-cache policy,
  otherwise browsers keep loading a stale document pointing at deleted assets.
- **Relative asset paths.** `vite.config.js` sets `base: './'`, so the build works from a
  bucket root, a CloudFront origin path, or a subdirectory without reconfiguration.
- **Everything in `public/`** is copied to the root of `dist/` untouched.
- **No environment variables** are read at build or runtime — the build is deterministic
  and identical across environments.

## 6. Deploying as a static website on AWS

The app is a pure static bundle, so the deployment is a file sync plus a cache
invalidation.

### Recommended: private S3 bucket behind CloudFront (OAC)

1. **Create an S3 bucket** (no static-website hosting, no public access — CloudFront
   reaches it through Origin Access Control).
2. **Create a CloudFront distribution** with the bucket as origin, OAC enabled, and
   `index.html` as the Default Root Object. Set Viewer Protocol Policy to
   *Redirect HTTP to HTTPS*.
3. **Request an ACM certificate** in `us-east-1` for your domain and attach it, then point
   Route 53 at the distribution with an A/AAAA alias record.
4. **Upload with split cache headers:**

```bash
# Immutable, hashed assets — cache for a year
aws s3 sync dist/ s3://YOUR_BUCKET/ \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable"

# The entry document — always revalidate
aws s3 cp dist/index.html s3://YOUR_BUCKET/index.html \
  --cache-control "public,max-age=0,must-revalidate" \
  --content-type "text/html"

# Publish the new version at the edge
aws cloudfront create-invalidation \
  --distribution-id YOUR_DIST_ID \
  --paths "/index.html"
```

Invalidating only `/index.html` is enough and is the cheapest correct approach: the
hashed assets are new files, so they were never cached under those names.

### SPA routing

This site is a **single page with in-page anchors** (`#work`, `#about`, `#experiments`,
`#contact`) and deliberately ships **no React Router**, so there are no client-side routes
that can 404 on refresh.

If you later add React Router, add a CloudFront **custom error response** mapping
`403` and `404` → `/index.html` with response code `200`, so deep links resolve to the
app shell.

### Simplest alternative

**AWS Amplify Hosting** will connect to the GitHub repo, detect Vite, run
`npm ci && npm run build`, publish `dist/`, and manage TLS, CDN and PR previews for you.
Fewer moving parts than S3 + CloudFront, and a good starting point before wiring the
pipeline manually.

## 7. Appropriate AWS services for this architecture

| Concern | Service | Why |
| --- | --- | --- |
| Object storage / origin | **S3** | Stores the `dist/` output; no compute needed |
| CDN + TLS | **CloudFront** | Edge caching, HTTPS, compression, HTTP/3 |
| Origin protection | **CloudFront OAC** | Keeps the bucket private; no public objects |
| Certificates | **ACM** (`us-east-1`) | Free TLS certificates for CloudFront |
| DNS | **Route 53** | Alias records pointing at the distribution |
| Build/deploy | **CodeBuild + CodePipeline**, or **GitHub Actions** | Runs the npm build and syncs to S3 |
| CI credentials | **IAM + OIDC** | Short-lived role assumption; no stored keys |
| Artifacts | **S3 (separate bucket)** | Build artifacts and pipeline state |
| Logs / alarms | **CloudWatch** | Build logs, CloudFront metrics, 5xx alarms |
| Infrastructure as code | **CloudFormation / CDK / Terraform** | Reproducible environments |
| All-in-one option | **Amplify Hosting** | Bundles build, CDN, TLS, PR previews |

Deliberately **not** needed: EC2, ECS, Lambda, API Gateway, RDS, DynamoDB, Cognito.
There is no server and no state.

## 8. Suggested GitHub → AWS CI/CD architecture

```
 ┌──────────┐   push / PR   ┌──────────────────┐
 │  GitHub  │ ────────────▶ │  GitHub Actions  │
 └──────────┘               └────────┬─────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
      npm ci (locked)         npm run build          assume IAM role
      lint / audit            → dist/                via OIDC (no keys)
                                     │
                                     ▼
                        ┌────────────────────────┐
                        │  aws s3 sync dist/     │
                        │  (split cache headers) │
                        └───────────┬────────────┘
                                    ▼
                        ┌────────────────────────┐
                        │  CloudFront            │
                        │  invalidate /index.html│
                        └───────────┬────────────┘
                                    ▼
                            https://your-domain
```

**Recommended flow**

1. **Trunk-based branching.** `main` is always deployable; feature branches open PRs.
2. **PR job** — `npm ci`, `npm run build`, `npm audit --production`. Never deploys.
   Optionally publish a preview to a `previews/pr-<n>/` prefix behind the same
   distribution.
3. **Deploy job** — runs only on push to `main`. Same build, then sync + invalidate.
4. **Authentication via GitHub OIDC.** Create an IAM role trusting
   `token.actions.githubusercontent.com`, scoped to this repository, permitting only
   `s3:PutObject`/`DeleteObject`/`ListBucket` on the site bucket and
   `cloudfront:CreateInvalidation` on the one distribution. **No long-lived access keys
   in GitHub secrets.**
5. **Environment protection.** Put the deploy job in a GitHub Environment (`production`)
   with a required reviewer if you want a manual gate.
6. **Rollback.** Because assets are content-hashed and immutable, the previous version's
   files are still in the bucket — redeploy the previous commit (or re-upload the previous
   `index.html`) to roll back instantly.
7. **Infrastructure as code.** Keep bucket, distribution, OAC, ACM and the IAM role in
   CDK or Terraform in the same repo, so the environment is reproducible.

A natural progression for a hands-on DevOps project: **Amplify Hosting → GitHub Actions
+ S3/CloudFront → the same pipeline defined in Terraform/CDK → add CloudWatch alarms and
a staging environment.**

> Infrastructure has intentionally **not** been implemented in this repository — only the
> application and this deployment guidance.

---

## Project structure

```
src/
├── main.jsx                  React root; imports the global stylesheets
├── App.jsx                   Composes the sections; no logic beyond ordering
├── data/
│   └── site.js               All copy and content in one place
├── hooks/
│   ├── useReveal.js          Scroll-in reveal (one IntersectionObserver per element)
│   ├── useReducedMotion.js   Tracks prefers-reduced-motion, reacts to live changes
│   └── useScrollSpy.js       Highlights the nav link for the section in view
├── components/
│   ├── Reveal.jsx            Reveal wrapper, preserves the semantic element
│   ├── SectionHeader.jsx/css Repeating index + label + note header
│   ├── ProjectVisual.jsx/css Five generative SVG placeholders
│   ├── Marquee.jsx/css       Seamless ticker
│   └── Icons.jsx             Five hand-rolled inline SVG icons
├── sections/
│   ├── Navbar.jsx/css        Fixed nav, scroll-spy, mobile panel with focus trap
│   ├── Hero.jsx/css          Editorial display type, masked line reveal
│   ├── Terminal.jsx/css      Interactive shell (boot, history, tab-completion)
│   ├── Projects.jsx/css      Accordion project rows
│   ├── About.jsx/css         Studio statement and stats
│   ├── Experiments.jsx/css   Hollow-type word list with linked notes
│   ├── Capabilities.jsx/css  Minimal capability list
│   ├── Process.jsx/css       Six-step rail
│   ├── CTA.jsx/css           Closing statement and contact
│   └── Footer.jsx/css        Brand, index, elsewhere, contact
└── styles/
    ├── tokens.css            Colour, type scale, spacing, motion tokens
    └── base.css              Reset, base type, layout primitives, reveal, focus
```

Component CSS lives next to the component it styles and uses a component-prefixed class
convention (`hero__title`, `project__panel`), so no scoping tooling is required.

## Design system

- **Palette** — monochrome. `#0b0b0c` ground, a four-step ink ramp, hairline rules at
  5.5%/11%/20% white. One signal green (`#9be07a`) reserved exclusively for the terminal.
- **Type** — system font stacks only (no webfonts, no network requests). A fluid display
  scale via `clamp()` for 375px → 1440px, uppercase display at `-0.045em` tracking, and
  mono micro-labels at `+0.14em`.
- **Layout** — a 1440px shell with fluid gutters, asymmetric grids that collapse to
  intentionally rebuilt mobile layouts (not shrunken desktop ones).
- **Motion** — transform/opacity only, IntersectionObserver-driven, observers disconnect
  after firing. Every animation has a `prefers-reduced-motion` path.

## The terminal

Frontend only — no backend, no requests. Commands: `help`, `about`, `work`,
`experiments`, `capabilities`, `contact`, `whoami`, `clear`, plus `echo` and a `sudo`
easter egg. Supports command history (`↑`/`↓`), prefix tab-completion, `ctrl+l` to clear,
and `esc` to leave the shell. The boot sequence types itself out when the section scrolls
into view and completes instantly if you start typing.

## Accessibility

- Semantic landmarks (`header`, `nav`, `main`, `footer`) and a correct heading outline
  (one `h1`, no skipped levels).
- Skip link, visible `:focus-visible` rings on every interactive element, and a logical
  tab order.
- The mobile menu traps focus while open, closes on `Escape`, and restores focus to the
  toggle.
- The terminal is explicitly **not** a keyboard trap: `Tab` only completes when there is
  a new completion, otherwise it moves focus on; `Escape` always exits.
- All text meets WCAG AA contrast (the small mono labels sit at 4.8:1 against the ground).
- `prefers-reduced-motion: reduce` disables reveals, marquees, the caret blink and the
  ambient drift.

## Performance

- 3 files, ~78 kB gzipped total.
- No webfonts, no images, no external requests — the page renders fully offline.
- Visuals are inline SVG and CSS gradients.
- Animations are limited to `transform`/`opacity`; scroll listeners are passive and
  observers disconnect once they have fired.

## Browser support

Modern evergreen browsers. Uses `:has()` (terminal focus ring), `svh` units, CSS nesting-free
plain CSS, `aspect-ratio` and animated `grid-template-rows`. `-webkit-text-stroke` has an
`@supports` fallback.
