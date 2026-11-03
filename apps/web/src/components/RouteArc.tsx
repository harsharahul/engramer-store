/**
 * The trip's route on a plain grid of latitude and longitude, drawn on the
 * device: great circles between its airports, the part already flown
 * glowing, the plane's dot while it is in the air. No map tiles, so no map
 * service learns where the trip goes.
 */

import { useEffect, useRef } from "react";
import type { LatLon } from "../intel/airports";
import type { Route } from "../intel/route";

/** Grid lines every 15° of longitude and 10° of latitude. */
const LON_STEP = 15;
const LAT_STEP = 10;

function draw(canvas: HTMLCanvasElement, route: Route) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const ctx = w > 0 && h > 0 ? canvas.getContext("2d") : null;
  if (!ctx) {
    return;
  }
  const dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const faint = token("--hairline-strong", "rgba(128, 128, 128, 0.3)");
  const a1 = token("--accent", "#3b82f6");
  const a2 = token("--accent-2", "#22d3ee");
  const text = token("--paper-dim", "#a2b3cf");
  const mono = token("--font-mono", "monospace");

  const { lon0, lon1, lat0, lat1 } = route.bounds;
  const at = (p: LatLon): [number, number] => [((p.lon - lon0) / (lon1 - lon0)) * w, h - ((p.lat - lat0) / (lat1 - lat0)) * h];

  // The grid, dashed and faint.
  ctx.strokeStyle = faint;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  for (let lon = Math.ceil(lon0 / LON_STEP) * LON_STEP; lon <= lon1; lon += LON_STEP) {
    const [x] = at({ lat: 0, lon });
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let lat = Math.ceil(lat0 / LAT_STEP) * LAT_STEP; lat <= lat1; lat += LAT_STEP) {
    const [, y] = at({ lat, lon: 0 });
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const line of route.lines) {
    const points = line.points.map(at);
    const gradient = ctx.createLinearGradient(points[0]![0], 0, points.at(-1)![0], 0);
    gradient.addColorStop(0, a1);
    gradient.addColorStop(1, a2);
    const path = (upTo: number) => {
      ctx.beginPath();
      points.slice(0, upTo + 1).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    };
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = gradient;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([6, 7]);
    path(points.length - 1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (line.inAir !== undefined) {
      const k = Math.round(line.inAir * (points.length - 1));
      if (k > 0) {
        path(k);
        ctx.shadowColor = a2;
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      const [x, y] = points[k]!;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = a2;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  for (const stop of route.stops) {
    const [x, y] = at(stop);
    ctx.fillStyle = text;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // The two ends, labelled with the code and the city; the eastern one's
  // label reads leftward so both stay inside the canvas.
  const originX = at(route.origin.at)[0];
  const destinationX = at(route.destination.at)[0];
  const ends: [Route["origin"], string, boolean][] = [
    [route.origin, a1, originX > destinationX],
    [route.destination, a2, destinationX >= originX],
  ];
  for (const [end, colour, right] of ends) {
    const [x, y] = at(end.at);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = text;
    ctx.textAlign = right ? "right" : "left";
    const dx = right ? -12 : 12;
    ctx.font = `700 13px ${mono}`;
    ctx.fillText(end.code, x + dx, y + 18);
    ctx.font = "11.5px -apple-system, Helvetica, sans-serif";
    ctx.fillText(end.city, x + dx, y + 33);
  }
}

export function RouteArc(props: { route: Route }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { route } = props;

  useEffect(() => {
    const el = canvas.current;
    if (!el) {
      return;
    }
    const redraw = () => draw(el, route);
    redraw();
    // Redrawn on a new size and on a theme change, since colours come from the theme's tokens.
    const resized = typeof ResizeObserver !== "undefined" ? new ResizeObserver(redraw) : null;
    resized?.observe(el);
    const themed = new MutationObserver(redraw);
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const scheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    scheme?.addEventListener?.("change", redraw);
    return () => {
      resized?.disconnect();
      themed.disconnect();
      scheme?.removeEventListener?.("change", redraw);
    };
  }, [route]);

  return (
    <canvas
      ref={canvas}
      className="tln-arc"
      role="img"
      aria-label={`Route from ${route.origin.city} to ${route.destination.city}, ${route.km.toLocaleString("en-US")} km`}
    />
  );
}
