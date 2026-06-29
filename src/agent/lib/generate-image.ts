import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { NodeHttpClient } from '@effect/platform-node';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { Effect, Schema } from 'effect';
import * as HttpBody from 'effect/unstable/http/HttpBody';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse';
import type { ImageGenerationConfig } from '../config';
import { getDefaultImageConfig } from '../config';
import type { SpritesheetMetadata } from '../types';
import { generateIdeogramCaption } from '../designer/ideogram-caption';

class ImageGenerationError extends Schema.TaggedErrorClass<ImageGenerationError>()(
  'ImageGenerationError',
  {
    provider: Schema.Literals(['gemini', 'ideogram']),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

class IdeogramImageObject extends Schema.Class<IdeogramImageObject>('IdeogramImageObject')({
  prompt: Schema.String,
  resolution: Schema.String,
  is_image_safe: Schema.Boolean,
  seed: Schema.Number,
  url: Schema.String,
  style_type: Schema.optionalKey(Schema.String),
}) {}

class IdeogramGenerateResponse extends Schema.Class<IdeogramGenerateResponse>(
  'IdeogramGenerateResponse'
)({
  created: Schema.String,
  data: Schema.Array(IdeogramImageObject),
  response_type: Schema.optionalKey(Schema.String),
}) {}

function imageGenerationError(
  provider: ImageGenerationConfig['provider'],
  message: string,
  cause?: unknown
): ImageGenerationError {
  return cause === undefined
    ? ImageGenerationError.make({ provider, message })
    : ImageGenerationError.make({ provider, message, cause });
}

/**
 * Replace white (#FFFFFF) pixels with transparency.
 * Uses a tight tolerance to avoid making white parts of sprites transparent.
 * Relies on black outlines to separate sprites from background.
 */
async function chromaKeyWhite(imageBuffer: Buffer, tolerance = 15): Promise<Buffer> {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Process pixels: RGBA format (4 bytes per pixel)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    // Check if pixel is near white (#FFFFFF)
    const isNearWhite =
      r >= 255 - tolerance &&
      g >= 255 - tolerance &&
      b >= 255 - tolerance;

    if (isNearWhite) {
      // Set alpha to 0 (transparent)
      data[i + 3] = 0;
    }
  }

  // Reconstruct the image with transparency
  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

/**
 * Generate a cache key from prompt + config.
 * Uses SHA256 hash (first 16 chars) to create filesystem-safe filename.
 */
function getCacheKey(prompt: string, config: ImageGenerationConfig): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ prompt, config }))
    .digest('hex')
    .slice(0, 16);
  return `spritesheet-${hash}`;
}

export interface GenerateImageResult {
  path: string;
  cached: boolean;
}

export interface GenerateImageOptions {
  force?: boolean;
  metadata?: SpritesheetMetadata;
}

interface IdeogramImageResult {
  buffer: Buffer;
  prompt: string;
}

/**
 * Generate a spritesheet image using Google's Gemini model.
 *
 * Caching strategy:
 * - Cache key is SHA256(prompt + config)
 * - If cached image exists, returns cached path (unless force=true)
 * - Saves both image and metadata JSON for debugging
 *
 * @param prompt - The image generation prompt
 * @param outputDir - Directory to save the image
 * @param config - Image generation settings
 * @param options - Additional options (force regeneration)
 */
