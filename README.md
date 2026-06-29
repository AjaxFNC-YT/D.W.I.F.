# D.W.I.F.

<p align="center">
  Discord Widget Image Fixer.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-18%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node 18+">
  <img src="https://img.shields.io/badge/output-PNG-8A2BE2?style=flat-square" alt="PNG output">
  <img src="https://img.shields.io/badge/auto%20sizing-enabled-4C9A2A?style=flat-square" alt="Auto sizing enabled">
</p>

<p align="center">
  Small Node.js tool for adding a transparent top strip and rounded top-right corner to widget images.
</p>

<p align="center">
  <a href="#install">Install</a> |
  <a href="#quick-use">Quick Use</a> |
  <a href="#folders">Folders</a> |
  <a href="#manual-options">Manual Options</a> |
  <a href="#notes">Notes</a>
</p>

---

## Install

Requires Node.js 18+.

Download Node.js here:

- [Node.js 18+](https://nodejs.org/)

After installing it, open a terminal and run:

```bash
node -v
npm -v
```

If both commands return a version, you are good.

Then install the package:

```bash
npm install
```

## Quick Use

The easiest way:

```bash
node index.mjs input.png
```

That will:

- keep the original image size
- auto-calculate the top strip
- auto-calculate the corner radius
- save a PNG into the local `output` folder

If you run it with no paths:

```bash
node index.mjs
```

it will ask for the input image and output file name.

## Folders

- put normal input images in `input/`
- generated files always go into `output/`
- if you want, you can also pass a full absolute path to an image outside the `input/` folder

Examples:

```bash
node index.mjs input.png
node index.mjs input\input.png
node index.mjs input.png output.png
node index.mjs C:\full\path\image.png output.png
```

## Manual Options

Format:

```bash
node index.mjs <input-image> [output-name] [top-strip] [radius]
```

Example:

```bash
node index.mjs input.png output.png 17 36
```

You can also override just one value and let the other auto-calculate.

```bash
node index.mjs input.png output.png 17
```

Help:

```bash
node index.mjs --help
```

## Notes

- Output is always saved as PNG.
- The script keeps the original image size and aspect ratio.
- Auto sizing is based on these reference matches:
  - `512x512` -> `17 / 36`
  - `1844x853` -> `33 / 93`
- You may see a warning when the source image is not `512x512`, since that is the original widget reference size.
