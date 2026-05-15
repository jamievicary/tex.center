// DOM-side implementation of `FadeAdapter` for the PDF preview
// cross-fade (M17 / M17.b). The adapter is the only piece of the
// fade subsystem that touches real DOM; the controller
// (`pdfFadeController.ts`) speaks to this interface and is
// DOM-free, and the blend strategy (`pdfCrossFade.ts`) is a pure
// math module.
//
// `onFadeEnd` decouples the adapter from the controller's
// construction order: the host wires the callback as a stable
// lambda that forwards to the eventual controller instance, so
// the adapter can be constructed first and still reach the
// controller once it exists.

import { type FadeAdapter } from "./pdfFadeController";
import { CROSS_FADE_STRATEGY } from "./pdfCrossFade";

export interface CreateFadeAdapterOptions {
  target: HTMLElement;
  observer: IntersectionObserver | null;
  onFadeEnd: (pageIndex: number) => void;
}

export function createFadeAdapter(opts: CreateFadeAdapterOptions): FadeAdapter {
  const { target, observer, onFadeEnd } = opts;

  return {
    createWrapper(pageIndex) {
      const w = document.createElement("div");
      w.className = "pdf-page";
      w.dataset.page = String(pageIndex + 1);
      target.appendChild(w);
      observer?.observe(w);
      return w;
    },
    removeWrapper(wrapper) {
      const w = wrapper as HTMLDivElement;
      observer?.unobserve(w);
      w.remove();
    },
    appendCanvasToWrapper(wrapper, canvas) {
      (wrapper as HTMLDivElement).appendChild(canvas as HTMLCanvasElement);
    },
    removeCanvasFromWrapper(_wrapper, canvas) {
      (canvas as HTMLCanvasElement).remove();
    },
    setWrapperGeometry(wrapper, width, height) {
      // Intrinsic width in canvas px; CSS caps with max-width:100%
      // and aspect-ratio keeps height proportional under responsive
      // scaling. Pages of different sizes each get their own shape.
      const w = wrapper as HTMLDivElement;
      w.style.width = `${width}px`;
      w.style.aspectRatio = `${width} / ${height}`;
    },
    startCrossFade({ wrapper, leaving, entering }) {
      // M17.b layering: entering stays opacity 1 *under* the
      // leaving canvas; leaving fades 1 → 0. See `pdfCrossFade.ts`
      // for why this avoids mid-fade BG bleed-through.
      const w = wrapper as HTMLDivElement;
      const enter = entering as HTMLCanvasElement;
      const leave = leaving as HTMLCanvasElement | null;
      enter.style.zIndex = String(CROSS_FADE_STRATEGY.enteringZIndex);
      enter.style.opacity = String(CROSS_FADE_STRATEGY.enteringOpacity);
      if (leave) {
        leave.style.zIndex = String(CROSS_FADE_STRATEGY.leavingZIndex);
        leave.style.opacity = String(CROSS_FADE_STRATEGY.leavingInitialOpacity);
        // Force reflow so the upcoming opacity change transitions
        // from the initial value rather than snapping.
        void leave.offsetWidth;
        leave.style.opacity = String(CROSS_FADE_STRATEGY.leavingTargetOpacity);
        const onEnd = (ev: TransitionEvent) => {
          if (ev.propertyName !== "opacity") return;
          leave.removeEventListener("transitionend", onEnd);
          const idx = (Number(w.dataset.page) || 0) - 1;
          if (idx >= 0) onFadeEnd(idx);
        };
        leave.addEventListener("transitionend", onEnd);
      } else {
        // No leaving canvas: the controller doesn't actually
        // schedule a cross-fade in this case (initial mount uses
        // `fadeInWrapper`). Defensive no-op for completeness.
        const idx = (Number(w.dataset.page) || 0) - 1;
        if (idx >= 0) onFadeEnd(idx);
      }
    },
    commitFadeImmediately({ wrapper, leaving, entering }) {
      const w = wrapper as HTMLDivElement;
      const enter = entering as HTMLCanvasElement | null;
      const leave = leaving as HTMLCanvasElement | null;
      if (leave && leave !== enter) {
        leave.remove();
      }
      if (enter) {
        enter.style.zIndex = String(CROSS_FADE_STRATEGY.enteringZIndex);
        enter.style.opacity = String(CROSS_FADE_STRATEGY.enteringOpacity);
      }
      void w.offsetWidth;
    },
    fadeInWrapper(wrapper) {
      const w = wrapper as HTMLDivElement;
      w.style.opacity = "0";
      void w.offsetWidth;
      w.style.opacity = "1";
      const onEnd = (ev: TransitionEvent) => {
        if (ev.propertyName !== "opacity") return;
        w.removeEventListener("transitionend", onEnd);
      };
      w.addEventListener("transitionend", onEnd);
    },
    fadeOutAndRemoveWrapper(wrapper) {
      const w = wrapper as HTMLDivElement;
      observer?.unobserve(w);
      w.style.opacity = "0";
      const onEnd = (ev: TransitionEvent) => {
        if (ev.propertyName !== "opacity") return;
        w.removeEventListener("transitionend", onEnd);
        w.remove();
      };
      w.addEventListener("transitionend", onEnd);
    },
  };
}
