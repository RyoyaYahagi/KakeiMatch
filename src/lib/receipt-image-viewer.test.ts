import { describe, expect, it } from "vitest";
import { zoomScroll } from "../../apps/pwa/src/receipt-image-viewer";

describe("receipt image zoom", () => {
  it("brings the tapped point to the middle of the screen after zooming", () => {
    expect(zoomScroll({ x: 200, y: 600 }, 2.5, { width: 400, height: 700 })).toEqual({ left: 300, top: 1150 });
  });
  it("never scrolls before the photo's top-left corner", () => {
    expect(zoomScroll({ x: 10, y: 20 }, 2.5, { width: 400, height: 700 })).toEqual({ left: 0, top: 0 });
  });
});
