// ============================================================
// WebRTC Caster v12
// VideoFrame Processing Worker
// ============================================================

let canvas = null;
let ctx = null;

let outputWidth = 1280;
let outputHeight = 720;

let frames = 0;
let lastTime = performance.now();

let initialized = false;


// ============================================================
// INIT
// ============================================================

function initialize(width, height) {

  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas is unavailable");
  }

  if (typeof VideoFrame === "undefined") {
    throw new Error("VideoFrame is unavailable");
  }

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 7680 ||
    height > 4320
  ) {
    throw new Error("Invalid canvas size");
  }

  outputWidth = width;
  outputHeight = height;

  canvas = new OffscreenCanvas(
    outputWidth,
    outputHeight
  );

  ctx = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true
  });

  if (!ctx) {
    throw new Error("Cannot create Canvas2D context");
  }

  initialized = true;

  self.postMessage({
    type: "ready",
    width: outputWidth,
    height: outputHeight
  });
}


// ============================================================
// PROCESS FRAME
// ============================================================

function processFrame(frame) {

  if (!initialized || !ctx) {
    frame.close();

    self.postMessage({
      type: "frame-done",
      dropped: true
    });

    return;
  }

  let output = null;

  try {

    const sw = frame.displayWidth;
    const sh = frame.displayHeight;

    if (!sw || !sh) {
      throw new Error("Invalid frame dimensions");
    }

    // 縦横比を維持
    const scale = Math.min(
      outputWidth / sw,
      outputHeight / sh
    );

    const width = sw * scale;
    const height = sh * scale;

    const x = (outputWidth - width) / 2;
    const y = (outputHeight - height) / 2;

    // 黒背景
    ctx.fillStyle = "#000000";

    ctx.fillRect(
      0,
      0,
      outputWidth,
      outputHeight
    );

    // 元映像を描画
    ctx.drawImage(
      frame,
      x,
      y,
      width,
      height
    );

    // 加工済みVideoFrameを生成
    output = new VideoFrame(canvas, {
      timestamp: frame.timestamp
    });

    // 所有権をメインスレッドへ移動
    self.postMessage(
      {
        type: "frame",
        frame: output
      },
      [output]
    );

    output = null;

    frames++;

    const now = performance.now();

    if (now - lastTime >= 1000) {

      self.postMessage({
        type: "stats",
        fps: frames
      });

      frames = 0;
      lastTime = now;
    }

  } catch (error) {

    self.postMessage({
      type: "frame-error",
      message: error.message
    });

    self.postMessage({
      type: "frame-done",
      dropped: true
    });

  } finally {

    frame.close();

    if (output) {
      output.close();
    }

  }
}


// ============================================================
// MESSAGE
// ============================================================

self.onmessage = event => {

  const msg = event.data;

  if (msg.type === "init") {

    try {

      initialize(
        msg.width,
        msg.height
      );

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

    self.postMessage({
      type: "stopped"
    });

  }

};
