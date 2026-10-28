"use strict";

let canvas = null;
let context = null;

let settings = {
  resolution: "720",
  jpegQuality: 0.8
};

let busy = false;

function calculateSize(width, height) {
  if (settings.resolution === "native") {
    return {
      width,
      height
    };
  }

  const targetHeight = Number(
    settings.resolution
  );

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

async function encodeFrame(frame) {
  if (busy) {
    frame.close();

    self.postMessage({
      type: "skipped"
    });

    return;
  }

  busy = true;

  try {
    const width =
      frame.displayWidth ||
      frame.codedWidth;

    const height =
      frame.displayHeight ||
      frame.codedHeight;

    const size = calculateSize(
      width,
      height
    );

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

    if (blob.size > 1024 * 1024) {
      self.postMessage({
        type: "skipped"
      });

      return;
    }

    const buffer = await blob.arrayBuffer();

    self.postMessage({
      type: "frame",
      buffer,
      width: size.width,
      height: size.height
    }, [buffer]);

  } catch (error) {
    try {
      frame.close();
    } catch {}

    self.postMessage({
      type: "error",
      message: error.message
    });

  } finally {
    busy = false;
  }
}

self.onmessage = event => {
  const data = event.data;

  if (data.type === "settings") {
    settings = data.settings;

    return;
  }

  if (data.type === "frame") {
    encodeFrame(data.frame);
  }
};

self.postMessage({
  type: "ready"
});