export async function generateSpritesheetImage(
  prompt: string,
  outputDir: string,
  config: ImageGenerationConfig = getDefaultImageConfig(),
  options: GenerateImageOptions = {}
): Promise<GenerateImageResult> {
  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const cacheKey = getCacheKey(prompt, config);
  const imagePath = join(outputDir, `${cacheKey}.png`);
  const metaPath = join(outputDir, `${cacheKey}.meta.json`);

  // Check cache (unless --force)
  if (!options.force && existsSync(imagePath) && existsSync(metaPath)) {
    console.log(`📦 Using cached image: ${imagePath}`);
    return {
      path: imagePath,
      cached: true,
    };
  }

  console.log(`🎨 Generating spritesheet image with ${config.provider}...`);

  // Apply chroma key to replace white background with transparency
  console.log('🔑 Applying chroma key (replacing white with transparency)...');
  const rawBuffer =
    config.provider === 'ideogram'
      ? (await runIdeogramImage(
        options.metadata ? generateIdeogramCaption(options.metadata) : prompt,
        config
      )).buffer
      : await generateGeminiSpritesheetImage(prompt, config);
  const processedBuffer = await chromaKeyWhite(rawBuffer);

  // Save image as PNG with transparency
  writeFileSync(imagePath, processedBuffer);

  // Save metadata for cache validation and debugging
  const metadata = {
    prompt,
    provider: config.provider,
    model: config.model,
    ...(config.provider === 'gemini'
      ? { aspectRatio: config.aspectRatio, imageSize: config.imageSize }
      : { renderingSpeed: config.renderingSpeed }),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

  console.log(`✅ Image saved: ${imagePath}`);

  return {
    path: imagePath,
    cached: false,
  };
}

async function generateGeminiSpritesheetImage(
  prompt: string,
  config: Extract<ImageGenerationConfig, { provider: 'gemini' }>
): Promise<Buffer> {
  const result = await generateText({
    model: google(config.model),
    prompt,
    providerOptions: {
      google: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: config.aspectRatio,
          ...(config.imageSize && { imageSize: config.imageSize }),
        },
      },
    },
  });

  const imageFile = result.files?.find((f) => f.mediaType.startsWith('image/'));
  if (!imageFile) {
    throw imageGenerationError('gemini', 'No image returned from Gemini');
  }

  return Buffer.from(imageFile.uint8Array);
}

const decodeIdeogramResponse = Schema.decodeUnknownEffect(IdeogramGenerateResponse);

const generateIdeogramSpritesheetImage = Effect.fn('Ideogram.generateSpritesheetImage')(function*(
  prompt: string | ReturnType<typeof generateIdeogramCaption>,
  config: Extract<ImageGenerationConfig, { provider: 'ideogram' }>
) {
  const apiKey = process.env.IDEOGRAM_API_KEY;
  if (!apiKey) {
    return yield* Effect.fail(
      imageGenerationError('ideogram', 'IDEOGRAM_API_KEY environment variable is required')
    );
  }

  const formData = new FormData();
  if (typeof prompt === 'string') {
    formData.append('text_prompt', prompt);
  } else {
    formData.append('json_prompt', JSON.stringify(prompt));
  }
  formData.append('rendering_speed', config.renderingSpeed);

  const response = yield* HttpClient.post(
    'https://api.ideogram.ai/v1/ideogram-v4/generate',
    {
      headers: { 'Api-Key': apiKey },
      body: HttpBody.formData(formData),
    }
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.mapError((cause) =>
      imageGenerationError('ideogram', 'Ideogram generate request failed', cause)
    )
  );

  const json = yield* response.json.pipe(
    Effect.mapError((cause) =>
      imageGenerationError('ideogram', 'Ideogram response was not valid JSON', cause)
    )
  );

  const decoded = yield* decodeIdeogramResponse(json).pipe(
    Effect.mapError((cause) =>
      imageGenerationError('ideogram', 'Ideogram response did not match the expected schema', cause)
    )
  );

  const image = decoded.data[0];
  if (!image) {
    return yield* Effect.fail(imageGenerationError('ideogram', 'Ideogram returned no images'));
  }
  if (!image.is_image_safe) {
    return yield* Effect.fail(imageGenerationError('ideogram', 'Ideogram flagged the image as unsafe'));
  }

  const imageResponse = yield* HttpClient.get(image.url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.mapError((cause) =>
      imageGenerationError('ideogram', 'Ideogram image download failed', cause)
    )
  );
  const arrayBuffer = yield* imageResponse.arrayBuffer.pipe(
    Effect.mapError((cause) =>
      imageGenerationError('ideogram', 'Downloaded Ideogram image was unreadable', cause)
    )
  );

  return {
    buffer: Buffer.from(arrayBuffer),
    prompt: image.prompt,
  } satisfies IdeogramImageResult;
});

function runIdeogramImage(
  prompt: string | ReturnType<typeof generateIdeogramCaption>,
  config: Extract<ImageGenerationConfig, { provider: 'ideogram' }>
): Promise<IdeogramImageResult> {
  return Effect.runPromise(
    generateIdeogramSpritesheetImage(prompt, config).pipe(
      Effect.provide(NodeHttpClient.layerFetch)
    )
  );
}
