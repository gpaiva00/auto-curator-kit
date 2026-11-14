/**
 * Renders sample outputs into packages/media/out/ (gitignored).
 * Run: bun run packages/media/src/demo.ts
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDraft, makeImage, makeItem, makeLogo, makeProfile, makeVideo } from "../test/fixtures/make.js";
import { createPreparer } from "./factory.js";
import { ffmpegAvailable } from "./render/ffmpeg.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "out");

async function main() {
  const assets = path.join(out, "assets");
  await mkdir(assets, { recursive: true });
  const photo1 = await makeImage(path.join(assets, "photo1.jpg"), 1600, 1200, "#ff6a3d");
  const photo2 = await makeImage(path.join(assets, "photo2.jpg"), 900, 1400, "#1fb6ff");
  await makeLogo(path.join(assets, "logo.png"));
  const hasFfmpeg = await ffmpegAvailable();
  const video = hasFfmpeg ? await makeVideo(path.join(assets, "video.mp4")) : undefined;

  const logger = { debug() {}, info: console.log, warn: console.warn, error: console.error };
  const profile = makeProfile({
    destinations: [{ platform: "instagram" }, { platform: "tiktok" }],
    brand: { name: "Perfil Demo", handle: "@perfildemo", logo: "out/assets/logo.png", colors: { primary: "#4A22E8", accent: "#FF5A6E", background: "#FFFFFF", text: "#111111" } },
  });
  const preparer = createPreparer(profile, { logger });
  const cases: [string, ReturnType<typeof makeItem>][] = [
    ["single", makeItem({ id: "demo-single", media: [{ type: "image", localPath: photo1 }] })],
    ["collage", makeItem({ id: "demo-collage", media: [{ type: "image", localPath: photo1 }, { type: "image", localPath: photo2 }] })],
    ["text-only", makeItem({ id: "demo-text" })],
    ...(video ? [["video", makeItem({ id: "demo-video", media: [{ type: "video", localPath: video }] })] as [string, ReturnType<typeof makeItem>]] : []),
  ];
  for (const [name, item] of cases) {
    const prepared = await preparer.prepare(item, makeDraft(), { profile, profileDir: root, outDir: path.join(out, name), logger });
    console.log(name, prepared.map((p) => `${path.relative(root, p.localPath)} ${p.width}x${p.height}${p.platform ? ` [${p.platform}]` : ""}`).join(", "));
  }
  if (!hasFfmpeg) console.log("ffmpeg ausente: demo de video ignorado");
}

main().catch((e) => { console.error(e); process.exit(1); });
