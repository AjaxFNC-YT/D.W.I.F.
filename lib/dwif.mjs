import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import gifenc from "gifenc";
import WebPMux from "node-webpmux";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const { GIFEncoder, applyPalette, quantize } = gifenc;

export const REFERENCE_SIZE = 512;
export const AUTO_TOP_STRIP_BASE = 17;
export const AUTO_RADIUS_BASE = 36;
export const AUTO_TOP_STRIP_EXPONENT =
  Math.log(54 / 17) / Math.log(Math.sqrt(1844 * 853) / REFERENCE_SIZE);
export const AUTO_RADIUS_EXPONENT =
  Math.log(172 / 36) / Math.log(Math.sqrt(1844 * 853) / REFERENCE_SIZE);

const SCRIPT_DIR = path.dirname(fileURLToPath(new URL("../index.mjs", import.meta.url)));

export const INPUT_DIR = path.join(SCRIPT_DIR, "input");
export const OUTPUT_DIR = path.join(SCRIPT_DIR, "output");

const cornerCutoutCache = new Map();

function getEncodingConcurrency(frameCount) {
  const cpuCount = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;

  return Math.max(1, Math.min(frameCount, Math.max(2, cpuCount - 1), 6));
}

export function getDefaultOutputName(inputPath) {
  const parsed = path.parse(inputPath);
  return `${parsed.name}-resized${parsed.ext || ".png"}`;
}

export function resolveInputPath(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  const normalizedInputPath = inputPath.replace(/^[.][\\/]/, "");
  const localScriptPath = path.join(SCRIPT_DIR, normalizedInputPath);

  if (normalizedInputPath.startsWith(`input${path.sep}`) || normalizedInputPath === "input") {
    return localScriptPath;
  }

  if (existsSync(localScriptPath)) {
    return localScriptPath;
  }

  return path.join(INPUT_DIR, normalizedInputPath);
}

export function resolveOutputPath(inputPath, outputName) {
  const finalName = outputName ? path.basename(outputName) : getDefaultOutputName(inputPath);
  return path.join(OUTPUT_DIR, finalName);
}

export function parseOptionalNumber(value, label) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }

  return parsed;
}

export function getAutoValue(baseValue, exponent, width, height) {
  const sizeFactor = Math.sqrt(width * height) / REFERENCE_SIZE;
  return Math.max(0, Math.round(baseValue * Math.pow(sizeFactor, exponent)));
}

