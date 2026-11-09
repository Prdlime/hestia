import { PresetAOI } from "../types/api";

export const MALAYSIA_PRESET_AOIS: PresetAOI[] = [
  {
    id: "all-malaysia",
    name: "All Malaysia (National Overview)",
    subtitle: "Peninsular Malaysia, Sarawak & Sabah",
    center: [109.2, 3.8],
    zoom: 5.3,
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [99.8, 1.0],
          [119.2, 1.0],
          [119.2, 7.2],
          [99.8, 7.2],
          [99.8, 1.0],
        ],
      ],
    },
  },
  {
    id: "peninsular-malaysia",
    name: "Peninsular Malaysia",
    subtitle: "Pahang, Selangor, Johor & Northern Agricultural Belt",
    center: [102.2, 3.7],
    zoom: 6.6,
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [100.1, 1.3],
          [104.3, 1.3],
          [104.3, 6.4],
          [100.1, 6.4],
          [100.1, 1.3],
        ],
      ],
    },
  },
  {
    id: "pahang-peatlands",
    name: "Pahang Peatlands (Pekan & Rompin)",
    subtitle: "High-intensity Southeast Coast peat swamp forest",
    center: [103.32, 3.22],
    zoom: 8.6,
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [102.95, 2.75],
          [103.65, 2.75],
          [103.65, 3.75],
          [102.95, 3.75],
          [102.95, 2.75],
        ],
      ],
    },
  },
  {
    id: "selangor-peatlands",
    name: "Selangor Peatlands (Kuala Langat & Raja Musa)",
    subtitle: "West Coast peatland reserves & peri-urban fire zone",
    center: [101.52, 3.02],
    zoom: 8.8,
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [101.25, 2.55],
          [101.82, 2.55],
          [101.82, 3.55],
          [101.25, 3.55],
          [101.25, 2.55],
        ],
      ],
    },
  },
  {
    id: "sarawak-coastal",
    name: "Sarawak Coastal Peat Basin (Polygon)",
    subtitle: "Diagonal coastal corridor from Sri Aman & Mukah to Miri/Baram",
    center: [112.55, 2.95],
    zoom: 6.7,
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [110.3, 1.05],
          [111.9, 1.05],
          [114.55, 3.95],
          [114.55, 4.75],
          [113.55, 4.75],
          [111.35, 2.85],
          [110.3, 1.75],
          [110.3, 1.05],
        ],
      ],
    },
  },
  {
    id: "sabah-corridor",
    name: "Sabah (Klias Peninsula & Kinabatangan)",
    subtitle: "West coast Klias wetlands & East coast Kinabatangan basin",
    center: [116.8, 5.45],
    zoom: 7.0,
    polygon: {
      type: "Polygon",
      coordinates: [
        [
          [115.2, 4.95],
          [118.6, 4.95],
          [118.6, 6.05],
          [115.2, 6.05],
          [115.2, 4.95],
        ],
      ],
    },
  },
];
