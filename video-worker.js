let running = false;
let reader = null;
let writer = null;

let frames = 0;
let lastTime = performance.now();

async function processVideo(track, width, height) {
  running = true;

  const processor = new MediaStreamTrackProcessor({
    track
  });

  const generator = new VideoTrackGenerator();

  reader = processor.readable.getReader();
  writer = generator.writable.getWriter();

  const canvas = new OffscreenCanvas(width, height);

  const ctx = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true
  });

  if (!ctx) {
    throw new Error("OffscreenCanvas unavailable");
  }

  self.postMessage({
    type: "ready",
    track: generator.track
  }, [generator.track]);

  try {
    while (running) {
      const { value: frame, done } = await reader.read();

      if (done) break;

      try {
        const sw = frame.displayWidth;
        const sh = frame.displayHeight;

        const scale = Math.min(
          width / sw,
          height / sh
        );

        const w = sw * scale;
        const h = sh * scale;

        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, width, height);

        ctx.drawImage(
          frame,
          (width - w) / 2,
          (height - h) / 2,
          w,
          h
        );

        const output = new VideoFrame(canvas, {
          timestamp: frame.timestamp
        });

        try {
          await writer.write(output);
        } finally {
          output.close();
        }

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

      } finally {
        frame.close();
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}

    try {
      await writer.close();
    } catch {}

    reader.releaseLock();
    writer.releaseLock();

    track.stop();
    running = false;
  }
}

self.onmessage = async event => {
  const msg = event.data;

  if (msg.type === "start") {
    try {
      if (
        typeof MediaStreamTrackProcessor === "undefined" ||
        typeof VideoTrackGenerator === "undefined"
      ) {
        throw new Error(
          "Worker映像APIに対応していません"
        );
      }

      await processVideo(
        msg.track,
        msg.width,
        msg.height
      );

    } catch (error) {
      self.postMessage({
        type: "error",
        message: error.message
      });
    }
  }

  if (msg.type === "stop") {
    running = false;

    try {
      await reader?.cancel();
    } catch {}
  }
};
