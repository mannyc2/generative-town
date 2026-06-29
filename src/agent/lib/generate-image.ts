import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { createHash } from 'crypto';
import sharp from 'sharp';
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import type * as PlatformError from 'effect/PlatformError';
import * as HttpBody from 'effect/unstable/http/HttpBody';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import type { ImageGenerationConfig } from '../config';
import { loadDefaultImageConfig } from '../config';
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

class ImageConfigurationError extends Schema.TaggedErrorClass<ImageConfigurationError>()(
  'ImageConfigurationError',
  {
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

function imageConfigurationError(message: string, cause?: unknown): ImageConfigurationError {
  return cause === undefined
    ? ImageConfigurationError.make({ message })
    : ImageConfigurationError.make({ message, cause });
}

/**
 * Replace white (#FFFFFF) pixels with transparency.
 * Uses a tight tolerance to avoid making white parts of sprites transparent.
 * Relies on black outlines to separate sprites from background.
 */
const chromaKeyWhite = Effect.fn('Image.chromaKeyWhite')(function*(
  imageBuffer: Buffer,
  provider: ImageGenerationConfig['provider'],
  tolerance = 15
) {
  const { data, info } = yield* Effect.tryPromise({
    try: () => sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    catch: (cause) => imageGenerationError(provider, 'Image post-processing failed', cause),
  });

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
  return yield* Effect.tryPromise({
    try: () => sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer(),
    catch: (cause) => imageGenerationError(provider, 'Image post-processing failed', cause),
  });
});

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

type IdeogramPrompt = string | ReturnType<typeof generateIdeogramCaption>;

function ideogramPromptText(prompt: IdeogramPrompt): string {
  return typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
}

function imageMetadata(
  prompt: string,
  config: ImageGenerationConfig,
  generatedAt: string
): Record<string, unknown> {
  if (config.provider === 'gemini') {
    return {
      prompt,
      provider: config.provider,
      model: config.model,
      aspectRatio: config.aspectRatio,
      imageSize: config.imageSize,
      generatedAt,
    };
  }

  if (config.mode === 'api') {
    return {
      prompt,
      provider: config.provider,
      mode: config.mode,
      model: config.model,
      renderingSpeed: config.renderingSpeed,
      generatedAt,
    };
  }

  return {
    prompt,
    provider: config.provider,
    mode: config.mode,
    model: config.model,
    height: config.height,
    width: config.width,
    samplerPreset: config.samplerPreset,
    quantization: config.quantization,
    generatedAt,
  };
}

/**
 * Generate a spritesheet image using the configured image provider.
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
  config?: ImageGenerationConfig,
  options: GenerateImageOptions = {}
): Promise<GenerateImageResult> {
  return Effect.runPromise(
    generateSpritesheetImageEffect(prompt, outputDir, config, options).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch))
    )
  );
}

const generateSpritesheetImageEffect = Effect.fn('Image.generateSpritesheet')(function*(
  prompt: string,
  outputDir: string,
  config: ImageGenerationConfig | undefined,
  options: GenerateImageOptions
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedConfig = config ?? (yield* loadDefaultImageConfig().pipe(
    Effect.mapError((cause) =>
      imageConfigurationError('Image generation configuration is invalid', cause)
    )
  ));

  yield* fs.makeDirectory(outputDir, { recursive: true }).pipe(
    Effect.mapError((cause) =>
      imageGenerationError(resolvedConfig.provider, 'Could not create image output directory', cause)
    )
  );

  const cacheKey = getCacheKey(prompt, resolvedConfig);
  const imagePath = path.join(outputDir, `${cacheKey}.png`);
  const metaPath = path.join(outputDir, `${cacheKey}.meta.json`);
  const [hasImage, hasMeta] = yield* Effect.all([
    fs.exists(imagePath),
    fs.exists(metaPath),
  ]).pipe(
    Effect.mapError((cause) =>
      imageGenerationError(resolvedConfig.provider, 'Could not inspect image cache', cause)
    )
  );

  if (!options.force && hasImage && hasMeta) {
    yield* Console.log(`📦 Using cached image: ${imagePath}`);
    return {
      path: imagePath,
      cached: true,
    };
  }

  const providerLabel = resolvedConfig.provider === 'ideogram'
    ? `ideogram:${resolvedConfig.mode}`
    : resolvedConfig.provider;
  yield* Console.log(`🎨 Generating spritesheet image with ${providerLabel}...`);

  const rawBuffer = yield* generateRawSpritesheetImage(
    prompt,
    outputDir,
    cacheKey,
    resolvedConfig,
    options
  );

  yield* Console.log('🔑 Applying chroma key (replacing white with transparency)...');
  const processedBuffer = yield* chromaKeyWhite(rawBuffer, resolvedConfig.provider);

  yield* fs.writeFile(imagePath, processedBuffer).pipe(
    Effect.mapError((cause) =>
      imageGenerationError(resolvedConfig.provider, 'Could not write spritesheet image', cause)
    )
  );

  const generatedAt = yield* Effect.sync(() => new Date().toISOString());
  yield* fs.writeFileString(
    metaPath,
    JSON.stringify(imageMetadata(prompt, resolvedConfig, generatedAt), null, 2)
  ).pipe(
    Effect.mapError((cause) =>
      imageGenerationError(resolvedConfig.provider, 'Could not write spritesheet metadata', cause)
    )
  );

  yield* Console.log(`✅ Image saved: ${imagePath}`);
  return {
    path: imagePath,
    cached: false,
  };
});

const generateRawSpritesheetImage = Effect.fn('Image.generateRawSpritesheet')(function*(
  prompt: string,
  outputDir: string,
  cacheKey: string,
  config: ImageGenerationConfig,
  options: GenerateImageOptions
) {
  if (config.provider === 'gemini') {
    return yield* generateGeminiSpritesheetImage(prompt, config);
  }

  return yield* generateIdeogramSpritesheetImage(
    options.metadata ? generateIdeogramCaption(options.metadata) : prompt,
    outputDir,
    cacheKey,
    config
  ).pipe(Effect.map((result) => result.buffer));
});

const generateGeminiSpritesheetImage = Effect.fn('Gemini.generateSpritesheetImage')(function*(
  prompt: string,
  config: Extract<ImageGenerationConfig, { provider: 'gemini' }>
) {
  const result = yield* Effect.tryPromise({
    try: () => generateText({
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
    }),
    catch: (cause) => imageGenerationError('gemini', 'Gemini image generation failed', cause),
  });

  const imageFile = result.files?.find((f) => f.mediaType.startsWith('image/'));
  if (!imageFile) {
    return yield* Effect.fail(imageGenerationError('gemini', 'No image returned from Gemini'));
  }

  return Buffer.from(imageFile.uint8Array);
});

const decodeIdeogramResponse = Schema.decodeUnknownEffect(IdeogramGenerateResponse);
const ideogramApiKeyConfig = Config.redacted('IDEOGRAM_API_KEY');

const generateIdeogramSpritesheetImage = Effect.fn('Ideogram.generateSpritesheetImage')(function*(
  prompt: IdeogramPrompt,
  outputDir: string,
  cacheKey: string,
  config: Extract<ImageGenerationConfig, { provider: 'ideogram' }>
) {
  if (config.mode === 'local') {
    return yield* generateLocalIdeogramSpritesheetImage(prompt, outputDir, cacheKey, config);
  }

  return yield* generateHostedIdeogramSpritesheetImage(prompt, config);
});

const generateHostedIdeogramSpritesheetImage = Effect.fn('Ideogram.generateHostedSpritesheetImage')(function*(
  prompt: IdeogramPrompt,
  config: Extract<ImageGenerationConfig, { provider: 'ideogram'; mode: 'api' }>
) {
  const apiKey = yield* ideogramApiKeyConfig.pipe(
    Effect.mapError((cause) =>
      imageGenerationError(
        'ideogram',
        'IDEOGRAM_API_KEY environment variable is required when IDEOGRAM_MODE=api',
        cause
      )
    )
  );

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
      headers: { 'Api-Key': Redacted.value(apiKey) },
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

function localIdeogramArgs(
  prompt: string,
  outputPath: string,
  config: Extract<ImageGenerationConfig, { provider: 'ideogram'; mode: 'local' }>
): ReadonlyArray<string> {
  return [
    config.script,
    '--prompt',
    prompt,
    '--output',
    outputPath,
    '--height',
    String(config.height),
    '--width',
    String(config.width),
    '--sampler-preset',
    config.samplerPreset,
    '--quantization',
    config.quantization,
    '--no-magic-prompt',
  ];
}

const decodeByteStream = Effect.fn('ChildProcess.decodeByteStream')(function*(
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
) {
  const chunks = yield* Stream.runCollect(stream);
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder('utf-8').decode(bytes).trim();
});

const generateLocalIdeogramSpritesheetImage = Effect.fn('Ideogram.generateLocalSpritesheetImage')(function*(
  prompt: IdeogramPrompt,
  outputDir: string,
  cacheKey: string,
  config: Extract<ImageGenerationConfig, { provider: 'ideogram'; mode: 'local' }>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const promptText = ideogramPromptText(prompt);
  const rawImagePath = path.join(outputDir, `${cacheKey}.ideogram.raw.png`);
  const promptPath = path.join(outputDir, `${cacheKey}.ideogram.prompt.json`);

  yield* fs.writeFileString(promptPath, promptText).pipe(
    Effect.mapError((cause) =>
      imageGenerationError('ideogram', 'Could not write local Ideogram prompt file', cause)
    )
  );

  const run = Effect.gen(function*() {
    const handle = yield* ChildProcess.make(
      config.executable,
      localIdeogramArgs(promptText, rawImagePath, config)
    );
    const [stdout, stderr, exitCode] = yield* Effect.all([
      decodeByteStream(handle.stdout),
      decodeByteStream(handle.stderr),
      handle.exitCode,
    ], { concurrency: 'unbounded' });

    return { stdout, stderr, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => imageGenerationError('ideogram', 'Local Ideogram command failed to run', cause))
  );

  const { stdout, stderr, exitCode } = yield* run;
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.fail(
      imageGenerationError(
        'ideogram',
        `Local Ideogram command exited with code ${exitCode}: ${stderr || stdout || 'no output'}`
      )
    );
  }

  const bytes = yield* fs.readFile(rawImagePath).pipe(
    Effect.mapError((cause) =>
      imageGenerationError('ideogram', 'Local Ideogram did not produce a readable image', cause)
    )
  );

  return {
    buffer: Buffer.from(bytes),
    prompt: promptText,
  } satisfies IdeogramImageResult;
});
