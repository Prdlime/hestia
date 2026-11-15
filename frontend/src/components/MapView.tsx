import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { StyleSpecification } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { IconLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import * as h3 from "h3-js";
import {
  Box,
  Check,
  Compass,
  Earth,
  Globe,
  Layers,
  Map as MapIcon,
  MousePointer,
  Pentagon,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { GeoJSONPolygon, SensorMode, SpatialHexDatum } from "../types/api";

const DARK_MATTER_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    "esri-satellite": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Tiles &copy; Esri",
    },
    // Esri's reference overlay (place names + borders) pairs with World Imagery
    // and needs no API key. The previous Carto raster label tiles now render an
    // "API KEY REQUIRED" watermark.
    "esri-labels": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Labels &copy; Esri",
    },
  },
  layers: [
    {
      id: "esri-satellite-layer",
      type: "raster",
      source: "esri-satellite",
      minzoom: 0,
      maxzoom: 19,
    },
    {
      id: "esri-labels-layer",
      type: "raster",
      source: "esri-labels",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

type DrawMode = "none" | "bbox" | "polygon";
type MapProjection = "globe" | "flat";

// Camera the map settles on: Malaysia and its neighbours.
const HOME_CENTER: [number, number] = [109.2, 3.8];
const HOME_ZOOM = 5.3;
// Zoom the page opens at, so the whole globe is visible before flying in.
const INTRO_ZOOM = 1.4;

// Apply the chosen projection (and a soft atmosphere halo for the globe).
// MapLibre resets both whenever a new style is loaded, so this runs on every
// "style.load" as well as when the user flips the Globe / Flat switch.
function projectionSpec(
  projection: MapProjection
): NonNullable<StyleSpecification["projection"]> {
  return { type: projection === "globe" ? "globe" : "mercator" };
}

function skySpec(
  projection: MapProjection
): NonNullable<StyleSpecification["sky"]> {
  return {
    "atmosphere-blend":
      projection === "globe"
        ? ["interpolate", ["linear"], ["zoom"], 0, 0.8, 4.5, 0.6, 6.5, 0]
        : 0,
  };
}

function applyProjection(map: maplibregl.Map, projection: MapProjection) {
  map.setProjection(projectionSpec(projection));
  map.setSky(skySpec(projection));
}

interface FireBeaconCluster {
  id: string;
  h3_index: string;
  position: [number, number];
  total_fires: number;
  mean_frp: number;
  zone_count: number;
}

interface MapViewProps {
  hexData: SpatialHexDatum[];
  aoi: GeoJSONPolygon;
  hasCustomAoi: boolean;
  onChangeAoi: (newAoi: GeoJSONPolygon) => void;
  onResetAoi: () => void;
  sensorMode: SensorMode;
  activeSliceLabel?: string;
  /** Daily view of a dataset whose world outside the study area is weekly. */
  dailyStudyAreaOnly?: boolean;
  loading: boolean;
}

// Soft round "ember" sprite: opaque at the centre, fading smoothly to nothing.
// Drawn once on a canvas and tinted per fire by the IconLayer (mask: true).
const GLOW_SPRITE_SIZE = 128;
const GLOW_ICON_MAPPING = {
  glow: {
    x: 0,
    y: 0,
    width: GLOW_SPRITE_SIZE,
    height: GLOW_SPRITE_SIZE,
    mask: true,
  },
};

function createGlowSprite(): string {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_SPRITE_SIZE;
  canvas.height = GLOW_SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const r = GLOW_SPRITE_SIZE / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.12, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.42)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.14)");
  gradient.addColorStop(0.8, "rgba(255,255,255,0.03)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
  return canvas.toDataURL();
}

// Animated flame sprites: a strip of hand-drawn flame frames that loops, so each
// fire can play it from its own starting frame.
const FLAME_FRAME_COUNT = 10;
const FLAME_FRAME_WIDTH = 96;
const FLAME_FRAME_HEIGHT = 168;
const FLAME_FRAMES_PER_SECOND = 11;

const FLAME_ICON_MAPPING: Record<
  string,
  {
    x: number;
    y: number;
    width: number;
    height: number;
    anchorY: number;
    mask: boolean;
  }
> = {};
for (let i = 0; i < FLAME_FRAME_COUNT; i++) {
  FLAME_ICON_MAPPING[`flame-${i}`] = {
    x: i * FLAME_FRAME_WIDTH,
    y: 0,
    width: FLAME_FRAME_WIDTH,
    height: FLAME_FRAME_HEIGHT,
    // Anchor near the bottom so the flame rises from the fire's location.
    anchorY: FLAME_FRAME_HEIGHT - 14,
    mask: false,
  };
}

// One tongue of flame: a teardrop that leans by `sway` at the tip.
function traceFlame(
  ctx: CanvasRenderingContext2D,
  cx: number,
  base: number,
  halfWidth: number,
  height: number,
  sway: number
) {
  ctx.beginPath();
  ctx.moveTo(cx, base);
  ctx.bezierCurveTo(
    cx - halfWidth * 1.15,
    base,
    cx - halfWidth * 1.2,
    base - height * 0.42,
    cx - halfWidth * 0.32 + sway * 0.45,
    base - height * 0.68
  );
  ctx.quadraticCurveTo(
    cx - halfWidth * 0.05 + sway * 0.8,
    base - height * 0.86,
    cx + sway,
    base - height
  );
  ctx.quadraticCurveTo(
    cx + halfWidth * 0.3 + sway * 0.75,
    base - height * 0.8,
    cx + halfWidth * 0.5 + sway * 0.4,
    base - height * 0.6
  );
  ctx.bezierCurveTo(
    cx + halfWidth * 1.25,
    base - height * 0.36,
    cx + halfWidth * 1.1,
    base,
    cx,
    base
  );
  ctx.closePath();
}

function createFlameAtlas(): string {
  const canvas = document.createElement("canvas");
  canvas.width = FLAME_FRAME_WIDTH * FLAME_FRAME_COUNT;
  canvas.height = FLAME_FRAME_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const base = FLAME_FRAME_HEIGHT - 14;
  const fullHeight = FLAME_FRAME_HEIGHT - 30;

  for (let i = 0; i < FLAME_FRAME_COUNT; i++) {
    // Phase runs once around the loop, so the last frame flows into the first.
    const t = (i / FLAME_FRAME_COUNT) * Math.PI * 2;
    const cx = i * FLAME_FRAME_WIDTH + FLAME_FRAME_WIDTH / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(i * FLAME_FRAME_WIDTH, 0, FLAME_FRAME_WIDTH, FLAME_FRAME_HEIGHT);
    ctx.clip();

    // Warm glow pooled at the base of the fire
    const pool = ctx.createRadialGradient(cx, base - 6, 0, cx, base - 6, 44);
    pool.addColorStop(0, "rgba(255,140,40,0.55)");
    pool.addColorStop(0.5, "rgba(255,80,20,0.18)");
    pool.addColorStop(1, "rgba(255,60,10,0)");
    ctx.fillStyle = pool;
    ctx.fillRect(i * FLAME_FRAME_WIDTH, base - 50, FLAME_FRAME_WIDTH, 64);

    // Three nested tongues: deep red-orange outside, orange, then yellow-white
    const tongues = [
      {
        width: 30,
        height: fullHeight * (0.9 + 0.1 * Math.sin(t)),
        sway: 9 * Math.sin(t + 0.4) + 4 * Math.sin(2 * t),
        blur: 5,
        stops: [
          [0, "rgba(255,120,30,0.85)"],
          [0.45, "rgba(240,60,15,0.7)"],
          [0.85, "rgba(190,25,5,0.25)"],
          [1, "rgba(150,15,0,0)"],
        ],
      },
      {
        width: 20,
        height: fullHeight * (0.66 + 0.08 * Math.sin(t + 1.9)),
        sway: 6 * Math.sin(t + 1.3) + 3 * Math.sin(2 * t + 0.7),
        blur: 3.5,
        stops: [
          [0, "rgba(255,200,70,0.95)"],
          [0.5, "rgba(255,150,35,0.85)"],
          [0.9, "rgba(255,95,20,0.3)"],
          [1, "rgba(255,80,10,0)"],
        ],
      },
      {
        width: 11,
        height: fullHeight * (0.4 + 0.06 * Math.sin(t + 3.1)),
        sway: 3.5 * Math.sin(t + 2.2),
        blur: 2.5,
        stops: [
          [0, "rgba(255,252,235,1)"],
          [0.5, "rgba(255,238,160,0.95)"],
          [0.9, "rgba(255,205,90,0.4)"],
          [1, "rgba(255,190,70,0)"],
        ],
      },
    ] as const;

    for (const tongue of tongues) {
      const gradient = ctx.createLinearGradient(
        0,
        base,
        0,
        base - tongue.height
      );
      for (const [offset, color] of tongue.stops) {
        gradient.addColorStop(offset, color);
      }
      ctx.fillStyle = gradient;
      ctx.filter = `blur(${tongue.blur}px)`;
      traceFlame(ctx, cx, base, tongue.width, tongue.height, tongue.sway);
      ctx.fill();
    }

    // A small side lick that leans the other way, so the outline is not symmetric
    ctx.filter = "blur(3px)";
    const lick = ctx.createLinearGradient(0, base, 0, base - fullHeight * 0.5);
    lick.addColorStop(0, "rgba(255,150,40,0.8)");
    lick.addColorStop(1, "rgba(230,50,10,0)");
    ctx.fillStyle = lick;
    traceFlame(
      ctx,
      cx + 13 * Math.cos(t + 0.8),
      base,
      9,
      fullHeight * (0.42 + 0.1 * Math.cos(t * 2 + 1)),
      -7 * Math.sin(t + 0.9)
    );
    ctx.fill();

    ctx.restore();
  }
  return canvas.toDataURL();
}

// Light adds up where glows overlap, the way real firelight does.
const ADDITIVE_GLOW_PARAMETERS = {
  // deck.gl's globe view culls back faces, which drops camera-facing sprites.
  cullMode: "none",
  depthWriteEnabled: false,
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

// Stable 0..2π phase per fire so each one flickers on its own rhythm.
function flickerPhase(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 6283) / 1000;
}

// Gentle, irregular breathing of a flame: two sine waves out of step.
function flickerFactor(timeSec: number, phase: number): number {
  return (
    1 +
    0.1 * Math.sin(timeSec * 2.3 + phase) +
    0.06 * Math.sin(timeSec * 5.9 + phase * 1.7)
  );
}

function getFireColor(
  fires: number,
  maxFires: number
): [number, number, number, number] {
  const ratio = Math.min(1, Math.sqrt(fires / Math.max(1, maxFires * 0.75)));
  if (ratio < 0.25) {
    return [253, 224, 71, 200];
  } else if (ratio < 0.5) {
    return [251, 146, 60, 215];
  } else if (ratio < 0.75) {
    return [239, 68, 68, 230];
  } else {
    return [225, 29, 72, 245];
  }
}

export const MapView: React.FC<MapViewProps> = ({
  hexData,
  aoi,
  hasCustomAoi,
  onChangeAoi,
  onResetAoi,
  sensorMode,
  activeSliceLabel,
  dailyStudyAreaOnly = false,
  loading,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);

  const [basemap, setBasemap] = useState<"dark" | "satellite">("dark");
  const [extruded3D, setExtruded3D] = useState<boolean>(true);
  const [projection, setProjection] = useState<MapProjection>("globe");
  const projectionRef = useRef<MapProjection>(projection);
  projectionRef.current = projection;
  const [currentZoom, setCurrentZoom] = useState<number>(INTRO_ZOOM);
  const [drawMode, setDrawMode] = useState<DrawMode>("none");
  const [draftVertices, setDraftVertices] = useState<[number, number][]>([]);
  const [cursorLonLat, setCursorLonLat] = useState<[number, number] | null>(
    null
  );
  const [hoveredHex, setHoveredHex] = useState<{
    datum: SpatialHexDatum | FireBeaconCluster;
    x: number;
    y: number;
  } | null>(null);

  // Clock (seconds) that drives the ember flicker; stays 0 when motion is reduced.
  const [flickerTime, setFlickerTime] = useState<number>(0);
  // Bumped whenever the camera settles, so far-side glow hiding stays current.
  const [viewTick, setViewTick] = useState<number>(0);
  const glowSprite = useMemo(() => createGlowSprite(), []);
  const flameAtlas = useMemo(() => createFlameAtlas(), []);

  const drawModeRef = useRef<DrawMode>(drawMode);
  drawModeRef.current = drawMode;
  const draftVerticesRef = useRef<[number, number][]>(draftVertices);
  draftVerticesRef.current = draftVertices;
  const cursorLonLatRef = useRef<[number, number] | null>(cursorLonLat);
  cursorLonLatRef.current = cursorLonLat;
  const isDraggingBoxRef = useRef<boolean>(false);

  const maxFires = useMemo(() => {
    if (!hexData.length) return 100;
    return Math.max(...hexData.map((d) => d.total_fires), 10);
  }, [hexData]);

  // Determine appropriate H3 aggregation resolution for current zoom level
  const clusterResolution = useMemo(() => {
    if (currentZoom < 4.0) return 4; // Continental scale: ~1,770 km² parent zones
    if (currentZoom < 5.2) return 5; // Regional scale: ~252 km² parent zones
    if (currentZoom < 6.4) return 6; // Sub-regional scale: ~36 km² parent zones
    return 8; // Full Res-8 detail
  }, [currentZoom]);

  // Dynamic hierarchical H3 clustering to completely eliminate z-fighting at low zoom
  const { clusteredBeacons, maxClusterFires } = useMemo(() => {
    if (clusterResolution >= 8) {
      const items: FireBeaconCluster[] = hexData.map((d) => {
        let lat = 3.0,
          lon = 100.0;
        try {
          const coords = h3.cellToLatLng(d.h3_index);
          lat = coords[0];
          lon = coords[1];
        } catch {
          // ignore
        }
        return {
          id: d.h3_index,
          h3_index: d.h3_index,
          position: [lon, lat] as [number, number],
          total_fires: d.total_fires,
          mean_frp: d.mean_frp,
          zone_count: 1,
        };
      });
      const maxF = items.length
        ? Math.max(...items.map((i) => i.total_fires), 10)
        : 100;
      return { clusteredBeacons: items, maxClusterFires: maxF };
    }

    const clusterMap = new Map<
      string,
      { total_fires: number; weighted_frp: number; zone_count: number }
    >();

    for (const d of hexData) {
      let parentId: string;
      try {
        parentId = h3.cellToParent(d.h3_index, clusterResolution);
      } catch {
        parentId = d.h3_index;
      }

      let c = clusterMap.get(parentId);
      if (!c) {
        c = { total_fires: 0, weighted_frp: 0, zone_count: 0 };
        clusterMap.set(parentId, c);
      }
      c.total_fires += d.total_fires;
      c.weighted_frp += d.mean_frp * d.total_fires;
      c.zone_count += 1;
    }

    const items: FireBeaconCluster[] = Array.from(clusterMap.entries()).map(
      ([parentId, c]) => {
        let lat = 3.0,
          lon = 100.0;
        try {
          const coords = h3.cellToLatLng(parentId);
          lat = coords[0];
          lon = coords[1];
        } catch {
          // ignore
        }
        return {
          id: parentId,
          h3_index: parentId,
          position: [lon, lat] as [number, number],
          total_fires: c.total_fires,
          mean_frp:
            Math.round(
              (c.weighted_frp / Math.max(1, c.total_fires)) * 10
            ) / 10,
          zone_count: c.zone_count,
        };
      }
    );

    const maxF = items.length
      ? Math.max(...items.map((i) => i.total_fires), 10)
      : 100;
    return { clusteredBeacons: items, maxClusterFires: maxF };
  }, [hexData, clusterResolution]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: DARK_MATTER_STYLE,
      center: HOME_CENTER,
      zoom: INTRO_ZOOM,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      // Show a single world: no repeated copies when zoomed out on a wide map.
      renderWorldCopies: false,
    });

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "bottom-right"
    );

    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
    });
    map.addControl(overlay as unknown as maplibregl.IControl);

    map.on("zoom", () => {
      setCurrentZoom(map.getZoom());
    });

    map.on("moveend", () => {
      setViewTick((t) => t + 1);
    });

    // Re-apply the projection each time a style (Dark / Satellite) finishes loading.
    map.on("style.load", () => {
      applyProjection(map, projectionRef.current);
    });

    // Opening move: show the whole globe, then fly in to the region.
    map.once("load", () => {
      map.flyTo({
        center: HOME_CENTER,
        zoom: HOME_ZOOM,
        pitch: 36,
        duration: 3200,
      });
    });

    const finalizeBoxDrag = (endPt: [number, number] | null) => {
      if (drawModeRef.current !== "bbox" || !isDraggingBoxRef.current) return;
      isDraggingBoxRef.current = false;

      const currentPts = draftVerticesRef.current;
      if (currentPts.length === 0 || !endPt) {
        setDraftVertices([]);
        return;
      }

      const [lon1, lat1] = currentPts[0];
      const [lon2, lat2] = endPt;
      const minLon = Math.min(lon1, lon2);
      const maxLon = Math.max(lon1, lon2);
      const minLat = Math.min(lat1, lat2);
      const maxLat = Math.max(lat1, lat2);

      if (maxLon - minLon > 0.01 && maxLat - minLat > 0.01) {
        onChangeAoi({
          type: "Polygon",
          coordinates: [
            [
              [minLon, minLat],
              [maxLon, minLat],
              [maxLon, maxLat],
              [minLon, maxLat],
              [minLon, minLat],
            ],
          ],
        });
        setDraftVertices([]);
        setCursorLonLat(null);
        setDrawMode("none");
      } else {
        // Ignore accidental single click without dragging; stay in Draw Box mode
        setDraftVertices([]);
      }
    };

    map.on("mousedown", (e) => {
      if (drawModeRef.current === "bbox" && e.originalEvent.button === 0) {
        e.preventDefault();
        const pt: [number, number] = [
          Number(e.lngLat.lng.toFixed(4)),
          Number(e.lngLat.lat.toFixed(4)),
        ];
        isDraggingBoxRef.current = true;
        setDraftVertices([pt]);
        setCursorLonLat(pt);
      }
    });

    map.on("mousemove", (e) => {
      if (drawModeRef.current !== "none") {
        setCursorLonLat([
          Number(e.lngLat.lng.toFixed(4)),
          Number(e.lngLat.lat.toFixed(4)),
        ]);
      }
    });

    map.on("mouseup", (e) => {
      if (drawModeRef.current === "bbox" && isDraggingBoxRef.current) {
        const endPt: [number, number] = [
          Number(e.lngLat.lng.toFixed(4)),
          Number(e.lngLat.lat.toFixed(4)),
        ];
        finalizeBoxDrag(endPt);
      }
    });

    const handleWindowMouseUp = () => {
      if (drawModeRef.current === "bbox" && isDraggingBoxRef.current) {
        finalizeBoxDrag(cursorLonLatRef.current);
      }
    };
    window.addEventListener("mouseup", handleWindowMouseUp);

    map.on("click", (e) => {
      const mode = drawModeRef.current;
      if (mode !== "polygon") return;

      const pt: [number, number] = [
        Number(e.lngLat.lng.toFixed(4)),
        Number(e.lngLat.lat.toFixed(4)),
      ];
      setDraftVertices([...draftVerticesRef.current, pt]);
    });

    mapRef.current = map;
    deckOverlayRef.current = overlay;

    return () => {
      window.removeEventListener("mouseup", handleWindowMouseUp);
      map.remove();
      mapRef.current = null;
      deckOverlayRef.current = null;
    };
  }, [onChangeAoi]);

  const handleToggleBasemap = (target: "dark" | "satellite") => {
    setBasemap(target);
    if (!mapRef.current) return;
    // Carry the current projection into the new style, so the map never drops
    // back to a flat map (and shifts the camera) while the basemap is swapping.
    const current = projectionRef.current;
    mapRef.current.setStyle(
      target === "dark" ? DARK_MATTER_STYLE : SATELLITE_STYLE,
      {
        transformStyle: (_previous, next) => ({
          ...next,
          projection: projectionSpec(current),
          sky: skySpec(current),
        }),
      }
    );
  };

  const handleToggleProjection = (target: MapProjection) => {
    setProjection(target);
    if (mapRef.current) {
      applyProjection(mapRef.current, target);
    }
  };

  const handleToggle3D = () => {
    const next = !extruded3D;
    setExtruded3D(next);
    if (mapRef.current) {
      mapRef.current.easeTo({ pitch: next ? 38 : 0, duration: 600 });
    }
  };

  const handleFinishPolygon = () => {
    if (draftVertices.length >= 3) {
      const closedRing = [...draftVertices, draftVertices[0]];
      onChangeAoi({
        type: "Polygon",
        coordinates: [closedRing],
      });
    }
    setDraftVertices([]);
    setCursorLonLat(null);
    setDrawMode("none");
  };

  const handleCancelDraw = () => {
    isDraggingBoxRef.current = false;
    setDraftVertices([]);
    setCursorLonLat(null);
    setDrawMode("none");
  };

  // Keyboard shortcut: Escape cancels drawing mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawMode !== "none") {
        handleCancelDraw();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drawMode]);

  // Update canvas cursor and disable dragPan / boxZoom while drawing
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    if (drawMode !== "none") {
      map.getCanvas().style.cursor = "crosshair";
      map.dragPan.disable();
      map.boxZoom.disable();
    } else {
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
      map.boxZoom.enable();
    }
  }, [drawMode]);

  // Animation clock (~16 fps) for the ember flicker and the flames.
  const fireAnimationActive = hexData.length > 0;
  useEffect(() => {
    if (!fireAnimationActive) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      if (now - lastUpdate >= 60) {
        lastUpdate = now;
        setFlickerTime(now / 1000);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fireAnimationActive]);

  // One flame per fire hexagon, positioned at the hexagon's centre.
  const flamePoints = useMemo(
    () =>
      hexData.flatMap((d) => {
        try {
          const [lat, lon] = h3.cellToLatLng(d.h3_index);
          return [
            {
              id: d.h3_index,
              position: [lon, lat] as [number, number],
              total_fires: d.total_fires,
              phase: flickerPhase(d.h3_index),
            },
          ];
        } catch {
          return [];
        }
      }),
    [hexData]
  );

  // On the globe, leave out flames hidden behind the planet (re-checked whenever
  // the camera settles), since camera-facing sprites would otherwise show through.
  const visibleFlamePoints = useMemo(() => {
    const map = mapRef.current;
    if (projection !== "globe" || !map) return flamePoints;
    return flamePoints.filter(
      (d) =>
        !map.transform.isLocationOccluded(
          new maplibregl.LngLat(d.position[0], d.position[1])
        )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flamePoints, projection, viewTick]);

  const draftPolygonCoords = useMemo(() => {
    if (drawMode === "bbox" && draftVertices.length === 1 && cursorLonLat) {
      const [lon1, lat1] = draftVertices[0];
      const [lon2, lat2] = cursorLonLat;
      const minLon = Math.min(lon1, lon2);
      const maxLon = Math.max(lon1, lon2);
      const minLat = Math.min(lat1, lat2);
      const maxLat = Math.max(lat1, lat2);
      return [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ];
    }
    if (drawMode === "polygon" && draftVertices.length >= 1) {
      const pts = cursorLonLat
        ? [...draftVertices, cursorLonLat]
        : [...draftVertices];
      if (pts.length >= 2) {
        return [...pts, pts[0]];
      }
    }
    return null;
  }, [drawMode, draftVertices, cursorLonLat]);

  useEffect(() => {
    if (!deckOverlayRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layers: any[] = [];

    // Only draw the blue AOI selection boundary when the user has drawn a custom Box/Polygon
    if (hasCustomAoi) {
      layers.push(
        new PolygonLayer({
          id: "active-aoi-boundary",
          data: [{ polygon: aoi.coordinates[0] || [] }],
          getPolygon: (d: { polygon: number[][] }) => d.polygon,
          filled: true,
          stroked: true,
          getFillColor: [14, 165, 233, 18],
          getLineColor: [56, 189, 248, 230],
          getLineWidth: 2,
          lineWidthMinPixels: 2,
          pickable: false,
        })
      );
    }

    // 1. Zoomed-out dynamic hierarchical H3 clusters with two-pass soft emissive glow
    if (currentZoom < 6.8 && clusteredBeacons.length > 0) {
      const beaconOpacity =
        currentZoom < 5.2
          ? 1.0
          : Math.max(0.15, (6.8 - currentZoom) / 1.6);

      // Adaptive sizing: compact, refined pinpoint sizes at continental scale
      const isContinental = currentZoom < 4.2;
      const haloMin = isContinental ? 16 : 26;
      const haloMax = isContinental ? 40 : 72;
      const flameMin = isContinental ? 8 : 12;
      const flameMax = isContinental ? 18 : 30;
      const coreMin = isContinental ? 1.2 : 1.6;
      const coreMax = isContinental ? 2.6 : 3.8;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const intensity = (d: any) => Math.sqrt(d.total_fires / maxClusterFires);

      // With culling off, glows on the far side of the globe would shine through
      // the planet, so drop the ones MapLibre reports as hidden behind it.
      const map = mapRef.current;
      const emberData =
        projection === "globe" && map
          ? clusteredBeacons.filter(
              (d) =>
                !map.transform.isLocationOccluded(
                  new maplibregl.LngLat(d.position[0], d.position[1])
                )
            )
          : clusteredBeacons;

      // Pass A: Wide, faint heat halo in the fire's intensity colour
      layers.push(
        new IconLayer({
          id: "fire-cluster-halo",
          data: emberData,
          pickable: false,
          iconAtlas: glowSprite,
          iconMapping: GLOW_ICON_MAPPING,
          getIcon: () => "glow",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getPosition: (d: any) => d.position,
          sizeUnits: "pixels",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getSize: (d: any) =>
            (haloMin + intensity(d) * (haloMax - haloMin)) *
            flickerFactor(flickerTime * 0.6, flickerPhase(d.id) + 1.3),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getColor: (d: any) => {
            const [r, g, b] = getFireColor(d.total_fires, maxClusterFires);
            return [r, g, b, Math.round(150 * beaconOpacity)];
          },
          parameters: ADDITIVE_GLOW_PARAMETERS,
          updateTriggers: {
            getColor: [maxClusterFires, sensorMode, beaconOpacity],
            getSize: [maxClusterFires, isContinental, flickerTime],
          },
        })
      );

      // Pass B: Brighter, tighter flame body that flickers
      layers.push(
        new IconLayer({
          id: "fire-cluster-flame",
          data: emberData,
          pickable: false,
          iconAtlas: glowSprite,
          iconMapping: GLOW_ICON_MAPPING,
          getIcon: () => "glow",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getPosition: (d: any) => d.position,
          sizeUnits: "pixels",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getSize: (d: any) =>
            (flameMin + intensity(d) * (flameMax - flameMin)) *
            flickerFactor(flickerTime, flickerPhase(d.id)),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getColor: (d: any) => {
            // Pull the intensity colour toward hot orange-yellow, like a flame body
            const [r, g, b] = getFireColor(d.total_fires, maxClusterFires);
            return [
              Math.round((r + 255) / 2),
              Math.round((g + 170) / 2),
              Math.round((b + 60) / 2),
              Math.round(
                235 *
                  beaconOpacity *
                  Math.min(1, flickerFactor(flickerTime, flickerPhase(d.id)))
              ),
            ];
          },
          parameters: ADDITIVE_GLOW_PARAMETERS,
          updateTriggers: {
            getColor: [maxClusterFires, sensorMode, beaconOpacity, flickerTime],
            getSize: [maxClusterFires, isContinental, flickerTime],
          },
        })
      );

      // Pass C: White-hot core; also the click / hover target (1-click zoom)
      layers.push(
        new ScatterplotLayer({
          id: "fire-cluster-core",
          data: clusteredBeacons,
          pickable: currentZoom < 6.5,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getPosition: (d: any) => d.position,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getRadius: (d: any) =>
            coreMin +
            Math.sqrt(d.total_fires / maxClusterFires) * (coreMax - coreMin),
          radiusUnits: "pixels",
          radiusMinPixels: coreMin,
          radiusMaxPixels: coreMax,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getFillColor: [255, 244, 214, Math.round(240 * beaconOpacity)],
          stroked: false,
          updateTriggers: {
            getFillColor: [beaconOpacity],
            getRadius: [maxClusterFires, currentZoom],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onClick: (info: any) => {
            if (info.object && mapRef.current) {
              mapRef.current.flyTo({
                center: info.object.position,
                zoom: Math.min(8.2, currentZoom + 2.5),
                duration: 1100,
              });
            }
          },
          onHover: (info) => {
            if (
              info.object &&
              typeof info.x === "number" &&
              typeof info.y === "number"
            ) {
              setHoveredHex({
                datum: info.object as FireBeaconCluster,
                x: info.x,
                y: info.y,
              });
            } else {
              setHoveredHex(null);
            }
          },
        })
      );
    }

    // 2. High-resolution H3 Hexagon Layer (fades in starting at zoom 5.0, fully opaque at zoom >= 6.5)
    const hexOpacity =
      currentZoom >= 6.5
        ? 1.0
        : Math.max(0.0, (currentZoom - 5.0) / 1.5);

    if (hexOpacity > 0.05) {
      // Flat footprint of each burning hexagon. In 3D View it sits under the
      // flames as a dim scorched patch; in 2D View it is the full-strength map.
      const h3Layer = new H3HexagonLayer<SpatialHexDatum>({
        id: "h3-fire-hexagons",
        data: hexData,
        pickable: currentZoom >= 6.0,
        wireframe: false,
        filled: true,
        extruded: false,
        opacity: extruded3D ? hexOpacity * 0.5 : hexOpacity,
        getHexagon: (d) => d.h3_index,
        getFillColor: (d) => getFireColor(d.total_fires, maxFires),
        highPrecision: true,
        updateTriggers: {
          getFillColor: [maxFires, sensorMode],
        },
        onHover: (info) => {
          if (
            info.object &&
            typeof info.x === "number" &&
            typeof info.y === "number"
          ) {
            setHoveredHex({
              datum: info.object as SpatialHexDatum,
              x: info.x,
              y: info.y,
            });
          } else {
            setHoveredHex(null);
          }
        },
      });

      layers.push(h3Layer);
    }

    // 3. Animated flames rising from each burning hexagon (3D View, zoomed in).
    //    They replace the old extruded columns; taller flames = more fire activity.
    const flameOpacity = Math.min(1, Math.max(0, currentZoom - 5.8));
    if (extruded3D && flameOpacity > 0.05 && visibleFlamePoints.length > 0) {
      const zoomScale = Math.min(1.7, Math.max(0.75, 0.75 + (currentZoom - 6.2) * 0.2));
      const frameClock = flickerTime * FLAME_FRAMES_PER_SECOND;

      layers.push(
        new IconLayer({
          id: "fire-flames",
          data: visibleFlamePoints,
          pickable: false,
          iconAtlas: flameAtlas,
          iconMapping: FLAME_ICON_MAPPING,
          getIcon: (d: { phase: number }) =>
            `flame-${
              Math.floor(frameClock + d.phase * 7) % FLAME_FRAME_COUNT
            }`,
          getPosition: (d: { position: [number, number] }) => d.position,
          sizeUnits: "pixels",
          getSize: (d: { total_fires: number; phase: number }) =>
            (38 + Math.sqrt(d.total_fires / maxFires) * 74) *
            zoomScale *
            flickerFactor(flickerTime, d.phase),
          getColor: [255, 255, 255, Math.round(255 * flameOpacity)],
          parameters: ADDITIVE_GLOW_PARAMETERS,
          updateTriggers: {
            getIcon: [flickerTime],
            getSize: [maxFires, zoomScale, flickerTime],
            getColor: [flameOpacity],
          },
        })
      );
    }

    if (draftPolygonCoords) {
      layers.push(
        new PolygonLayer({
          id: "draft-aoi-preview",
          data: [{ polygon: draftPolygonCoords }],
          getPolygon: (d: { polygon: number[][] }) => d.polygon,
          filled: true,
          stroked: true,
          getFillColor: [245, 158, 11, 45],
          getLineColor: [251, 191, 36, 255],
          getLineWidth: 2.5,
          lineWidthMinPixels: 2,
          pickable: false,
        })
      );
    }

    if (draftVertices.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: "draft-aoi-vertices",
          data: draftVertices,
          getPosition: (d: [number, number]) => d,
          getFillColor: [251, 191, 36, 255],
          getLineColor: [15, 23, 42, 255],
          stroked: true,
          lineWidthMinPixels: 2,
          radiusMinPixels: 5,
          radiusMaxPixels: 7,
          pickable: false,
        })
      );
    }

    deckOverlayRef.current.setProps({ layers });
  }, [
    hexData,
    clusteredBeacons,
    maxClusterFires,
    currentZoom,
    aoi,
    hasCustomAoi,
    extruded3D,
    maxFires,
    sensorMode,
    draftPolygonCoords,
    draftVertices,
    flickerTime,
    glowSprite,
    flameAtlas,
    visibleFlamePoints,
    projection,
    viewTick,
  ]);

  return (
    <div
      className={`relative w-full h-full rounded-xl overflow-hidden ${
        projection === "globe"
          ? // Globe floats directly on the page: no panel behind it.
            "bg-transparent"
          : "border border-slate-800 bg-slate-900 shadow-2xl"
      }`}
    >
      <div
        ref={mapContainerRef}
        className={`w-full h-full ${
          drawMode !== "none"
            ? "map-drawing-active cursor-crosshair"
            : "cursor-grab active:cursor-grabbing"
        }`}
      />

      {/* Top-Left Map Toolbar & Overlay Controls in Vertical Stack */}
      <div className="absolute top-3 left-3 z-10 flex flex-col items-start gap-2 max-w-[calc(100%-200px)]">
        {/* Tool Selection Bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-lg p-1 shadow-lg">
            <button
              type="button"
              onClick={handleCancelDraw}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                drawMode === "none"
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                  : "text-slate-300 hover:text-white hover:bg-slate-800"
              }`}
              title="Inspect & Pan Mode"
            >
              <MousePointer className="w-3.5 h-3.5" />
              <span>Inspect</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDraftVertices([]);
                setDrawMode("bbox");
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                drawMode === "bbox"
                  ? "bg-amber-500/25 text-amber-300 border border-amber-500/50"
                  : "text-slate-300 hover:text-white hover:bg-slate-800"
              }`}
              title="Draw a rectangular area to filter fire data"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Draw Box</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDraftVertices([]);
                setDrawMode("polygon");
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                drawMode === "polygon"
                  ? "bg-amber-500/25 text-amber-300 border border-amber-500/50"
                  : "text-slate-300 hover:text-white hover:bg-slate-800"
              }`}
              title="Draw a custom polygon to filter fire data"
            >
              <Pentagon className="w-3.5 h-3.5" />
              <span>Draw Polygon</span>
            </button>
          </div>

          {/* Reset Custom Area Button */}
          {hasCustomAoi && drawMode === "none" && (
            <button
              type="button"
              onClick={onResetAoi}
              className="flex items-center gap-1.5 bg-sky-950/90 hover:bg-sky-900 backdrop-blur-md border border-sky-500/50 text-sky-200 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition-colors"
              title="Clear custom drawn area and view all regions"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Area</span>
            </button>
          )}
        </div>

        {/* Interactive Drawing Instructions Pill: Positioned directly below the tool selection bar */}
        {drawMode !== "none" && (
          <div className="flex items-center gap-2 bg-amber-950/90 backdrop-blur-md border border-amber-500/60 text-amber-200 px-3 py-1.5 rounded-lg text-xs shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
            {drawMode === "bbox" ? (
              <span>
                {draftVertices.length === 0
                  ? "Click and drag on the map to draw a box"
                  : "Release mouse button to apply box selection"}
              </span>
            ) : (
              <span>Click map to add points ({draftVertices.length})</span>
            )}

            {drawMode === "polygon" && draftVertices.length >= 3 && (
              <button
                type="button"
                onClick={handleFinishPolygon}
                className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-0.5 rounded font-semibold transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
                Apply
              </button>
            )}

            <button
              type="button"
              onClick={handleCancelDraw}
              className="flex items-center gap-1 text-amber-300 hover:text-white px-1 py-0.5 rounded hover:bg-amber-900/50 transition-colors"
              title="Cancel Drawing (Esc)"
            >
              <X className="w-3.5 h-3.5" />
              <span className="text-[10px] opacity-75">Esc</span>
            </button>
          </div>
        )}
      </div>

      {/* Top-Right Map Controls: Basemap & 3D View Toggle */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={handleToggle3D}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border backdrop-blur-md shadow-lg transition-colors ${
            extruded3D
              ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
              : "bg-slate-900/90 border-slate-700/80 text-slate-300 hover:text-white"
          }`}
          title="Toggle the tilted 3D view with animated flames"
        >
          <Box className="w-3.5 h-3.5" />
          <span>{extruded3D ? "3D View" : "2D View"}</span>
        </button>

        <div className="flex items-center bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-lg p-1 shadow-lg">
          <button
            type="button"
            onClick={() => handleToggleProjection("globe")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              projection === "globe"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Show the map as a globe"
          >
            <Earth className="w-3.5 h-3.5" />
            <span>Globe</span>
          </button>
          <button
            type="button"
            onClick={() => handleToggleProjection("flat")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              projection === "flat"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Flatten the map to 2D"
          >
            <MapIcon className="w-3.5 h-3.5" />
            <span>Flat</span>
          </button>
        </div>

        <div className="flex items-center bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-lg p-1 shadow-lg">
          <button
            type="button"
            onClick={() => handleToggleBasemap("dark")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              basemap === "dark"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
            <span>Dark</span>
          </button>
          <button
            type="button"
            onClick={() => handleToggleBasemap("satellite")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              basemap === "satellite"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Satellite</span>
          </button>
        </div>
      </div>

      {/* Bottom-Left Fire Activity Density Legend */}
      <div className="absolute bottom-3 left-3 z-10 bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-lg px-3 py-2.5 shadow-lg text-xs">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-semibold text-slate-200 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            Fire Density ({hexData.length.toLocaleString()} Active Zones)
          </span>
          {activeSliceLabel && (
            <span className="text-[11px] font-mono text-sky-300 bg-sky-500/10 border border-sky-500/30 px-1.5 py-0.5 rounded">
              {activeSliceLabel}
            </span>
          )}
        </div>
        {dailyStudyAreaOnly && (
          <div className="mb-1.5 max-w-[230px] text-[10px] leading-snug text-amber-300/90">
            Daily view shows Southeast Asia only — elsewhere fires are recorded
            weekly.
          </div>
        )}
        {loading && (
          <div className="mb-1.5 text-[11px] text-amber-400 animate-pulse">
            Updating...
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-400">Low</span>
          <div className="h-2 w-8 rounded-sm bg-yellow-300/90" />
          <div className="h-2 w-8 rounded-sm bg-orange-400/90" />
          <div className="h-2 w-8 rounded-sm bg-red-500/90" />
          <div className="h-2 w-8 rounded-sm bg-rose-600" />
          <span className="text-[10px] text-slate-400">
            High ({maxFires.toLocaleString()} fires)
          </span>
        </div>
      </div>

      {/* Hover Tooltip for Fire Zone or Cluster */}
      {hoveredHex && (
        <div
          className="pointer-events-none absolute z-20 bg-slate-950/95 border border-slate-700 rounded-lg px-3 py-2 text-xs shadow-2xl"
          style={{
            left: Math.min(hoveredHex.x + 14, 380),
            top: Math.max(hoveredHex.y - 74, 12),
          }}
        >
          {"zone_count" in hoveredHex.datum &&
          hoveredHex.datum.zone_count > 1 ? (
            <div className="font-semibold text-[11px] text-amber-400 mb-1 flex items-center justify-between gap-3">
              <span>Regional Fire Cluster</span>
              <span className="text-[10px] text-slate-400 font-mono">
                ({hoveredHex.datum.zone_count} Zones)
              </span>
            </div>
          ) : (
            <div className="font-semibold text-[11px] text-sky-400 mb-1">
              Active Fire Zone
            </div>
          )}
          <div className="flex items-center justify-between gap-4 text-slate-200">
            <span>Total Hotspots:</span>
            <strong className="text-amber-400 font-semibold">
              {hoveredHex.datum.total_fires.toLocaleString()}
            </strong>
          </div>
          <div className="flex items-center justify-between gap-4 text-slate-300">
            <span>Mean Intensity:</span>
            <strong className="text-rose-400 font-semibold">
              {hoveredHex.datum.mean_frp.toFixed(1)} MW
            </strong>
          </div>
          {"zone_count" in hoveredHex.datum &&
            hoveredHex.datum.zone_count > 1 && (
              <div className="mt-1.5 pt-1 border-t border-slate-800 text-[10px] text-sky-400/90 font-medium">
                Click beacon to zoom in
              </div>
            )}
        </div>
      )}
    </div>
  );
};
