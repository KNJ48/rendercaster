"use strict";

let canvas = null;
let ctx = null;

let width = 1280;
let height = 720;

let initialized = false;

let frameCount = 0;
let lastTime = performance.now();

function init(w, h) {

  if (
    typeof OffscreenCanvas === "undefined" ||
    typeof VideoFrame === "undefined"
  ) {
    throw new Error("必要なWorker映像APIがありません");
  }

  width = w;
  height = h;

  canvas = new OffscreenCanvas(width, height);

  ctx = canvas.getContext("2d", {
    alpha: false
  });

  if (!ctx) {
    throw new Error("Canvas初期化失敗");
  }

  initialized = true;

  self.postMessage({
    type: "ready"
  });
}

function processFrame(frame) {

  let output = null;

  try {

    if (!initialized) {
      throw new Error("Worker未初期化");
    }

    const sw = frame.displayWidth;
    const sh = frame.displayHeight;

    const scale = Math.min(
      width / sw,
      height / sh
    );

    const dw = sw * scale;
    const dh = sh * scale;

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);

    ctx.drawImage(
      frame,
      (width - dw) / 2,
      (height - dh) / 2,
      dw,
      dh
    );

    output = new VideoFrame(canvas, {
      timestamp: frame.timestamp
    });

    self.postMessage({
      type: "frame",
      frame: output
    }, [output]);

    output = null;

    frameCount++;

    const now = performance.now();

    if (now - lastTime >= 1000) {
      self.postMessage({
        type: "stats",
        fps: frameCount
      });

      frameCount = 0;
      lastTime = now;
    }

  } catch (error) {

    self.postMessage({
      type: "frame-error",
      message: error.message
    });

  } finally {

    frame.close();

    if (output) {
      output.close();
    }
  }
}

self.onmessage = event => {

  const msg = event.data;

  if (msg.type === "init") {
    try {
      init(msg.width, msg.height);
    } catch (error) {
      self.postMessage({
        type: "error",
        message: error.message
      });
    }
    return;
  }

  if (msg.type === "frame") {
    processFrame(msg.frame);
    return;
  }

  if (msg.type === "stop") {
    initialized = false;
    canvas = null;
    ctx = null;
  }
};