function buildCornerCutout(radius) {
  const cached = cornerCutoutCache.get(radius);
  if (cached) {
    return cached;
  }

  const cutoutPromise = sharp({
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

  cornerCutoutCache.set(radius, cutoutPromise);
  return cutoutPromise;
}

function buildCornerClearStarts(radius) {
  const clearStarts = new Int32Array(radius);
  const radiusSquared = radius * radius;

  for (let localY = 0; localY < radius; localY += 1) {
    let clearStart = radius;
    const dy = localY + 0.5 - radius;

    for (let localX = 0; localX < radius; localX += 1) {
      const dx = localX + 0.5;

      if ((dx * dx) + (dy * dy) > radiusSquared) {
        clearStart = localX;
        break;
      }
    }

    clearStarts[localY] = clearStart;
  }

  return clearStarts;
}

function applyWidgetFixToRawFrames(inputData, width, frameHeight, frameCount, topStrip, radius) {
  const outputData = Buffer.alloc(width * frameHeight * frameCount * 4, 0);
  const frameStride = width * frameHeight * 4;
  const rowStride = width * 4;
  const clearStarts = radius > 0 ? buildCornerClearStarts(radius) : null;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameOffset = frameIndex * frameStride;

    for (let y = 0; y < frameHeight; y += 1) {
      const destinationY = y + topStrip;

      if (destinationY >= frameHeight) {
        continue;
      }

      const sourceIndex = frameOffset + y * rowStride;
      const destinationIndex = frameOffset + destinationY * rowStride;
      inputData.copy(outputData, destinationIndex, sourceIndex, sourceIndex + rowStride);
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

      const clearStart = clearStarts[localY];

      if (clearStart >= radius) {
        continue;
      }

      const rowBase = frameOffset + y * rowStride;

      for (let localX = clearStart; localX < radius; localX += 1) {
        const x = cornerStartX + localX;
        const pixelBase = rowBase + x * 4;
        outputData[pixelBase] = 0;
        outputData[pixelBase + 1] = 0;
        outputData[pixelBase + 2] = 0;
        outputData[pixelBase + 3] = 0;
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

function getAnimatedEncodingOptions(metadata) {
  const fastAnimated = metadata.fastAnimated === true;

  return {
    fastAnimated,
    gifColours: fastAnimated ? 192 : 256,
    webpLossless: !fastAnimated,
    webpNearLossless: fastAnimated,
    webpQuality: fastAnimated ? 82 : undefined,
    webpEffort: fastAnimated ? 1 : 2
  };
}

async function writeAnimatedGif(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  let onFrame = null;
  if (typeof metadata.onFrame === "function") {
    onFrame = metadata.onFrame;
  }
  const options = getAnimatedEncodingOptions(metadata);
  const gif = GIFEncoder();
  const frameStride = width * frameHeight * 4;
  const palette = quantize(outputData, options.gifColours, {
    format: "rgba4444",
    oneBitAlpha: true
  });
  const transparentIndex = palette.findIndex((color) => color[3] === 0);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = Uint8Array.from(
      outputData.subarray(frameIndex * frameStride, (frameIndex + 1) * frameStride)
    );
    const index = applyPalette(frame, palette, "rgba4444");

    gif.writeFrame(index, width, frameHeight, {
      palette: frameIndex === 0 ? palette : undefined,
      delay: metadata.delay?.[frameIndex] ?? 100,
      repeat: frameIndex === 0 ? (metadata.loop ?? 0) : undefined,
      transparent: transparentIndex !== -1,
      transparentIndex: transparentIndex === -1 ? 0 : transparentIndex,
      dispose: 2
    });

    onFrame?.(frameIndex + 1, frameCount, "encoding");
  }

  gif.finish();
  await fs.writeFile(outputPath, Buffer.from(gif.bytes()));
}

async function writeAnimatedWebP(outputData, width, frameHeight, frameCount, outputPath, metadata) {
  let onFrame = null;
  if (typeof metadata.onFrame === "function") {
    onFrame = metadata.onFrame;
  }
  const options = getAnimatedEncodingOptions(metadata);
  const frameStride = width * frameHeight * 4;
  const frames = new Array(frameCount);
  const concurrency = getEncodingConcurrency(frameCount);
  let nextFrameIndex = 0;
  let encodedFrames = 0;

  async function encodeFrame(frameIndex) {
    const frame = outputData.subarray(frameIndex * frameStride, (frameIndex + 1) * frameStride);
    const frameWebP = await sharp(frame, {
      raw: {
        width,
        height: frameHeight,
        channels: 4
      }
    })
      .webp({
        lossless: options.webpLossless,
        nearLossless: options.webpNearLossless,
        quality: options.webpQuality,
        effort: options.webpEffort
      })
      .toBuffer();

    frames[frameIndex] = await WebPMux.Image.generateFrame({
      buffer: frameWebP,
      delay: metadata.delay?.[frameIndex] ?? 100
    });

    encodedFrames += 1;
    onFrame?.(encodedFrames, frameCount, "encoding");
  }

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextFrameIndex < frameCount) {
        const frameIndex = nextFrameIndex;
        nextFrameIndex += 1;
        await encodeFrame(frameIndex);
      }
    })
  );

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

export async function processImage({
  inputPath,
  outputPath,
  manualTopStrip = null,
  manualRadius = null,
  fastAnimated = true,
  onProgress = null
}) {
  await fs.mkdir(INPUT_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const source = sharp(inputPath, { animated: true, pages: -1 });
  const metadata = await source.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Could not read image dimensions.");
  }

  const frameCount = metadata.pages ?? 1;
  const frameHeight = metadata.pageHeight ?? metadata.height;

  const topStrip =
    manualTopStrip ??
    getAutoValue(AUTO_TOP_STRIP_BASE, AUTO_TOP_STRIP_EXPONENT, metadata.width, frameHeight);
  const radius =
    manualRadius ??
    getAutoValue(AUTO_RADIUS_BASE, AUTO_RADIUS_EXPONENT, metadata.width, frameHeight);

  const imageHeight = Math.max(frameHeight - topStrip, 0);
  const clampedRadius = Math.min(radius, metadata.width, imageHeight);
  const reportProgress =
    typeof onProgress === "function"
      ? (current, total, stage) =>
          onProgress({
            current,
            total,
            stage,
            percent: total > 0 ? Math.round((current / total) * 100) : 0
          })
      : null;

  if (frameCount > 1) {
    const { data: inputData, info } = await source.ensureAlpha().raw().toBuffer({
      resolveWithObject: true
    });
    reportProgress?.(0, frameCount, "preparing");
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
      {
        ...metadata,
        fastAnimated,
        onFrame: reportProgress
      }
    );
    reportProgress?.(frameCount, frameCount, "finishing");
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

  return {
    outputPath,
    width: metadata.width,
    height: frameHeight,
    topStrip,
    radius: clampedRadius,
    autoCalculated: manualTopStrip == null && manualRadius == null,
    frameCount,
    animated: frameCount > 1,
    warning:
      metadata.width !== REFERENCE_SIZE || metadata.height !== REFERENCE_SIZE
        ? `Widget may look odd if the original image size is not ${REFERENCE_SIZE}x${REFERENCE_SIZE}. Detected ${metadata.width}x${frameHeight}.`
        : null
  };
}
