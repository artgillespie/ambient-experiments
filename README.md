# ambient experiments

Generative ambient installations for the web: music, sound design and image made
live in the browser. Each experiment is a self-contained directory with **no
dependencies and no build step**: plain ES modules, Web Audio (AudioWorklet)
and WebGL, openable from any static file server.

| experiment | |
|---|---|
| [**wet-on-wet**](wet-on-wet/) | Slow modal music and Eno-style tape loops through *Nebula*, a vast modulated FDN reverb in the spirit of Valhalla Supermassive, painted live as dripping watercolor (WebGL2 fluid + pigment simulation). |

Live: **https://ambient.artgillespie.workers.dev**

## Running an experiment

```sh
cd wet-on-wet
npm start          # http://localhost:8080 (Node ≥ 20, nothing to install)
```

Each experiment's README describes its controls, URL parameters and internals.

## Deploying

The repo root is the site (Cloudflare Workers static assets, no build step). Every
experiment is served at `/<name>/`; `index.html` at the root is the gallery, so add a
line there for each new piece. Dev-only files are kept out by `.assetsignore`.

```sh
npx wrangler@4 deploy      # → https://ambient.artgillespie.workers.dev
```

## Conventions

- One directory per piece, self-contained, zero runtime dependencies.
- Audio engines are plain JS that also runs in Node, so a piece can be rendered
  offline and measured (`npm run render`) without a browser.
- Deterministic by seed: the same `?seed=` gives the same piece.

## License

[MIT](LICENSE)
