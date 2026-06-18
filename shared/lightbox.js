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

  overlay.append(imgEl, close);
  // Tap the dimmed backdrop (but not the image) to close.
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeLightbox(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("show")) closeLightbox();
  });
  document.body.append(overlay);
}

export function openLightbox(src, alt = "") {
  if (!src) return;
  ensure();
  imgEl.src = src;
  imgEl.alt = alt || "Full image";
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
