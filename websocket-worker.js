"use strict";

let running = false;

let reader = null;
let canvas = null;
let context = null;

let settings = {
  fps: 15,
  resolution: "720",
  jpegQuality: 0.8
};

let lastFrameTime = 0;
let busy = false;

let processedFrames = 0;
let skippedFrames = 0;

function targetSize(width, height) {
  if (settings.resolution === "native") {
    return {
      width,
      height
    };
  }

  const targetHeight = Number(settings.resolution);

  const targetWidth = Math.round(
    targetHeight * 16 / 9
  );

  const scale = Math.min(
    1,
    targetWidth / width,
    targetHeight / height
  );

  return {
    width: Math.max(
      1,
      Math.round(width * scale)
    ),

    height: Math.max(
      1,
      Math.round(height * scale)
    )
  };
}

async function processFrame(frame) {
  if (!running || busy) {
    skippedFrames++;
    frame.close();
    return;
  }

  const now = performance.now();

  const interval = 1000 / settings.fps;

  if (now - lastFrameTime < interval) {
    skippedFrames++;
    frame.close();
    return;
  }

  lastFrameTime = now;
  busy = true;

  try {
    const width =
      frame.displayWidth || frame.codedWidth;

    const height =
      frame.displayHeight || frame.codedHeight;

    const size = targetSize(width, height);

    if (!canvas) {
      canvas = new OffscreenCanvas(
        size.width,
        size.height
      );

      context = canvas.getContext("2d", {
        alpha: false
      });
    }

    if (
      canvas.width !== size.width ||
      canvas.height !== size.height
    ) {
      canvas.width = size.width;
      canvas.height = size.height;
    }

    context.drawImage(
      frame,
      0,
      0,
      size.width,
      size.height
    );

    frame.close();

    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: settings.jpegQuality
    });

    if (!running) return;

    if (blob.size > 1024 * 1024) {
      skippedFrames++;
      return;
    }

    const buffer = await blob.arrayBuffer();

    if (!running) return;

    processedFrames++;

    self.postMessage({
      type: "frame",
      buffer,
      width: size.width,
      height: size.height,
      processedFrames,
      skippedFrames
    }, [buffer]);

  } catch (error) {
    skippedFrames++;

    try {
      frame.close();
    } catch {}

    self.postMessage({
      type: "warning",
      message: error.message
    });

  } finally {
    busy = false;
  }
}

async function start(track) {
  running = true;

  try {
    const processor = new MediaStreamTrackProcessor({
      track
    });

    reader = processor.readable.getReader();

    self.postMessage({
      type: "ready"
    });

    while (running) {
      const result = await reader.read();

      if (result.done) break;

      const frame = result.value;

      await processFrame(frame);
    }

  } catch (error) {
    if (running) {
      self.postMessage({
        type: "error",
        message: error.message
      });
    }

  } finally {
    running = false;

    try {
      reader?.releaseLock();
    } catch {}

    reader = null;
  }
}

self.onmessage = event => {
  const data = event.data;

  if (data.type === "start") {
    settings = data.settings;

    start(data.track);
  }

  if (data.type === "settings") {
    settings = data.settings;
  }

  if (data.type === "stop") {
    running = false;

    reader?.cancel().catch(() => {});
  }
};
