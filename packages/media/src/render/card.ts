import type { ResolvedBrand } from "./brand.js";
import { loadFonts } from "./fonts.js";
import {
  coverDataUri, fitHeadline, h, img, logoNode, markDataUri, svgToPng, toSvg, truncateChars, type Node,
} from "./engine.js";
import { MAX_CROP_LOSS, cropLoss } from "./fit.js";
import { parseHex, readableOn, sanitizeText } from "./text.js";

export const CARD_W = 1080;
export const CARD_H = 1350;
export const CARD_TALL_H = 1920;
/** Square 1:1 card (layout "f" only): pass `height: CARD_SQUARE_H`. */
export const CARD_SQUARE_H = 1080;
const CENTER_LOGO = 170;
/**
 * Per-platform design of the tall (9:16) card. Reels and TikTok have different UI: TikTok's search bar sits on top and its
 * caption/name block is bigger and white, so the TikTok variant gets a top margin and a painted bottom band.
 */
export type CardVariant = "instagram" | "tiktok";
/** Reels: bottom strip kept free (caption, buttons). Left as it was: no complaints on Reels. */
export const REELS_SAFE_BOTTOM = 200;
/** TikTok: top strip kept free for the search bar. */
export const TIKTOK_SAFE_TOP = 160;
/** TikTok: bottom strip kept free for the account name and caption; painted with the brand's primary color (gradient). */
export const TIKTOK_SAFE_BOTTOM = 420;
const PAD = 44;
const HEADER_H = 84;
const TAG_H = 48;
const FOOTER_H = 60;
const MIN_PHOTO_H = 420;
const GAP = 12; // innerW 992 - 12 = 980 -> two even 490px panels (ffmpeg needs even sizes)
const BADGE = 124;

