import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import gifenc from "gifenc";
import WebPMux from "node-webpmux";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const { GIFEncoder, applyPalette, quantize } = gifenc;

const REFERENCE_SIZE = 512;
const AUTO_TOP_STRIP_BASE = 17;
const AUTO_RADIUS_BASE = 36;
const AUTO_TOP_STRIP_EXPONENT =
  Math.log(54 / 17) / Math.log(Math.sqrt(1844 * 853) / REFERENCE_SIZE);
const AUTO_RADIUS_EXPONENT =
  Math.log(172 / 36) / Math.log(Math.sqrt(1844 * 853) / REFERENCE_SIZE);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(SCRIPT_DIR, "input");
const OUTPUT_DIR = path.join(SCRIPT_DIR, "output");

function printUsage() {
  console.log(`Usage:
  node index.mjs <input-image> [output-name] [top-strip] [radius]

Examples:
  node index.mjs input.png
  node index.mjs input.png output.png
  node index.mjs C:\\full\\path\\image.png output.png 17 36
  node index.mjs

Notes:
  - Skip top-strip and radius to auto-calculate them from image size.
  - Relative input names are loaded from the local input folder.
  - Full absolute input paths are also supported.
  - Output always goes into the local output folder.
  - Output format follows the output file extension: .png, .webp, or .gif.
  - Animated output is supported for .webp and .gif.
  - The auto sizing is calibrated from 512x512 -> 17/36 and 1844x853 -> 54/172.
`);
}

async function collectPaths(cliInputPath, cliOutputPath) {
  if (cliInputPath && cliOutputPath) {
    return {
      inputPath: resolveInputPath(cliInputPath),
      outputPath: resolveOutputPath(cliInputPath, cliOutputPath)
    };
  }

  if (!input.isTTY) {
    const stdinText = await new Promise((resolve, reject) => {
      let data = "";
      input.setEncoding("utf8");
      input.on("data", (chunk) => {
        data += chunk;
      });
      input.on("end", () => resolve(data));
      input.on("error", reject);
    });

    const lines = stdinText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const inputPath = cliInputPath?.trim() || lines[0] || "";

    if (!inputPath) {
      throw new Error("Input image path is required.");
    }

    return {
      inputPath: resolveInputPath(inputPath),
      outputPath: resolveOutputPath(inputPath, cliOutputPath?.trim() || lines[1] || "")
    };
  }

  const rl = readline.createInterface({ input, output });

  try {
    const inputPath =
      cliInputPath?.trim() || (await rl.question("Input image path: ")).trim();

    if (!inputPath) {
      throw new Error("Input image path is required.");
    }

    const defaultOutputName = getDefaultOutputName(inputPath);
    const outputName =
      cliOutputPath?.trim() ||
      (await rl.question(`Output file name [${defaultOutputName}]: `)).trim() ||
      defaultOutputName;

    return {
      inputPath: resolveInputPath(inputPath),
      outputPath: resolveOutputPath(inputPath, outputName)
    };
  } finally {
    rl.close();
  }
}

function getDefaultOutputName(inputPath) {
  const parsed = path.parse(inputPath);
  return `${parsed.name}-resized${parsed.ext || ".png"}`;
}

function resolveInputPath(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  const normalizedInputPath = inputPath.replace(/^[.][\\/]/, "");
  const localScriptPath = path.join(SCRIPT_DIR, normalizedInputPath);

  if (normalizedInputPath.startsWith(`input${path.sep}`) || normalizedInputPath === "input") {
    return localScriptPath;
  }

  return path.join(INPUT_DIR, normalizedInputPath);
}

function resolveOutputPath(inputPath, outputName) {
  const finalName = outputName ? path.basename(outputName) : getDefaultOutputName(inputPath);
  return path.join(OUTPUT_DIR, finalName);
}

function parseOptionalNumber(value, label) {
  if (value == null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }

  return parsed;
}

function getAutoValue(baseValue, exponent, width, height) {
  const sizeFactor = Math.sqrt(width * height) / REFERENCE_SIZE;
  return Math.max(0, Math.round(baseValue * Math.pow(sizeFactor, exponent)));
}

