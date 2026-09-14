# Website recordings

The landing page lives in `docs/` and is published by the existing GitHub Pages configuration (main branch, `/docs`, blattbot.com). It is separate from the app's Vite build. No npm release is needed to publish website changes.

The lead walkthrough records a real agent turn: request → LaTeX edit → compilation → diff/PDF review → local approval. Long waits are removed using recorded tool-event timestamps; the actual edit, result and approval remain visible. Approval is checked against the project's clean working state. Overleaf sync is described as an option for connected projects, not presented as having happened in this local recording.

The three supporting walkthroughs use the same real app and isolated sample project. The sample uses the BERT and T5 papers, retrieved from arXiv, citation edges returned by OpenAlex, and evidence assessments produced by the configured Codex backend. Research data is prepared before recording. Those clips show navigation through saved results, not model response times. Only the explanatory captions and pointer are presentation overlays. No private project, model reply or citation edge is staged as real data.

## Record and render

Requires Node 20+, the repository dependencies, Chromium, FFmpeg with H.264/WebP support, a working TeX engine and a logged-in Codex CLI. Preparation runs real model checks and uses the normal account limits. Public paper/graph services may throttle requests; rerunning preparation reuses completed work.

From the repository root:

```sh
npm run build --workspace=web
npx tsx server/scripts/site-demo-project.ts --prepare
npx tsx server/scripts/record-site-demos.ts
node server/scripts/render-site-demos.mjs
```

The app build must use the default `/` base. Port 4638 must be free. Preparation writes only to `/tmp/blattbot-site-demo` by default; `DEMO_DATA_DIR` selects a different isolated directory. Do not point it at an existing user's BlattBot data. The directory contains the sample project, cached research results, provenance record, raw videos, timestamps and screenshots. The recorder resets only its sample manuscript and policy between clips and checks that the writing demo makes exactly the intended edit and still compiles.

Use `DEMO_CLIP=workflow`, `evidence`, `graph` or `writing` to repeat one clip. Recording `workflow` starts a new real model turn and commits its sample edit. The renderer also accepts `DEMO_CLIP` and maps captions onto the retained video segments. `DEMO_OUT_DIR` changes the recordings folder; `BLATTBOT_BROWSER_EXECUTABLE` changes Chromium's executable; `DEMO_FFMPEG` changes FFmpeg (default `/usr/bin/ffmpeg`). Recordings use the app at its native layout, without CSS zoom. The renderer exports 24 fps H.264 with fast start, WebP posters/screenshots, caption tracks and the README's core-workflow preview.

## Check the site

```sh
python3 -m http.server 4640 --bind 127.0.0.1 --directory docs
# In another terminal:
node server/scripts/verify-site.mjs
```

Review the screenshots in `/tmp/blattbot-site-demo/site-qa` and sample frames from each clip before publishing. Set `SITE_URL=https://blattbot.com` to run the same checks after GitHub Pages finishes deployment. The recordings contain no audio, have burned-in explanations, optional caption tracks and a text walkthrough. Videos start only after a user action and pause offscreen.

The site's Research preview notice must stay until the demonstrated features are actually included in the stable npm release. Do not remove it just because a website build succeeded.
