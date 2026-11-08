import fs from 'node:fs';
import path from 'node:path';

export function captureFile(directory, name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.png$/i.test(name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name)) throw new Error('Invalid screenshot PNG leaf name.');
  const file = path.resolve(directory, name);
  let candidate = file;
  while (true) {
    let stat;
    try { stat = fs.lstatSync(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) {
      throw new Error('Screenshot path escapes its evidence directory through a reparse point.');
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (fs.existsSync(file) && fs.realpathSync.native(file).toLowerCase() !==
      path.join(fs.realpathSync.native(directory), name).toLowerCase()) {
    throw new Error('Screenshot path escapes its evidence directory through a reparse point.');
  }
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) throw new Error('Screenshot is not a regular PNG file.');
  return file;
}

/** Map preview pixels, rejecting points outside the specific captured image. */
export function mapCapturePoint(shot, x, y) {
  if (!shot?.captureId || ![shot.left, shot.top, shot.width, shot.height, shot.previewWidth, shot.previewHeight].every(Number.isFinite) ||
      shot.width <= 0 || shot.height <= 0 || shot.previewWidth <= 0 || shot.previewHeight <= 0) {
    throw new Error('Unknown captureId or incomplete capture metadata. Take a screenshot first, or use screen coordinates.');
  }
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= shot.previewWidth || y >= shot.previewHeight) {
    throw new Error(`Point is outside capture ${shot.captureId} (${shot.previewWidth}x${shot.previewHeight}).`);
  }
  return {
    x: Math.min(shot.left + shot.width - 1, Math.round(shot.left + x * shot.width / shot.previewWidth)),
    y: Math.min(shot.top + shot.height - 1, Math.round(shot.top + y * shot.height / shot.previewHeight)),
  };
}