function buildCornerCutout(radius) {
  return sharp({
    create: {
      width: radius,
      height: radius,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${radius}" height="${radius}" viewBox="0 0 ${radius} ${radius}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${radius}" height="${radius}" fill="white"/>
          </svg>`
        )
      },
      {
        input: Buffer.from(
          `<svg width="${radius}" height="${radius}" viewBox="0 0 ${radius} ${radius}" xmlns="http://www.w3.org/2000/svg">
            <circle cx="0" cy="${radius}" r="${radius}" fill="black"/>
          </svg>`
        ),
        blend: "dest-out"
      }
    ])
    .png()
    .toBuffer();
}

function applyWidgetFixToRawFrames(inputData, width, frameHeight, frameCount, topStrip, radius) {
  const outputData = Buffer.alloc(width * frameHeight * frameCount * 4, 0);
  const frameStride = width * frameHeight * 4;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameOffset = frameIndex * frameStride;

    for (let y = 0; y < frameHeight; y += 1) {
      const destinationY = y + topStrip;

      if (destinationY >= frameHeight) {
        continue;
      }

      for (let x = 0; x < width; x += 1) {
        const sourceIndex = frameOffset + (y * width + x) * 4;
        const destinationIndex = frameOffset + (destinationY * width + x) * 4;

        outputData[destinationIndex] = inputData[sourceIndex];
        outputData[destinationIndex + 1] = inputData[sourceIndex + 1];
        outputData[destinationIndex + 2] = inputData[sourceIndex + 2];
        outputData[destinationIndex + 3] = inputData[sourceIndex + 3];
      }
    }

    if (radius <= 0) {
      continue;
    }

    const cornerStartX = width - radius;

    for (let localY = 0; localY < radius; localY += 1) {
      const y = topStrip + localY;

      if (y >= frameHeight) {
        break;
      }

      for (let localX = 0; localX < radius; localX += 1) {
        const x = cornerStartX + localX;
        const dx = localX;
        const dy = localY - radius;

        if ((dx * dx) + (dy * dy) <= radius * radius) {
          continue;
        }

        const destinationIndex = frameOffset + (y * width + x) * 4;
        outputData[destinationIndex + 3] = 0;
      }
    }
  }

  return outputData;
}

function applyOutputFormat(pipeline, outputPath, metadata) {
  const extension = path.extname(outputPath).toLowerCase();
  const delay = metadata.delay ?? undefined;
  const loop = metadata.loop ?? 0;

  if (extension === ".gif") {
    return pipeline.gif({
      effort: 7,
      loop,
      delay
    });
  }

  if (extension === ".webp") {
    return pipeline.webp({
      effort: 4,
      loop,
      delay
    });
  }

  if (extension === ".png" || extension === "") {
    return pipeline.png();
  }

  throw new Error("Unsupported output format. Use .png, .webp, or .gif.");
}

async function writeAnimatedGif(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  const gif = GIFEncoder();
  const frameStride = width * frameHeight * 4;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = outputData.subarray(
      frameIndex * frameStride,
      (frameIndex + 1) * frameStride
    );
    const palette = quantize(frame, 256, {
      format: "rgba4444",
      oneBitAlpha: true
    });
    const index = applyPalette(frame, palette, "rgba4444");
    const transparentIndex = palette.findIndex((color) => color[3] === 0);

    gif.writeFrame(index, width, frameHeight, {
      palette,
      delay: metadata.delay?.[frameIndex] ?? 100,
      repeat: frameIndex === 0 ? (metadata.loop ?? 0) : undefined,
      transparent: transparentIndex !== -1,
      transparentIndex: transparentIndex === -1 ? 0 : transparentIndex
    });
  }

  gif.finish();
  await fs.writeFile(outputPath, Buffer.from(gif.bytes()));
}

async function writeAnimatedWebP(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  const frames = [];
  const frameStride = width * frameHeight * 4;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = outputData.subarray(
      frameIndex * frameStride,
      (frameIndex + 1) * frameStride
    );
    const frameWebP = await sharp(frame, {
      raw: {
        width,
        height: frameHeight,
        channels: 4
      }
    })
      .webp({
        lossless: true,
        effort: 4
      })
      .toBuffer();

    frames.push(
      await WebPMux.Image.generateFrame({
        buffer: frameWebP,
        delay: metadata.delay?.[frameIndex] ?? 100
      })
    );
  }

  await WebPMux.Image.save(outputPath, {
    width,
    height: frameHeight,
    loops: metadata.loop ?? 0,
    frames
  });
}

async function writeAnimatedOutput(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  const extension = path.extname(outputPath).toLowerCase();

  if (extension === ".gif") {
    await writeAnimatedGif(outputData, width, frameHeight, frameCount, outputPath, metadata);
    return;
  }

  if (extension === ".webp") {
    await writeAnimatedWebP(outputData, width, frameHeight, frameCount, outputPath, metadata);
    return;
  }

  throw new Error("Animated output currently supports only .webp and .gif.");
}

async function main() {
  const [, , rawInputPath, rawOutputPath, rawTopStrip, rawRadius] = process.argv;

  if (rawInputPath === "--help" || rawInputPath === "-h") {
    printUsage();
    return;
  }

  const { inputPath, outputPath } = await collectPaths(rawInputPath, rawOutputPath);

  await fs.mkdir(INPUT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const source = sharp(inputPath, { animated: true, pages: -1 });
  const metadata = await source.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read image dimensions.");
  }

  const frameCount = metadata.pages ?? 1;
  const frameHeight = metadata.pageHeight ?? metadata.height;

  const manualTopStrip = parseOptionalNumber(rawTopStrip, "top-strip");
  const manualRadius = parseOptionalNumber(rawRadius, "radius");
  const topStrip =
    manualTopStrip ??
    getAutoValue(AUTO_TOP_STRIP_BASE, AUTO_TOP_STRIP_EXPONENT, metadata.width, frameHeight);
  const radius =
    manualRadius ??
    getAutoValue(AUTO_RADIUS_BASE, AUTO_RADIUS_EXPONENT, metadata.width, frameHeight);

  if (metadata.width !== REFERENCE_SIZE || metadata.height !== REFERENCE_SIZE) {
    console.warn(
      `Warning: widget may look odd if the original image size is not ${REFERENCE_SIZE}x${REFERENCE_SIZE}. ` +
        `Detected ${metadata.width}x${frameHeight}.`
    );
  }

  const imageHeight = Math.max(frameHeight - topStrip, 0);
  const clampedRadius = Math.min(radius, metadata.width, imageHeight);
  if (frameCount > 1) {
    const { data: inputData, info } = await source
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const outputData = applyWidgetFixToRawFrames(
      inputData,
      info.width,
      frameHeight,
      frameCount,
      topStrip,
      clampedRadius
    );

    await writeAnimatedOutput(
      outputData,
      info.width,
      frameHeight,
      frameCount,
      outputPath,
      metadata
    );
  } else {
    let pipeline = sharp(inputPath)
      .ensureAlpha()
      .extend({
        top: topStrip,
        bottom: 0,
        left: 0,
        right: 0,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .extract({
        left: 0,
        top: 0,
        width: metadata.width,
        height: frameHeight
      });

    if (clampedRadius > 0) {
      pipeline = pipeline.composite([
        {
          input: await buildCornerCutout(clampedRadius),
          top: topStrip,
          left: metadata.width - clampedRadius,
          blend: "dest-out"
        }
      ]);
    }

    await applyOutputFormat(pipeline, outputPath, metadata).toFile(outputPath);
  }

  console.log(`Created: ${outputPath}`);
  console.log(
    `Used output size ${metadata.width}x${frameHeight}, top strip ${topStrip}px, corner radius ${clampedRadius}px.`
  );
  console.log(
    manualTopStrip == null && manualRadius == null
      ? "Values were auto-calculated from the image size."
      : "Manual values were used for any numbers you passed in."
  );
  if (frameCount > 1) {
    console.log(`Processed ${frameCount} animation frames.`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
