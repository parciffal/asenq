# Browser city assets

## Skyline and reference

AI-generated, project-owner supplied, 2026-10-12. Both skyline layers were generated with `openai-codex/gpt-image-2-codex`, using `source/reference.png` as Image 1, the owner's architecture/pixel-style reference. Requested output was 1536×1024; the tool retained the reference dimensions, producing 1672×941 images. The original decoded pixels are preserved losslessly in `source/skyline-far.png` and `source/skyline-mid.png`.

Shared style prompt: “Image 1 is the style reference. Pixel art, retro game background layer, crisp pixels, limited palette #100609 #281018 #a52b3a #55ced1 #e8dec8 #f4e45a, no text, no logos, no people.”

Far prompt: “distant cyberpunk night skyline panorama, tall tower silhouettes, sparse red and cyan lit windows, rain haze, dark burgundy sky”.

Mid prompt: “Image 1 architecture pixel style reference; low rooftops/elevated highway/antennas/water tanks, red/cyan windows, flat uniform #ff00ff sky/negative space, architecture palette #100609 #281018 #a52b3a #55ced1 #e8dec8 #f4e45a, no people/text/logos/UI.”

The mid generation produced black RGB sky pixels with alpha 0 instead of the requested opaque magenta sky. `scripts/pixelize-backdrop.mjs` decodes its original PNG and flood-fills only near-black pixels (all RGB channels ≤8) connected to the upper edge, replacing those with opaque magenta before filtering. It also normalizes existing alpha-0 pixels to the same key color, including open gaps under the highway: ffmpeg's colorkey replaces input alpha, so leaving their RGB black would make them opaque. Enclosed opaque black building interiors are not changed. The source PNG remains unmodified. Both layers are area-scaled to width 480, cropped to 480×270 from the bottom, quantized to at most 24 colors with no dithering, and mirrored horizontally into seamless 960×270 tiles. Mid additionally applies `colorkey=0xff00ff:0.25:0.05` for transparency. RGBA is preserved before mirroring and stacking. Output files are `web/city/assets/skyline-far.png` and `skyline-mid.png`. Reproduce with `node scripts/pixelize-backdrop.mjs` (ffmpeg required).

## Vendored Phaser

Phaser 3.90.0, MIT license, © 2024 Richard Davey, Phaser Studio Inc. Distribution and license from https://registry.npmjs.org/phaser/-/phaser-3.90.0.tgz, without an npm dependency. Verified archive integrity:

`sha512-/cziz/5ZIn02uDkC9RzN8VF9x3Gs3XdFFf9nkiMEQT3p7hQlWuyjy4QWosU802qqno2YSLn2BfqwOKLv/sSVfQ==`

Shipped at `web/city/vendor/phaser-3.90.0.min.js` and `PHASER-LICENSE.md`.

## Fonts

Share Tech Mono Regular: https://raw.githubusercontent.com/google/fonts/main/ofl/sharetechmono/ShareTechMono-Regular.ttf, with its adjacent `OFL.txt`, © 2012 Carrois Type Design, Ralph du Carrois (Reserved Font Name “Share”).

Silkscreen Regular: https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/Silkscreen-Regular.ttf, with its adjacent `OFL.txt`, © 2001 The Silkscreen Project Authors.

Both fonts are unmodified and licensed under SIL Open Font License 1.1. The fonts and complete licenses are shipped in `web/city/fonts/`; license filenames are `OFL-ShareTechMono.txt` and `OFL-Silkscreen.txt`.

Character derivation and provenance are recorded in `assets/characters/ATTRIBUTION.md`.
