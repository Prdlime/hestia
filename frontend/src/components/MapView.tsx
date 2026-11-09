import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { StyleSpecification } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import {
  Box,
  Check,
  Compass,
  Globe,
  Layers,
  MousePointer,
  Pentagon,
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
    "carto-labels": {
      type: "raster",
      tiles: [
        "https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
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
      id: "carto-labels-layer",
      type: "raster",
      source: "carto-labels",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

type DrawMode = "none" | "bbox" | "polygon";

interface MapViewProps {
  hexData: SpatialHexDatum[];
  aoi: GeoJSONPolygon;
  onChangeAoi: (newAoi: GeoJSONPolygon, customLabel?: string) => void;
  sensorMode: SensorMode;
  flyToTarget: { center: [number, number]; zoom: number; seq: number } | null;
  activeWeekRange: { start: string; end: string } | null;
  onClearWeekFilter: () => void;
  loading: boolean;
}

function getFireColor(
  fires: number,
  maxFires: number
): [number, number, number, number] {
  const ratio = Math.min(1, Math.sqrt(fires / Math.max(1, maxFires * 0.75)));
  if (ratio < 0.25) {
    // Warm amber yellow
    return [253, 224, 71, 200];
  } else if (ratio < 0.5) {
    // Bright orange
    return [251, 146, 60, 215];
  } else if (ratio < 0.75) {
    // Deep flame orange-red
    return [239, 68, 68, 230];
  } else {
    // Intense crimson-magenta core
    return [225, 29, 72, 245];
  }
}

export const MapView: React.FC<MapViewProps> = ({
  hexData,
  aoi,
  onChangeAoi,
  sensorMode,
  flyToTarget,
  activeWeekRange,
  onClearWeekFilter,
  loading,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);

  const [basemap, setBasemap] = useState<"dark" | "satellite">("dark");
  const [extruded3D, setExtruded3D] = useState<boolean>(true);
  const [drawMode, setDrawMode] = useState<DrawMode>("none");
  const [draftVertices, setDraftVertices] = useState<[number, number][]>([]);
  const [cursorLonLat, setCursorLonLat] = useState<[number, number] | null>(
    null
  );
  const [hoveredHex, setHoveredHex] = useState<{
    datum: SpatialHexDatum;
    x: number;
    y: number;
  } | null>(null);

  // Refs for latest drawing state inside MapLibre event listeners
  const drawModeRef = useRef<DrawMode>(drawMode);
  drawModeRef.current = drawMode;
  const draftVerticesRef = useRef<[number, number][]>(draftVertices);
  draftVerticesRef.current = draftVertices;

  const maxFires = useMemo(() => {
    if (!hexData.length) return 100;
    return Math.max(...hexData.map((d) => d.total_fires), 10);
  }, [hexData]);

  // Initialize MapLibre GL + Deck.gl MapboxOverlay
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: DARK_MATTER_STYLE,
      center: [109.2, 3.8],
      zoom: 5.3,
      pitch: 36,
      bearing: 0,
      attributionControl: false,
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

    map.on("mousemove", (e) => {
      if (drawModeRef.current !== "none") {
        setCursorLonLat([
          Number(e.lngLat.lng.toFixed(4)),
          Number(e.lngLat.lat.toFixed(4)),
        ]);
      }
    });

    map.on("click", (e) => {
      const mode = drawModeRef.current;
      if (mode === "none") return;

      const pt: [number, number] = [
        Number(e.lngLat.lng.toFixed(4)),
        Number(e.lngLat.lat.toFixed(4)),
      ];
      const currentPts = draftVerticesRef.current;

      if (mode === "bbox") {
        if (currentPts.length === 0) {
          setDraftVertices([pt]);
        } else {
          const [lon1, lat1] = currentPts[0];
          const [lon2, lat2] = pt;
          const minLon = Math.min(lon1, lon2);
          const maxLon = Math.max(lon1, lon2);
          const minLat = Math.min(lat1, lat2);
          const maxLat = Math.max(lat1, lat2);
          if (maxLon - minLon > 0.01 && maxLat - minLat > 0.01) {
            onChangeAoi(
              {
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
              },
              `Custom Bounding Box (${minLat.toFixed(2)}°N, ${minLon.toFixed(2)}°E)`
            );
          }
          setDraftVertices([]);
          setCursorLonLat(null);
          setDrawMode("none");
        }
      } else if (mode === "polygon") {
        setDraftVertices([...currentPts, pt]);
      }
    });

    mapRef.current = map;
    deckOverlayRef.current = overlay;

    return () => {
      map.remove();
      mapRef.current = null;
      deckOverlayRef.current = null;
    };
  }, [onChangeAoi]);

  // Fly to preset AOI when selected
  useEffect(() => {
    if (!mapRef.current || !flyToTarget) return;
    mapRef.current.flyTo({
      center: flyToTarget.center,
      zoom: flyToTarget.zoom,
      pitch: extruded3D ? 36 : 0,
      duration: 1300,
    });
  }, [flyToTarget, extruded3D]);

  // Toggle basemap style
  const handleToggleBasemap = (target: "dark" | "satellite") => {
    setBasemap(target);
    if (!mapRef.current) return;
    mapRef.current.setStyle(
      target === "dark" ? DARK_MATTER_STYLE : SATELLITE_STYLE
    );
  };

  // Toggle 3D Extrusion & camera pitch
  const handleToggle3D = () => {
    const next = !extruded3D;
    setExtruded3D(next);
    if (mapRef.current) {
      mapRef.current.easeTo({ pitch: next ? 38 : 0, duration: 600 });
    }
  };

  // Complete freeform polygon drawing
  const handleFinishPolygon = () => {
    if (draftVertices.length >= 3) {
      const closedRing = [...draftVertices, draftVertices[0]];
      onChangeAoi(
        {
          type: "Polygon",
          coordinates: [closedRing],
        },
        `Custom Polygon (${draftVertices.length} vertices)`
      );
    }
    setDraftVertices([]);
    setCursorLonLat(null);
    setDrawMode("none");
  };

  const handleCancelDraw = () => {
    setDraftVertices([]);
    setCursorLonLat(null);
    setDrawMode("none");
  };

  // Compute preview polygon while drawing
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

  // Update Deck.gl layers whenever data, AOI, or drawing state changes
  useEffect(() => {
    if (!deckOverlayRef.current) return;

    const aoiLayer = new PolygonLayer({
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
    });

    const h3Layer = new H3HexagonLayer<SpatialHexDatum>({
      id: "h3-fire-hexagons",
      data: hexData,
      pickable: true,
      wireframe: false,
      filled: true,
      extruded: extruded3D,
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
        if (info.object && typeof info.x === "number" && typeof info.y === "number") {
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layers: any[] = [aoiLayer, h3Layer];

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
  }, [hexData, aoi, extruded3D, maxFires, sensorMode, draftPolygonCoords, draftVertices]);

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden border border-slate-800 bg-slate-900 shadow-2xl">
      {/* MapLibre Canvas Container */}
      <div
        ref={mapContainerRef}
        className={`w-full h-full ${
          drawMode !== "none" ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"
        }`}
      />

      {/* Top-Left Map Toolbar: AOI Drawing Tools */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
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
            title="Draw Rectangular Bounding Box AOI"
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
            title="Draw Freeform Polygon AOI"
          >
            <Pentagon className="w-3.5 h-3.5" />
            <span>Draw Polygon</span>
          </button>
        </div>

        {/* Interactive Drawing Instructions Pill */}
        {drawMode !== "none" && (
          <div className="flex items-center gap-2 bg-amber-950/90 backdrop-blur-md border border-amber-500/60 text-amber-200 px-3 py-1.5 rounded-lg text-xs shadow-lg">
            {drawMode === "bbox" ? (
              <span>
                {draftVertices.length === 0
                  ? "Click first corner on the map..."
                  : "Click opposite corner to finish Bounding Box"}
              </span>
            ) : (
              <span>
                Click map to add vertices ({draftVertices.length} pts)
              </span>
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
              className="text-amber-300 hover:text-white p-0.5"
              title="Cancel Drawing"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Top-Right Map Controls: Basemap & 3D Extrusion Toggle */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={handleToggle3D}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border backdrop-blur-md shadow-lg transition-colors ${
            extruded3D
              ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
              : "bg-slate-900/90 border-slate-700/80 text-slate-300 hover:text-white"
          }`}
          title="Toggle 3D H3 Hexagon Extrusion"
        >
          <Box className="w-3.5 h-3.5" />
          <span>{extruded3D ? "3D Hex" : "2D Flat"}</span>
        </button>

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

      {/* Active Calendar Week Filter Banner on Map */}
      {activeWeekRange && (
        <div className="absolute top-14 left-3 z-10 flex items-center gap-2.5 bg-rose-950/90 backdrop-blur-md border border-rose-500/60 text-rose-100 px-3 py-1.5 rounded-lg text-xs shadow-xl">
          <span className="inline-block w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
          <span>
            Map Filtered to Calendar Week:{" "}
            <strong className="font-semibold text-white">
              {activeWeekRange.start} → {activeWeekRange.end}
            </strong>
          </span>
          <button
            type="button"
            onClick={onClearWeekFilter}
            className="flex items-center gap-1 bg-rose-800/80 hover:bg-rose-700 text-white px-2 py-0.5 rounded font-medium transition-colors"
          >
            <X className="w-3 h-3" />
            Reset to Full Range
          </button>
        </div>
      )}

      {/* Bottom-Left H3 Fire Density Legend & Stats */}
      <div className="absolute bottom-3 left-3 z-10 bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-lg px-3 py-2.5 shadow-lg text-xs">
        <div className="flex items-center justify-between gap-4 mb-1.5">
          <span className="font-semibold text-slate-200 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            H3 Res-8 Grid ({hexData.length.toLocaleString()} Active Cells)
          </span>
          {loading && (
            <span className="text-[11px] text-amber-400 animate-pulse">
              Querying DuckDB...
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

      {/* Hover Tooltip for H3 Hexagon */}
      {hoveredHex && (
        <div
          className="pointer-events-none absolute z-20 bg-slate-950/95 border border-slate-700 rounded-lg px-3 py-2 text-xs shadow-2xl"
          style={{
            left: Math.min(hoveredHex.x + 14, 380),
            top: Math.max(hoveredHex.y - 76, 12),
          }}
        >
          <div className="font-mono text-[11px] text-sky-400 mb-1">
            H3: {hoveredHex.datum.h3_index}
          </div>
          <div className="flex items-center justify-between gap-4 text-slate-200">
            <span>Total Hotspots:</span>
            <strong className="text-amber-400 font-semibold">
              {hoveredHex.datum.total_fires.toLocaleString()}
            </strong>
          </div>
          <div className="flex items-center justify-between gap-4 text-slate-300">
            <span>Mean FRP:</span>
            <strong className="text-rose-400 font-semibold">
              {hoveredHex.datum.mean_frp.toFixed(1)} MW
            </strong>
          </div>
        </div>
      )}
    </div>
  );
};
