/**
 * Configuration for the agent pipeline.
 * Centralized settings for image generation and other options.
 */

import { Config, Effect } from 'effect';

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

export type IdeogramMode = 'api' | 'local';
type IdeogramRenderingSpeed = 'TURBO' | 'DEFAULT' | 'QUALITY';
type IdeogramLocalQuantization = 'nf4' | 'fp8';

export interface IdeogramApiImageGenerationConfig {
  provider: 'ideogram';
  mode: 'api';
  model: 'ideogram-v4';
  renderingSpeed: IdeogramRenderingSpeed;
}

export interface IdeogramLocalImageGenerationConfig {
  provider: 'ideogram';
  mode: 'local';
  model: 'ideogram-v4';
  executable: string;
  script: string;
  height: number;
  width: number;
  samplerPreset: string;
  quantization: IdeogramLocalQuantization;
}

export type IdeogramImageGenerationConfig =
  | IdeogramApiImageGenerationConfig
  | IdeogramLocalImageGenerationConfig;

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

export const defaultIdeogramImageConfig: IdeogramApiImageGenerationConfig = {
  provider: 'ideogram',
  mode: 'api',
  model: 'ideogram-v4',
  renderingSpeed: 'DEFAULT',
};

export const defaultImageConfig = defaultGeminiImageConfig;

const imageProviderConfig = Config.literals(
  ['gemini', 'ideogram', 'ideogram-v4'],
  'IMAGE_PROVIDER'
).pipe(
  Config.withDefault('gemini'),
  Config.map((provider): ImageProvider =>
    provider === 'ideogram-v4' ? 'ideogram' : provider
  )
);

const ideogramModeConfig = Config.literals(['api', 'local'], 'IDEOGRAM_MODE').pipe(
  Config.withDefault('api')
);

const ideogramApiImageConfig = Config.all({
  renderingSpeed: Config.literals(['TURBO', 'DEFAULT', 'QUALITY'], 'IDEOGRAM_RENDERING_SPEED').pipe(
    Config.withDefault('DEFAULT')
  ),
}).pipe(
  Config.map(({ renderingSpeed }): IdeogramApiImageGenerationConfig => ({
    provider: 'ideogram',
    mode: 'api',
    model: 'ideogram-v4',
    renderingSpeed,
  }))
);

const ideogramLocalImageConfig = Config.all({
  executable: Config.nonEmptyString('IDEOGRAM_LOCAL_COMMAND').pipe(Config.withDefault('python')),
  script: Config.nonEmptyString('IDEOGRAM_LOCAL_SCRIPT'),
  height: Config.int('IDEOGRAM_LOCAL_HEIGHT').pipe(Config.withDefault(resolutionPx)),
  width: Config.int('IDEOGRAM_LOCAL_WIDTH').pipe(Config.withDefault(resolutionPx)),
  samplerPreset: Config.nonEmptyString('IDEOGRAM_LOCAL_SAMPLER_PRESET').pipe(
    Config.withDefault('V4_QUALITY_48')
  ),
  quantization: Config.literals(['nf4', 'fp8'], 'IDEOGRAM_LOCAL_QUANTIZATION').pipe(
    Config.withDefault('nf4')
  ),
}).pipe(
  Config.map(
    ({
      executable,
      script,
      height,
      width,
      samplerPreset,
      quantization,
    }): IdeogramLocalImageGenerationConfig => ({
      provider: 'ideogram',
      mode: 'local',
      model: 'ideogram-v4',
      executable,
      script,
      height,
      width,
      samplerPreset,
      quantization,
    })
  )
);

export const loadDefaultImageConfig = Effect.fn('Config.loadDefaultImageConfig')(function*() {
  const provider = yield* imageProviderConfig;
  if (provider === 'gemini') {
    return defaultGeminiImageConfig;
  }

  const mode = yield* ideogramModeConfig;
  return mode === 'local'
    ? yield* ideogramLocalImageConfig
    : yield* ideogramApiImageConfig;
});

export function getDefaultImageConfig(): ImageGenerationConfig {
  return Effect.runSync(loadDefaultImageConfig());
}
