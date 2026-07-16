// Shared full-image lightbox. Tap a cropped or thumbnail image to view it whole
// (object-fit: contain on a dimmed glass backdrop). Esc or a tap on the backdrop
// closes it. Used by the Desk (staged-draft preview + attachment thumbs) and the
// Portal (attachment previews). Styles live in shared/ui.css (.lightbox).
let overlay = null;
let imgEl = null;
let lastFocus = null;

function ensure() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Full image");

  imgEl = document.createElement("img");
  imgEl.alt = "";

  const close = document.createElement("button");
  close.className = "lightbox-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.textContent = "✕"; // ✕
  close.addEventListener("click", closeLightbox);

  // Optional Download button, shown only when openLightbox() is given a download
  // URL. Lets the full-size view save the original file instead of screenshotting.
  const dl = document.createElement("a");
  dl.className = "lightbox-dl";
  dl.target = "_blank";
  dl.rel = "noopener";
  dl.hidden = true;
  dl.textContent = "Download";

  overlay.append(imgEl, close, dl);
  // Tap the dimmed backdrop (but not the image) to close.
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("show")) closeLightbox();
  });
  document.body.append(overlay);
}

// opts.download (URL) shows a Download button; opts.name sets the saved filename.
export function openLightbox(src, alt = "", opts = {}) {
  if (!src) return;
  ensure();
  imgEl.src = src;
  imgEl.alt = alt || "Full image";
  const dl = overlay.querySelector(".lightbox-dl");
  if (dl) {
    const href = opts.download || opts.href;
    if (href) {
      dl.href = href;
      if (opts.name) dl.setAttribute("download", opts.name); else dl.removeAttribute("download");
      dl.hidden = false;
    } else {
      dl.hidden = true;
      dl.removeAttribute("href");
    }
  }
  lastFocus = document.activeElement;
  overlay.classList.add("show");
  const close = overlay.querySelector(".lightbox-close");
  if (close) close.focus();
}

export function closeLightbox() {
  if (!overlay) return;
  overlay.classList.remove("show");
  if (lastFocus && typeof lastFocus.focus === "function") {
    try { lastFocus.focus(); } catch (_) { /* element gone — ignore */ }
  }
}

// Wire an <img> so clicking it opens `fullSrc` (defaults to the img's own src).
export function makeZoomable(img, fullSrc) {
  img.classList.add("zoomable");
  img.addEventListener("click", (e) => {
    e.preventDefault();
    openLightbox(fullSrc || img.currentSrc || img.src, img.alt);
  });
}
