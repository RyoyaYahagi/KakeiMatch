import { deflateSync, inflateSync } from 'node:zlib';

// Minimal PNG support for the visual regression report. Xcode and Playwright
// both save 8-bit RGB/RGBA PNGs without interlacing, so that is the supported
// input. Keeping this in-repo avoids adding an image dependency to CI.

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function channelsForColorType(colorType) {
  switch (colorType) {
    case 0: return 1;
    case 2: return 3;
    case 4: return 2;
    case 6: return 4;
    default: throw new Error(`Unsupported PNG color type: ${colorType}`);
  }
}

/** Decode an 8-bit, non-interlaced PNG into { width, height, data } RGBA bytes. */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SIGNATURE.length || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  let offset = 8;
  let header;
  const idat = [];
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('Truncated PNG chunk');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new Error(`Truncated PNG chunk ${type}`);
    const data = buffer.subarray(start, end);
    const expectedCrc = buffer.readUInt32BE(end);
    if (crc32(buffer.subarray(offset + 4, end)) !== expectedCrc) throw new Error(`Bad PNG CRC in ${type}`);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (!header) throw new Error('PNG has no IHDR');
  if (header.bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${header.bitDepth}`);
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error('Unsupported PNG compression, filter, or interlace method');
  }
  const channels = channelsForColorType(header.colorType);
  const rowLength = header.width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (rowLength + 1) * header.height) {
    throw new Error(`Unexpected PNG data length: ${raw.length}`);
  }
  const pixels = Buffer.alloc(rowLength * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (rowLength + 1)];
    const source = y * (rowLength + 1) + 1;
    const target = y * rowLength;
    const previous = target - rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const value = raw[source + x];
      const left = x >= channels ? pixels[target + x - channels] : 0;
      const up = y > 0 ? pixels[previous + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[previous + x - channels] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: throw new Error(`Unsupported PNG filter: ${filter}`);
      }
      pixels[target + x] = restored & 0xff;
    }
  }
  const data = Buffer.alloc(header.width * header.height * 4);
  for (let index = 0; index < header.width * header.height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (channels === 1) {
      data[target] = pixels[source];
      data[target + 1] = pixels[source];
      data[target + 2] = pixels[source];
      data[target + 3] = 255;
    } else if (channels === 2) {
      data[target] = pixels[source];
      data[target + 1] = pixels[source];
      data[target + 2] = pixels[source];
      data[target + 3] = pixels[source + 1];
    } else if (channels === 3) {
      data[target] = pixels[source];
      data[target + 1] = pixels[source + 1];
      data[target + 2] = pixels[source + 2];
      data[target + 3] = 255;
    } else {
      data[target] = pixels[source];
      data[target + 1] = pixels[source + 1];
      data[target + 2] = pixels[source + 2];
      data[target + 3] = pixels[source + 3];
    }
  }
  return { width: header.width, height: header.height, data };
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const output = Buffer.alloc(typeAndData.length + 8);
  output.writeUInt32BE(data.length, 0);
  typeAndData.copy(output, 4);
  output.writeUInt32BE(crc32(typeAndData), output.length - 4);
  return output;
}

/** Encode RGBA bytes as an 8-bit PNG. */
export function encodePng({ width, height, data }) {
  if (data.length !== width * height * 4) throw new Error('RGBA data length does not match dimensions');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fill(data, color) {
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color[0];
    data[index + 1] = color[1];
    data[index + 2] = color[2];
    data[index + 3] = 255;
  }
}

function blit(target, targetWidth, targetHeight, source, x, y) {
  for (let row = 0; row < source.height && y + row < targetHeight; row += 1) {
    const sourceStart = row * source.width * 4;
    const targetStart = ((y + row) * targetWidth + x) * 4;
    source.data.copy(target, targetStart, sourceStart, sourceStart + Math.min(source.width, targetWidth - x) * 4);
  }
}

/** Scale to the requested width with a box filter, preserving aspect ratio. */
export function resizeToWidth(image, width) {
  if (width === image.width) return image;
  if (width <= 0) throw new Error('Target width must be positive');
  const scaleX = image.width / width;
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const scaleY = image.height / height;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = y * scaleY;
    const y1 = Math.min(image.height, (y + 1) * scaleY);
    const firstY = Math.floor(y0);
    const lastY = Math.ceil(y1);
    for (let x = 0; x < width; x += 1) {
      const x0 = x * scaleX;
      const x1 = Math.min(image.width, (x + 1) * scaleX);
      const firstX = Math.floor(x0);
      const lastX = Math.ceil(x1);
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let weight = 0;
      for (let sourceY = firstY; sourceY < lastY; sourceY += 1) {
        const weightY = Math.max(0, Math.min(y1, sourceY + 1) - Math.max(y0, sourceY));
        if (weightY === 0) continue;
        for (let sourceX = firstX; sourceX < lastX; sourceX += 1) {
          const weightX = Math.max(0, Math.min(x1, sourceX + 1) - Math.max(x0, sourceX));
          if (weightX === 0) continue;
          const current = (sourceY * image.width + sourceX) * 4;
          const amount = weightX * weightY;
          red += image.data[current] * amount;
          green += image.data[current + 1] * amount;
          blue += image.data[current + 2] * amount;
          alpha += image.data[current + 3] * amount;
          weight += amount;
        }
      }
      const target = (y * width + x) * 4;
      data[target] = Math.round(red / weight);
      data[target + 1] = Math.round(green / weight);
      data[target + 2] = Math.round(blue / weight);
      data[target + 3] = Math.round(alpha / weight);
    }
  }
  return { width, height, data };
}

/** Place PWA and iOS captures side by side (PWA left, iOS right). */
export function composeSideBySide(left, right, { gap = 12, background = [24, 24, 27] } = {}) {
  const height = Math.max(left.height, right.height);
  const width = left.width + gap + right.width;
  const data = Buffer.alloc(width * height * 4);
  fill(data, background);
  blit(data, width, height, left, 0, 0);
  blit(data, width, height, right, left.width + gap, 0);
  return { width, height, data };
}

/**
 * Highlight changed pixels in red over a washed-out PWA image. This is a
 * review aid, not a pass/fail comparison: fonts, OS chrome, and Liquid Glass
 * differ by design. Areas outside the overlap are amber and counted as changed.
 */
export function buildDiff(reference, candidate, { threshold = 12 } = {}) {
  const width = reference.width;
  const height = Math.max(reference.height, candidate.height);
  const data = Buffer.alloc(width * height * 4);
  fill(data, [245, 245, 245]);
  let changed = 0;
  const overlapHeight = Math.min(reference.height, candidate.height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      if (x >= candidate.width || y >= overlapHeight) {
        data[target] = 236;
        data[target + 1] = 170;
        data[target + 2] = 60;
        changed += 1;
        continue;
      }
      const a = (y * reference.width + x) * 4;
      const b = (y * candidate.width + x) * 4;
      const delta = Math.max(
        Math.abs(reference.data[a] - candidate.data[b]),
        Math.abs(reference.data[a + 1] - candidate.data[b + 1]),
        Math.abs(reference.data[a + 2] - candidate.data[b + 2]),
      );
      if (delta > threshold) {
        data[target] = 214;
        data[target + 1] = 47;
        data[target + 2] = 58;
        changed += 1;
      } else {
        const luminance = (reference.data[a] * 299 + reference.data[a + 1] * 587 + reference.data[a + 2] * 114) / 1000;
        const washed = Math.round(238 - (255 - luminance) * 0.45);
        data[target] = washed;
        data[target + 1] = washed;
        data[target + 2] = washed;
      }
    }
  }
  return { image: { width, height, data }, changed, comparedPixels: width * height };
}
