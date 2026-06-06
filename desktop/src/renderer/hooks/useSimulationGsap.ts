import { useLayoutEffect, useRef, type RefObject } from "react";
import gsap from "gsap";

/** Infinite dash flow on horizontal product lines (main header). */
const H_DUR = 0.65;
const H_STEP = 26;
/** Vertical trunk (process / manifold). */
const V_DUR = 0.75;
const V_STEP = 28;
/** Loading arm dash. */
const ARM_DUR = 0.5;
const ARM_STEP = 24;
/** Orthogonal trunk path (tank → quay), same units as V. */
const P_DUR = 0.85;
const P_STEP = 28;

type BerthFlow = "to-ship" | "to-tanks";

function readBerthFlow(el: Element): BerthFlow | null {
  const v = el.getAttribute("data-berth-flow");
  if (v === "to-ship" || v === "to-tanks") return v;
  return null;
}

export function useSvgFlowAnimations(
  svgRef: RefObject<SVGSVGElement | null>,
  active: boolean,
  pipeRate: number,
  pipeInbound: boolean
) {
  useLayoutEffect(() => {
    const root = svgRef.current;
    if (!root) return;

    const paused = !active;

    const ctx = gsap.context(() => {
      root.querySelectorAll<SVGGeometryElement>("[data-sim-flow='h']").forEach((el) => {
        const bf = readBerthFlow(el);
        /** With path (x1,y1)→(x2,y2): inbound = into terminal = product moves with geometry (header L→R, manifold toward tanks L). */
        const sign = bf === "to-ship" ? 1 : bf === "to-tanks" ? -1 : pipeInbound ? 1 : -1;
        gsap.fromTo(
          el,
          { strokeDashoffset: 0 },
          {
            strokeDashoffset: sign * H_STEP,
            duration: H_DUR,
            repeat: -1,
            ease: "power2.inOut",
            paused
          }
        );
      });

      root.querySelectorAll<SVGGeometryElement>("[data-sim-flow='v']").forEach((el) => {
        const bf = readBerthFlow(el);
        const sign = bf === "to-ship" ? 1 : bf === "to-tanks" ? -1 : pipeInbound ? 1 : -1;
        gsap.fromTo(
          el,
          { strokeDashoffset: 0 },
          {
            strokeDashoffset: sign * V_STEP,
            duration: V_DUR,
            repeat: -1,
            ease: "power2.inOut",
            paused
          }
        );
      });

      root.querySelectorAll<SVGGeometryElement>("[data-sim-flow='p']").forEach((el) => {
        const bf = readBerthFlow(el);
        const sign = bf === "to-tanks" ? -1 : 1;
        gsap.fromTo(
          el,
          { strokeDashoffset: 0 },
          {
            strokeDashoffset: sign * P_STEP,
            duration: P_DUR,
            repeat: -1,
            ease: "power2.inOut",
            paused
          }
        );
      });

      root.querySelectorAll<SVGGeometryElement>("[data-sim-flow='arm']").forEach((el) => {
        const bf = readBerthFlow(el);
        const sign = bf === "to-tanks" ? -1 : 1;
        gsap.fromTo(
          el,
          { strokeDashoffset: 0 },
          {
            strokeDashoffset: sign * ARM_STEP,
            duration: ARM_DUR,
            repeat: -1,
            ease: "power2.inOut",
            paused
          }
        );
      });
    }, root);

    return () => ctx.revert();
  }, [active, pipeRate, pipeInbound]);
}

/** Base seconds for vessel leg tweens; eased motion reads smoother on curved berth paths */
const VESSEL_DUR_BASE = 0.55;

export function useVesselGsapTransforms(
  svgRef: RefObject<SVGSVGElement | null>,
  vesselTargets: Map<string, { x: number; y: number }>,
  isPlaying: boolean,
  effectiveSpeed: number
) {
  const prevTargetsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  useLayoutEffect(() => {
    const root = svgRef.current;
    if (!root) return;

    const dur = Math.max(0.08, VESSEL_DUR_BASE / Math.sqrt(Math.max(0.05, effectiveSpeed)));
    const activeIds = new Set(vesselTargets.keys());

    vesselTargets.forEach((target, slotId) => {
      const el = root.querySelector<SVGGElement>(`[data-vessel-slot="${CSS.escape(slotId)}"]`);
      if (!el) return;

      const prev = prevTargetsRef.current.get(slotId);

      if (!isPlaying) {
        gsap.killTweensOf(el);
        gsap.set(el, { x: target.x, y: target.y });
        prevTargetsRef.current.set(slotId, { x: target.x, y: target.y });
        return;
      }

      if (prev != null && prev.x === target.x && prev.y === target.y) {
        return;
      }

      gsap.killTweensOf(el);
      if (prev == null) {
        gsap.set(el, { x: target.x, y: target.y });
      } else {
        gsap.fromTo(
          el,
          { x: prev.x, y: prev.y },
          {
            x: target.x,
            y: target.y,
            duration: dur,
            ease: "power2.inOut",
            overwrite: true
          }
        );
      }
      prevTargetsRef.current.set(slotId, { x: target.x, y: target.y });
    });

    prevTargetsRef.current.forEach((_, id) => {
      if (!activeIds.has(id)) prevTargetsRef.current.delete(id);
    });
  }, [vesselTargets, isPlaying, effectiveSpeed]);
}

/** Gentle motion for v4-style scattered water ripples (SVGGElement with data-water-glyph-wrap). */
export function useWaterwayWaves(svgRef: RefObject<SVGSVGElement | null>, isPlaying: boolean) {
  useLayoutEffect(() => {
    const root = svgRef.current;
    if (!root) return;

    const wraps = root.querySelectorAll<SVGGElement>("[data-water-glyph-wrap]");
    const dinghy = root.querySelector<SVGGElement>("[data-waterway-dinghy]");

    const ctx = gsap.context(() => {
      wraps.forEach((el, i) => {
        gsap.killTweensOf(el);
        const amp = 0.55 + (i % 4) * 0.22;
        const dur = 2.6 + (i % 8) * 0.28;
        if (!isPlaying) {
          gsap.set(el, { y: 0, opacity: 1 });
          return;
        }
        gsap.set(el, { opacity: 1 });
        gsap.fromTo(
          el,
          { y: i % 2 === 0 ? -amp * 0.4 : amp * 0.4 },
          {
            y: i % 2 === 0 ? amp : -amp,
            duration: dur,
            repeat: -1,
            yoyo: true,
            ease: "power2.inOut",
            delay: (i % 14) * 0.08
          }
        );
      });

      if (dinghy) {
        gsap.killTweensOf(dinghy);
        if (!isPlaying) {
          gsap.set(dinghy, { x: 0, y: 0 });
        } else {
          gsap.set(dinghy, { x: 0, y: 0 });
          gsap.to(dinghy, {
            x: 4,
            y: 1.2,
            duration: 4.2,
            repeat: -1,
            yoyo: true,
            ease: "power2.inOut"
          });
        }
      }
    }, root);

    return () => ctx.revert();
  }, [svgRef, isPlaying]);
}
