import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { StyleSpecification } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
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
  loading: boolean;
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

      // Adaptive sizing: compact, refined pinpoint radii at continental scale
      const isContinental = currentZoom < 4.2;
      const auraMin = isContinental ? 3.5 : 5.0;
      const auraMax = isContinental ? 9.5 : 15.0;
      const coreMin = isContinental ? 2.0 : 2.8;
      const coreMax = isContinental ? 5.0 : 7.0;

      // Pass A: Soft diffuse thermal aura (non-stroked, eliminates overlapping rings)
      layers.push(
        new ScatterplotLayer({
          id: "fire-cluster-aura",
          data: clusteredBeacons,
          pickable: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getPosition: (d: any) => d.position,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getRadius: (d: any) =>
            auraMin +
            Math.sqrt(d.total_fires / maxClusterFires) * (auraMax - auraMin),
          radiusUnits: "pixels",
          radiusMinPixels: auraMin,
          radiusMaxPixels: auraMax,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getFillColor: (d: any) => {
            const [r, g, b] = getFireColor(d.total_fires, maxClusterFires);
            return [r, g, b, Math.round(45 * beaconOpacity)];
          },
          stroked: false,
          updateTriggers: {
            getFillColor: [maxClusterFires, sensorMode, beaconOpacity],
            getRadius: [maxClusterFires, currentZoom],
          },
        })
      );

      // Pass B: High-intensity central core with 1-click zoom
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
          getFillColor: (d: any) => {
            const [r, g, b] = getFireColor(d.total_fires, maxClusterFires);
            return [r, g, b, Math.round(230 * beaconOpacity)];
          },
          stroked: true,
          getLineColor: [255, 255, 255, Math.round(75 * beaconOpacity)],
          lineWidthMinPixels: 1,
          updateTriggers: {
            getFillColor: [maxClusterFires, sensorMode, beaconOpacity],
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
      const h3Layer = new H3HexagonLayer<SpatialHexDatum>({
        id: "h3-fire-hexagons",
        data: hexData,
        pickable: currentZoom >= 6.0,
        wireframe: false,
        filled: true,
        extruded: extruded3D,
        opacity: hexOpacity,
        getHexagon: (d) => d.h3_index,
        getFillColor: (d) => getFireColor(d.total_fires, maxFires),
        getElevation: (d) =>
          extruded3D ? Math.sqrt(d.total_fires / maxFires) * 42000 : 0,
        elevationScale: 1,
        highPrecision: true,
        updateTriggers: {
          getFillColor: [maxFires, sensorMode],
          getElevation: [maxFires, extruded3D],
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
          title="Toggle 3D elevation height for fire activity"
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
          {loading && (
            <span className="text-[11px] text-amber-400 animate-pulse">
              Updating...
            </span>
          )}
        </div>
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
