# threejs-water (vendored for reference and porting)

- Upstream: https://github.com/jeantimex/threejs-water (commit f35a700, 2026-09-06)
- Licence: MIT. Original work © 2011 Evan Wallace (WebGL Water, http://madebyevan.com/webgl-water/); modified work © 2026 Yong Su. See `LICENSE`, which must stay with this code and with anything derived from it.
- Only `src/`, `LICENSE`, `README.md` and `package.json` are copied. The upstream `public/` folder is left out on purpose: the pool tile texture comes from a third-party Flickr photo (zooboing) and the skybox images have no stated licence, and `public/models/duck` is the Khronos sample Duck (Sony Computer Entertainment, SCEA Shared Source License 1.0). None of those are covered by the MIT grant, so none ship with the game.
- This is TypeScript + GLSL (imported with vite-plugin-glsl) against three 0.184; the game is plain ES modules on vendored three r160 and does not load anything from here. Port what you use into `src/` and keep the notice in `THIRD_PARTY_NOTICES.md`.