export interface CardInput {
  brand: ResolvedBrand;
  headline: string;
  categoryTag: string;
  sourceCredit: string;
  /** Local image files, 1 or 2 (extra ones are ignored). Unused (may be empty) in "video" mode. */
  images: string[];
  /**
   * "video": the photo area is left empty (flat color) so the video can be composited into `layout.photoRect`.
   * `videoSize` (the source's real size) lets the headline shrink, giving the video a taller panel, when that
   * avoids blurred bars / cropping.
   */
  mode?: "images" | "video";
  videoSize?: { width?: number; height?: number };
  /** Margins of the 9:16 card, per platform. Ignored in 4:5. */
  variant?: CardVariant;
  /** Canvas height: CARD_H (4:5, default) or CARD_TALL_H (9:16). */
  height?: number;
  /**
   * "f": approved image layout for 4:5 (white block on top: logo at left and tag at top right on one row, the headline full width
   * below; the photo fills the rest, edge to edge). Default "classic" is the header/footer card used by the video card.
   */
  design?: "classic" | "f";
  /** Layout "f", two photos only: round brand logo (8px white border) on the seam between the photos. Default false (no logo anywhere). */
  centerLogo?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardLayout {
  headlineLines: number;
  headlineFontSize: number;
  headlineHeight: number;
  headlineTruncated: boolean;
  photoHeight: number;
  /** Photo area (all panels). */
  photoRect: Rect;
}

export async function renderCard(input: CardInput): Promise<{ png: Buffer; layout: CardLayout }> {
  const { brand } = input;
  const { name: fontName, fonts } = loadFonts(brand.fontFamily);
  const c = brand.colors;
  const innerW = CARD_W - PAD * 2;
  const canvasH = input.height ?? CARD_H;
  const tall = canvasH > CARD_H;
  const tiktok = tall && input.variant === "tiktok";
  const safeTop = tiktok ? TIKTOK_SAFE_TOP : 0;
  const safeBottom = tiktok ? TIKTOK_SAFE_BOTTOM : tall ? REELS_SAFE_BOTTOM : 0;

  const headline = sanitizeText(input.headline) || " ";
  const tag = truncateChars(sanitizeText(input.categoryTag).toUpperCase(), input.design === "f" && !tall ? 44 : 24);
  const credit = truncateChars(sanitizeText(input.sourceCredit), 140);
  const name = truncateChars(sanitizeText(brand.name), 28);
  const handle = truncateChars(sanitizeText(brand.handle), 30);

  /** No photo available: a flat brand-colored panel with the logo (or monogram) and the brand name. */
  const brandPanel = async (w: number, hh: number, left: number, top: number): Promise<Node> => {
    const onP = readableOn(c.primary);
    const mark = await markDataUri(brand.logoPath, 320);
    const size = Math.min(160, Math.floor(hh / 3));
    const logoNode_: Node = mark
      ? img(mark, size, size, { borderRadius: size / 2 })
      : h("div", {
          width: size, height: size, borderRadius: size / 2, backgroundColor: c.accent, color: readableOn(c.accent),
          alignItems: "center", justifyContent: "center", fontFamily: fontName, fontWeight: 800, fontSize: Math.round(size * 0.5),
        }, (name[0] ?? "A").toUpperCase());
    return h("div", {
      position: "absolute", left, top, width: w, height: hh, backgroundColor: c.primary, color: onP, flexDirection: "column",
      alignItems: "center", justifyContent: "center",
    }, [
      logoNode_,
      h("div", { marginTop: 20, fontSize: 40, fontWeight: 800, letterSpacing: -0.5 }, name),
      ...(handle ? [h("div", { marginTop: 6, fontSize: 26, fontWeight: 400, opacity: 0.7 }, handle)] : []),
    ]);
  };

  if (input.design === "f" && !tall) {
    // Layout F (design A/D): white block on top = HOOK (accent) + headline, both medium weight; photo fills the rest edge to edge.
    // No logo / name / tag pill; the credit is a small pill over the photo; optional round logo on the seam of two photos.
    const square = canvasH === CARD_SQUARE_H;
    const FPAD = square ? 52 : 64, FTOP = square ? 52 : 64, FBOT = 48, TEXT_GAP = 16;
    const textW = CARD_W - FPAD * 2;
    // fitHeadline types `weight` as 700|800; 500 is loaded in fonts.ts and valid at runtime
    const fit = await fitHeadline(headline, {
      width: textW, sizes: square ? [52, 48, 44, 40, 36] : [60, 56, 52, 48, 44], maxLines: 4, lineHeight: 1.14, letterSpacing: -1.2,
      weight: 500, fonts, fontName,
    });
    const hookFit = tag
      ? await fitHeadline(tag, {
          width: textW, sizes: square ? [62, 56, 50, 46, 42] : [70, 64, 58, 52, 46], maxLines: 2, lineHeight: 1.08, letterSpacing: -1,
          weight: 500, fonts, fontName,
        })
      : null;
    const blockH = FTOP + (hookFit ? hookFit.height + TEXT_GAP : 0) + fit.height + FBOT;
    const fPhotoH = canvasH - blockH;

    const hookNode = hookFit
      ? h("div", {
          width: textW, height: hookFit.height, flexShrink: 0, fontSize: hookFit.fontSize, fontWeight: 500,
          lineHeight: 1.08, letterSpacing: -1, color: c.accent,
        }, hookFit.text)
      : null;
    const headNode = h("div", {
      width: textW, marginTop: hookNode ? TEXT_GAP : 0, height: fit.height, flexShrink: 0, fontSize: fit.fontSize, fontWeight: 500,
      lineHeight: 1.14, letterSpacing: -1.2, color: c.text,
    }, fit.text);

    const creditPill: Node | null = credit
      ? h("div", {
          position: "absolute", left: 24, bottom: 20, maxWidth: CARD_W - 48, padding: "6px 16px", borderRadius: 8,
          backgroundColor: "rgba(0,0,0,0.45)", color: "#FFFFFF", fontSize: 22, fontWeight: 400, lineHeight: 1.2,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }, truncateChars(credit, 70))
      : null;

    const fMode = input.mode ?? "images";
    const fImgs = input.images.slice(0, 2);
    const layers: Node[] = [];
    if (fMode === "video") {
      layers.push(h("div", { position: "absolute", left: 0, top: 0, width: CARD_W, height: fPhotoH, backgroundColor: "#0B0B14" }));
    } else if (fImgs.length >= 2) {
      const FGAP = 8;
      const half = (CARD_W - FGAP) / 2;
      const left = await coverDataUri(fImgs[0]!, half * 2, fPhotoH * 2);
      const right = await coverDataUri(fImgs[1]!, half * 2, fPhotoH * 2);
      layers.push(
        img(left, half, fPhotoH, { position: "absolute", left: 0, top: 0 }),
        img(right, half, fPhotoH, { position: "absolute", left: half + FGAP, top: 0 }),
      );
      if (input.centerLogo) {
        const mark = await markDataUri(brand.logoPath, CENTER_LOGO * 2);
        const inner = CENTER_LOGO - 16;
        const logoInner: Node = mark
          ? img(mark, inner, inner, { borderRadius: inner / 2 })
          : h("div", { fontFamily: fontName, fontWeight: 700, fontSize: 80, color: readableOn(c.primary) }, (name[0] ?? "A").toUpperCase());
        layers.push(h("div", {
          position: "absolute", left: (CARD_W - CENTER_LOGO) / 2, top: Math.round((fPhotoH - CENTER_LOGO) / 2),
          width: CENTER_LOGO, height: CENTER_LOGO, borderRadius: CENTER_LOGO / 2, backgroundColor: c.primary,
          border: `8px solid ${c.background}`, alignItems: "center", justifyContent: "center", overflow: "hidden",
        }, logoInner));
      }
    } else if (fImgs.length === 1) {
      const a = await coverDataUri(fImgs[0]!, CARD_W * 2, fPhotoH * 2);
      layers.push(img(a, CARD_W, fPhotoH, { position: "absolute", left: 0, top: 0 }));
    } else {
      layers.push(await brandPanel(CARD_W, fPhotoH, 0, 0));
    }
    if (creditPill) layers.push(creditPill);
    const fPhoto = h("div", { position: "relative", width: CARD_W, height: fPhotoH, flexShrink: 0, overflow: "hidden" }, layers);

    const root = h("div", {
      width: CARD_W, height: canvasH, flexDirection: "column", backgroundColor: c.background, color: c.text,
      fontFamily: fontName, position: "relative",
    }, [
      h("div", {
        width: CARD_W, height: blockH, flexShrink: 0, flexDirection: "column", alignItems: "flex-start",
        paddingTop: FTOP, paddingLeft: FPAD, paddingRight: FPAD, paddingBottom: FBOT,
      }, [...(hookNode ? [hookNode] : []), headNode]),
      fPhoto,
    ]);
    const svg = await toSvg(root, CARD_W, canvasH, fonts);
    return {
      png: svgToPng(svg, c.background),
      layout: {
        headlineLines: fit.lines, headlineFontSize: fit.fontSize, headlineHeight: fit.height, headlineTruncated: fit.truncated,
        photoHeight: fPhotoH, photoRect: { x: 0, y: blockH, w: CARD_W, h: fPhotoH },
      },
    };
  }

  // Headline: shrink to fit; fewer lines are allowed when the photo would otherwise get too small.
  const fixed = PAD * 2 + safeTop + HEADER_H + 26 + 28 + 28 + FOOTER_H;
  const sizes = [76, 70, 64, 58, 54, 50];
  const fitAt = (list: number[]) =>
    fitHeadline(headline, { width: innerW, sizes: list, maxLines: 4, lineHeight: 1.12, letterSpacing: -1.2, fonts, fontName });
  const heightFor = (headlineH: number) => Math.floor(Math.max(MIN_PHOTO_H, canvasH - safeBottom - fixed - headlineH) / 2) * 2;
  let fit = await fitAt(sizes);
  if (input.mode === "video" && input.videoSize) {
    // Prefer the largest headline whose panel needs (almost) no crop and no bars for this video; else keep the default.
    for (const sz of sizes) {
      const f = await fitAt([sz]);
      if (!f.truncated && cropLoss(input.videoSize.width, input.videoSize.height, innerW, heightFor(f.height)) <= MAX_CROP_LOSS) {
        fit = f;
        break;
      }
    }
  }
  const photoH = heightFor(fit.height);

  const onPrimary = readableOn(c.primary);
  const onAccent = readableOn(c.accent);

  const markUri = await markDataUri(brand.logoPath, 160);
  const logo = markUri ? img(markUri, 80, 80, { borderRadius: 40 }) : await logoNode(brand.logoPath, 80, 20, { name: brand.name, primary: c.primary, fg: onPrimary }, fontName);

  // Photo area
  const mode = input.mode ?? "images";
  const imgs = input.images.slice(0, 2);
  const two = imgs.length >= 2;
  const w2 = (innerW - GAP) / 2;
  let photo: Node;
  if (mode === "video") {
    photo = h("div", { width: innerW, height: photoH, borderRadius: 30, backgroundColor: "#0B0B14" });
  } else if (two) {
    const left = await coverDataUri(imgs[0]!, w2 * 2, photoH * 2);
    const right = await coverDataUri(imgs[1]!, w2 * 2, photoH * 2);
    const badgeLogo = await markDataUri(brand.logoPath, 160);
    const badgeInner: Node = badgeLogo
      ? img(badgeLogo, 92, 92, { borderRadius: 46 })
      : h("div", { fontFamily: fontName, fontWeight: 800, fontSize: 52, color: onPrimary }, (name[0] ?? "A").toUpperCase());
    photo = h("div", { position: "relative", width: innerW, height: photoH, borderRadius: 30, overflow: "hidden" }, [
      img(left, w2, photoH, { position: "absolute", left: 0, top: 0 }),
      img(right, w2, photoH, { position: "absolute", left: w2 + GAP, top: 0 }),
      h("div", {
        position: "absolute", left: (innerW - BADGE) / 2, top: (photoH - BADGE) / 2,
        width: BADGE, height: BADGE, borderRadius: BADGE / 2, backgroundColor: c.primary,
        border: `8px solid ${c.background}`, alignItems: "center", justifyContent: "center",
      }, badgeInner),
    ]);
  } else if (imgs.length === 1) {
    const a = await coverDataUri(imgs[0]!, innerW * 2, photoH * 2);
    photo = img(a, innerW, photoH, { borderRadius: 30 });
  } else {
    photo = h("div", { position: "relative", width: innerW, height: photoH, borderRadius: 30, overflow: "hidden" }, [await brandPanel(innerW, photoH, 0, 0)]);
  }

  // Tall card: the bottom strip is a solid band so the Reels/TikTok UI text on it stays readable.
  const bandBg = readableOn(c.primary) === "#FFFFFF" ? c.primary : "#111111";
  // Smooth fade from transparent (top of the strip) to solid (bottom): eased stops across the whole strip, no visible kink.
  const rgb = parseHex(bandBg) ?? [17, 17, 17];
  const rgbList = rgb.join(",");
  const STOPS = 8;
  const fadeStops = Array.from({ length: STOPS + 1 }, (_, i) => {
    const t = i / STOPS;
    const eased = t * t * (3 - 2 * t); // smoothstep: zero slope at both ends
    return `rgba(${rgbList},${eased.toFixed(3)}) ${Math.round(t * 100)}%`;
  }).join(", ");
  const bottomBand: Node[] = tiktok
    ? [h("div", {
        position: "absolute", left: 0, bottom: 0, width: CARD_W, height: safeBottom,
        backgroundImage: `linear-gradient(to bottom, ${fadeStops})`,
      })]
    : [];

  const root = h("div", {
    width: CARD_W, height: canvasH, flexDirection: "column", backgroundColor: c.background, color: c.text,
    padding: PAD, paddingTop: PAD + safeTop, fontFamily: fontName, position: "relative",
  }, [
    // header: logo + name on the left, category pill on the right
    h("div", { height: HEADER_H, alignItems: "center", flexShrink: 0, width: innerW }, [
      logo,
      h("div", { flexDirection: "column", marginLeft: 20, justifyContent: "center", flexGrow: 1 }, [
        h("div", { fontSize: 36, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.1 }, name),
        h("div", { fontSize: 25, fontWeight: 400, opacity: 0.6, marginTop: 4 }, handle),
      ]),
      ...(tag
        ? [h("div", {
            backgroundColor: c.accent, color: onAccent, borderRadius: 999, padding: "0 24px", height: TAG_H,
            alignItems: "center", fontSize: 24, fontWeight: 800, letterSpacing: 2.2, flexShrink: 0,
          }, tag)]
        : []),
    ]),
    // headline
    h("div", {
      marginTop: 26, width: innerW, height: fit.height, flexShrink: 0, fontSize: fit.fontSize, fontWeight: 800,
      lineHeight: 1.12, letterSpacing: -1.2,
    }, fit.text),
    // photo
    h("div", { marginTop: 28, flexShrink: 0 }, photo),
    // footer
    h("div", { marginTop: 28, height: FOOTER_H, alignItems: "center", flexShrink: 0 }, [
      h("div", { width: 6, height: 44, backgroundColor: c.accent, borderRadius: 3, marginRight: 18, flexShrink: 0 }),
      h("div", { fontSize: 24, fontWeight: 400, lineHeight: 1.3, opacity: 0.65, width: innerW - 28, lineClamp: 2 }, credit),
    ]),
    ...bottomBand,
  ]);

  const photoY = PAD + safeTop + HEADER_H + 26 + fit.height + 28;
  const photoRect: Rect = { x: PAD, y: photoY, w: innerW, h: photoH };

  const svg = await toSvg(root, CARD_W, canvasH, fonts);
  return {
    png: svgToPng(svg, c.background),
    layout: {
      headlineLines: fit.lines, headlineFontSize: fit.fontSize, headlineHeight: fit.height,
      headlineTruncated: fit.truncated, photoHeight: photoH,
      photoRect,
    },
  };
}

