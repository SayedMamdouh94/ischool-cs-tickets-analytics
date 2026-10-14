/**
 * Client-side chart image export. Recharts renders SVG styled with CSS
 * variables; we inline the computed colors so the image is self-contained,
 * then rasterize at 2x to PNG.
 */
const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-opacity", "fill-opacity", "opacity", "font-size", "font-family", "font-weight"];

export async function downloadElementAsPng(root: HTMLElement, filename: string, title?: string): Promise<void> {
  const svg = root.querySelector("svg.recharts-surface") ?? root.querySelector("svg");
  if (!svg) throw new Error("No chart to export.");
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;

  const sourceNodes = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll("*"))];
  sourceNodes.forEach((node, i) => {
    const computed = getComputedStyle(node as Element);
    const target = cloneNodes[i] as SVGElement;
    for (const prop of STYLE_PROPS) {
      const v = computed.getPropertyValue(prop);
      if (v) target.style.setProperty(prop, v);
    }
  });

  const titleHeight = title ? 36 : 0;
  const bg = getComputedStyle(root).backgroundColor || "#ffffff";
  const ink = getComputedStyle(root).color || "#111111";
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const svgText = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not render chart image."));
      img.src = url;
    });
    const scale = 2;
    const pad = 16;
    const canvas = document.createElement("canvas");
    canvas.width = (width + pad * 2) * scale;
    canvas.height = (height + pad * 2 + titleHeight) * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    ctx.scale(scale, scale);
    ctx.fillStyle = bg === "rgba(0, 0, 0, 0)" ? "#ffffff" : bg;
    ctx.fillRect(0, 0, width + pad * 2, height + pad * 2 + titleHeight);
    if (title) {
      ctx.fillStyle = ink;
      ctx.font = "600 14px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.fillText(title, pad, pad + 16);
    }
    ctx.drawImage(img, pad, pad + titleHeight, width, height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("Could not encode PNG.");
    triggerDownload(blob, filename.endsWith(".png") ? filename : `${filename}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function triggerDownload(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  const href = URL.createObjectURL(blob);
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
