// tests/KnoxWindowFit.test.ts
// Bridge 0.3.2 (plan backlog "Bridge window fits its content"): the window is as tall as its page, within the minimum
// and the screen, and stays on the screen when it grows.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MIN_CONTENT_HEIGHT, fittedContentHeight, keptOnScreen } from "../src/desktop/WindowFit.js";

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

test("the content height follows the page between the minimum and the screen", () => {
  assert.equal(fittedContentHeight(300.4, SCREEN, 31), 301, "rounded up, so nothing scrolls");
  assert.equal(fittedContentHeight(120, SCREEN, 31), MIN_CONTENT_HEIGHT);
  assert.equal(fittedContentHeight(5000, SCREEN, 31), 1040 - 31, "a long page scrolls instead");
  assert.equal(fittedContentHeight(Number.NaN, SCREEN, 31), MIN_CONTENT_HEIGHT);
  assert.equal(fittedContentHeight(400, { ...SCREEN, height: 200 }, 31), MIN_CONTENT_HEIGHT, "a tiny screen still gets the minimum");
});

test("a window that grew past the bottom moves up, never above the top", () => {
  assert.deepEqual(keptOnScreen({ x: 100, y: 200, width: 640, height: 500 }, SCREEN), { x: 100, y: 200 });
  assert.deepEqual(keptOnScreen({ x: 100, y: 800, width: 640, height: 500 }, SCREEN), { x: 100, y: 540 });
  assert.deepEqual(keptOnScreen({ x: 100, y: 800, width: 640, height: 1200 }, { ...SCREEN, y: 40 }), { x: 100, y: 40 });
});

test("the page asks for its height and main stops after a resize by hand", async () => {
  const renderer = await readFile(path.resolve("desktop", "renderer", "renderer.js"), "utf8");
  assert.match(renderer, /new ResizeObserver\(requestFit\)/);
  assert.match(renderer, /api\.fitHeight\(/);
  const main = await readFile(path.resolve("src", "desktop", "main.ts"), "utf8");
  assert.match(main, /ipcMain\.handle\("window:fit"/);
  assert.match(main, /on\("will-resize", \(\) => \{ resizedByHand = true; \}\)/);
  assert.match(main, /useContentSize: true/);
});
