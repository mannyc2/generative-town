import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { runDesignerAgent } from './designer/agent';
import { runPlannerAgent } from './planner/agent';
import { SpritesheetMetadataSchema, MapSchema } from './types';
import { getImageProviderFromEnv } from './config';

/**
 * Agent Pipeline for Generative Town (Simplified)
 *
 * SPRITESHEET GENERATION (one command):
 *
 * 1. Designer Agent (ONE generateObject call)
 *    - Input: Theme
 *    - Output: spritesheet-metadata.json + prompt.md + spritesheet image
 *
 * MAP LAYOUT (separate concern, not implemented yet):
 *
 * 2. Render - requires map.json (from separate step)
 *
 * Usage:
 *   npx tsx src/agent/index.ts design cyberpunk
 *   npx tsx src/agent/index.ts render
 */

const DEFAULT_OUTPUT_DIR = 'src/agent/output';
const METADATA_PATH = `${DEFAULT_OUTPUT_DIR}/spritesheet-metadata.json`;
const MAP_PATH = `${DEFAULT_OUTPUT_DIR}/map.json`;

interface PipelineOptions {
  verbose?: boolean;
  outputDir?: string;
  force?: boolean;
}

/**
 * Find the most recent spritesheet image in the output directory.
 */
async function findSpritesheetImage(outputDir: string): Promise<string | null> {
  const possibleNames = ['spritesheet.png', 'spritesheet.jpeg', 'spritesheet.jpg'];

  const { readdirSync, statSync } = await import('fs');
  try {
    const files = readdirSync(outputDir);
    const spritesheetFiles = files
      .filter(f => f.startsWith('spritesheet-') && (f.endsWith('.png') || f.endsWith('.jpeg')))
      .map(f => ({
        name: f,
        mtime: statSync(join(outputDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (spritesheetFiles.length > 0) {
      const newest = spritesheetFiles[0];
      if (newest) {
        return join(outputDir, newest.name);
      }
    }
  } catch {
    // Directory doesn't exist
  }

  for (const name of possibleNames) {
    const path = join(outputDir, name);
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
// Design Command (creates metadata + prompt + image in ONE step)
// ─────────────────────────────────────────────────────────────────

async function design(theme: string, options: PipelineOptions = {}) {
  const { verbose = false, outputDir = DEFAULT_OUTPUT_DIR } = options;

  console.log(`\n🎨 Generating spritesheet for theme "${theme}"\n`);

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.error('❌ Error: GOOGLE_GENERATIVE_AI_API_KEY environment variable is required for metadata generation');
    process.exit(1);
  }
  if (getImageProviderFromEnv() === 'ideogram' && !process.env.IDEOGRAM_API_KEY) {
    console.error('❌ Error: IDEOGRAM_API_KEY environment variable is required when IMAGE_PROVIDER=ideogram');
    process.exit(1);
  }

  const result = await runDesignerAgent(theme, verbose, outputDir);

  console.log('\n✅ Spritesheet generation complete!');
  console.log(`   Sprites: ${result.metadata.sprites.length}`);
  console.log(`   Theme: ${result.metadata.theme.substring(0, 80)}...`);
  console.log(`   Metadata: ${outputDir}/spritesheet-metadata.json`);
  console.log(`   Prompt: ${outputDir}/prompt.md`);

  if (result.imageCached) {
    console.log(`   Image: ${result.imagePath} (cached)`);
  } else {
    console.log(`   Image: ${result.imagePath}`);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────
// Render Command (requires map.json - from separate map layout step)
// ─────────────────────────────────────────────────────────────────

async function render(options: PipelineOptions = {}) {
  const { outputDir = DEFAULT_OUTPUT_DIR } = options;

  console.log(`\n🖼️  Rendering map to image\n`);

  if (!existsSync(MAP_PATH)) {
    console.error(`❌ Error: Could not find ${MAP_PATH}`);
    console.error('   Map layout is a separate concern. Create map.json first.');
    process.exit(1);
  }

  const { renderMap } = await import('./lib/render-map');

  const mapRaw = await readFile(MAP_PATH, 'utf-8');
  const map = MapSchema.parse(JSON.parse(mapRaw));

  const metadataRaw = await readFile(METADATA_PATH, 'utf-8');
  const metadata = SpritesheetMetadataSchema.parse(JSON.parse(metadataRaw));

  const spritesheetPath = await findSpritesheetImage(outputDir);
  if (!spritesheetPath) {
    console.error('❌ Error: No spritesheet image found');
    process.exit(1);
  }

  const outputPath = `${outputDir}/map-render.png`;
  const result = await renderMap(map, metadata, spritesheetPath, outputPath, {
    scale: 0.25,
  });

  console.log('\n✅ Render complete!');
  console.log(`   Output: ${result.path}`);
  console.log(`   Dimensions: ${result.width}x${result.height}px`);

  return result;
}

// ─────────────────────────────────────────────────────────────────
// Plan Command (runs planner + render)
// ─────────────────────────────────────────────────────────────────

async function plan(options: PipelineOptions = {}) {
  const { verbose = false, outputDir = DEFAULT_OUTPUT_DIR } = options;

  console.log(`\n🗺️  Running Planner Agent (AI-driven)\n`);

  if (!existsSync(METADATA_PATH)) {
    console.error(`❌ Error: Could not find ${METADATA_PATH}`);
    console.error('   Run "design <theme>" first to generate spritesheet metadata.');
    process.exit(1);
  }

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.error('❌ Error: GOOGLE_GENERATIVE_AI_API_KEY environment variable is required');
    process.exit(1);
  }

  // Load metadata
  const metadataRaw = await readFile(METADATA_PATH, 'utf-8');
  const metadata = SpritesheetMetadataSchema.parse(JSON.parse(metadataRaw));

  if (verbose) {
    console.log(`[Planner] Loaded ${metadata.sprites.length} sprites from metadata`);
  }

  // Run AI-driven planner
  const map = await runPlannerAgent(metadata, undefined, undefined, verbose);

  // Save map.json
  await writeFile(MAP_PATH, JSON.stringify(map, null, 2), 'utf-8');
  console.log(`✅ Map generated: ${MAP_PATH}`);
  console.log(`   Size: ${map.width}x${map.height} tiles`);

  // Auto-render
  console.log('\n🖼️  Auto-rendering map...\n');
  await render(options);

  return map;
}

// ─────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
Usage:
  npx tsx src/agent/index.ts <command> [args] [options]

Commands:
  design <theme>              Generate spritesheet (metadata + prompt + image)
                              Example: design cyberpunk
                              Example: design "medieval fantasy village"

  plan                        Run planner to generate map.json + auto-render
                              (Requires spritesheet-metadata.json from design)

  render                      Render map.json to PNG image
                              (Requires map.json + metadata + spritesheet)

Options:
  --verbose, -v               Show detailed output

Environment:
  GOOGLE_GENERATIVE_AI_API_KEY      Required for Gemini metadata/planner operations.
  IMAGE_PROVIDER                    Optional: gemini (default) or ideogram for spritesheet image generation.
  IDEOGRAM_API_KEY                  Required only when IMAGE_PROVIDER=ideogram.
`);
}

function parseArgs(rawArgs: string[]): { args: string[]; options: PipelineOptions } {
  const options: PipelineOptions = {};
  const args: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--output' || arg === '-o') {
      const nextArg = rawArgs[++i];
      if (!nextArg || nextArg.startsWith('-')) {
        console.error('❌ Error: --output requires a directory path');
        process.exit(1);
      }
      options.outputDir = nextArg;
    } else if (arg && !arg.startsWith('-')) {
      args.push(arg);
    } else if (arg) {
      console.error(`❌ Error: Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  return { args, options };
}

async function main() {
  const [, , command, ...rawArgs] = process.argv;
  const { args, options } = parseArgs(rawArgs);

  switch (command) {
    case 'design': {
      const theme = args[0] || 'cyberpunk';
      await design(theme, options);
      break;
    }

    case 'plan':
      await plan(options);
      break;

    case 'render':
      await render(options);
      break;

    case undefined:
    case '':
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});

// Re-export for programmatic use
export { runDesignerAgent } from './designer/agent';
export { runPlannerAgent } from './planner/agent';
export { renderMap, renderMapFromFiles } from './lib/render-map';
export * from './types';
