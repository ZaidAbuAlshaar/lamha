// Copies MediaPipe WASM from node_modules and fetches the face-landmarker model into public/ (runs on postinstall).
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';

const wasmSrc = 'node_modules/@mediapipe/tasks-vision/wasm';
// (fs.cpSync crashes silently on Windows paths with non-ASCII characters, so copy file by file.)
if (existsSync(wasmSrc)) {
  mkdirSync('public/mediapipe/wasm', { recursive: true });
  for (const f of readdirSync(wasmSrc)) copyFileSync(`${wasmSrc}/${f}`, `public/mediapipe/wasm/${f}`);
}
const model = 'public/models/face_landmarker.task';
if (!existsSync(model)) {
  mkdirSync('public/models', { recursive: true });
  const url = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(model, Buffer.from(await res.arrayBuffer()));
}
console.log('assets ready');
