/**
 * Configuration for the agent pipeline.
 * Centralized settings for image generation and other options.
 */

// ─────────────────────────────────────────────────────────────────
// Resolution Configuration
// Gemini outputs fixed resolutions: 1K (1024px), 2K (2048px), 4K (4096px)
// ─────────────────────────────────────────────────────────────────
export type ImageResolution = '1K' | '2K' | '4K';

export const RESOLUTION_PIXELS: Record<ImageResolution, number> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

// ─────────────────────────────────────────────────────────────────
// Grid Configuration (Primary Settings)
// Set resolution and tileSize - columns/rows are derived automatically
// ─────────────────────────────────────────────────────────────────
export const GRID_CONFIG = {
  /** Gemini output resolution - determines total canvas size */
  resolution: '2K' as ImageResolution,
  /** Desired tile size in pixels - must divide evenly into resolution */
  tileSize: 256,
} as const;

// ─────────────────────────────────────────────────────────────────
// Derived Configuration (Computed at module load)
// These values are calculated from GRID_CONFIG to ensure consistency
// ─────────────────────────────────────────────────────────────────
const resolutionPx = RESOLUTION_PIXELS[GRID_CONFIG.resolution];
const columns = resolutionPx / GRID_CONFIG.tileSize;

// Validate configuration at startup
if (!Number.isInteger(columns)) {
  throw new Error(
    `Invalid config: ${GRID_CONFIG.resolution} (${resolutionPx}px) is not evenly divisible by tileSize ${GRID_CONFIG.tileSize}px. ` +
    `Result would be ${columns} columns. Choose a tileSize that divides evenly (e.g., 128, 256, 512).`
  );
}

export const DERIVED_CONFIG = {
  /** Resolution in pixels */
  resolutionPx,
  /** Number of columns (derived: resolution / tileSize) */
  columns,
  /** Number of rows (same as columns for square grid) */
  rows: columns,
  /** Total tiles in the grid */
  totalTiles: columns * columns,
} as const;

// Default map dimensions (width × height in tiles)
export const DEFAULT_MAP_SIZE = 10;

export type ImageProvider = 'gemini' | 'ideogram';

// Gemini image models support more aspect ratios
type GeminiAspectRatio =
  | '1:1'
  | '2:3'
  | '3:2'
  | '3:4'
  | '4:3'
  | '4:5'
  | '5:4'
  | '9:16'
  | '16:9'
  | '21:9';

// Gemini 3 Pro supports higher resolution output
type GeminiImageSize = '1K' | '2K' | '4K';

export interface GeminiImageGenerationConfig {
  provider: 'gemini';
  model: 'gemini-2.5-flash-image-preview' | 'gemini-3-pro-image-preview';
  aspectRatio: GeminiAspectRatio;
  imageSize?: GeminiImageSize;
}

export interface IdeogramImageGenerationConfig {
  provider: 'ideogram';
  model: 'ideogram-v4';
  renderingSpeed: 'TURBO' | 'DEFAULT' | 'QUALITY';
}

export type ImageGenerationConfig =
  | GeminiImageGenerationConfig
  | IdeogramImageGenerationConfig;

export const defaultGeminiImageConfig: GeminiImageGenerationConfig = {
  provider: 'gemini',
  // Gemini 3 Pro for higher quality image generation
  model: 'gemini-3-pro-image-preview',
  // Sprite sheets must be square
  aspectRatio: '1:1',
  // Use resolution from GRID_CONFIG for consistency
  imageSize: GRID_CONFIG.resolution,
};

export const defaultIdeogramImageConfig: IdeogramImageGenerationConfig = {
  provider: 'ideogram',
  model: 'ideogram-v4',
  renderingSpeed: 'DEFAULT',
};

export const defaultImageConfig = defaultGeminiImageConfig;

export function getImageProviderFromEnv(): ImageProvider {
  const provider = process.env.IMAGE_PROVIDER?.toLowerCase();
  return provider === 'ideogram' || provider === 'ideogram-v4' ? 'ideogram' : 'gemini';
}

export function getDefaultImageConfig(): ImageGenerationConfig {
  return getImageProviderFromEnv() === 'ideogram'
    ? defaultIdeogramImageConfig
    : defaultGeminiImageConfig;
}
