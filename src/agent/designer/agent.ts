/**
 * Designer Agent (Sequential Phases)
 *
 * Executes sprite design in 2 sequential phases:
 * 1. Scene Phase - Generate detailed scene description from theme
 * 2. Spritesheet Phase - Generate sprite metadata from scene description
 *
 * Architecture Decision:
 * - Sequential chain pattern for predictable execution order
 * - Scene description (free-form text) enables creative expression
 * - Spritesheet phase interprets scene into structured metadata
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { executeScenePhase } from './phases/scene-phase';
import { executeSpritesheetPhase } from './phases/spritesheet-phase';
import { generatePromptFromMetadata } from './prompt-generator';
import { generateSpritesheetImage } from '../lib/generate-image';
import type { SpritesheetMetadata } from '../types';

const DEFAULT_OUTPUT_DIR = 'src/agent/output';

export interface DesignerResult {
  metadata: SpritesheetMetadata;
  prompt: string;
  imagePath: string;
  imageCached: boolean;
  sceneDescription: string;
}

/**
 * Run the Designer Agent with sequential phase execution.
 *
 * @param theme - Visual theme (e.g., "cyberpunk", "medieval", "fantasy village")
 * @param verbose - Enable detailed logging
 * @param outputDir - Directory for output files
 * @returns Complete DesignerResult with metadata, prompt, and image path
 */
export async function runDesignerAgent(
  theme: string,
  verbose = false,
  outputDir = DEFAULT_OUTPUT_DIR
): Promise<DesignerResult> {
  if (verbose) {
    console.log(`[Designer] Starting with theme: "${theme}"`);
  }

  // Phase 1: Generate scene description
  const sceneDescription = await executeScenePhase(theme, verbose);

  if (verbose) {
    console.log(`[Designer] Scene description: ${sceneDescription.length} chars`);
  }

  // Phase 2: Generate sprite metadata from scene
  const metadata = await executeSpritesheetPhase(sceneDescription, verbose);

  if (verbose) {
    console.log(`[Designer] Metadata: ${metadata.sprites.length} sprites`);
  }

  // Generate prompt programmatically from metadata (unchanged)
  const prompt = generatePromptFromMetadata(metadata);

  // Embed scene description in metadata for Planner visual context
  // This enables the Planner to make thematically coherent decisions
  const metadataWithScene: SpritesheetMetadata = {
    ...metadata,
    sceneDescription,
  };

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  // Write outputs
  await writeFile(
    join(outputDir, 'spritesheet-metadata.json'),
    JSON.stringify(metadataWithScene, null, 2),
    'utf-8'
  );
  await writeFile(join(outputDir, 'prompt.md'), prompt, 'utf-8');
  await writeFile(join(outputDir, 'scene-description.md'), sceneDescription, 'utf-8');

  if (verbose) {
    console.log(`[Designer] Output: ${outputDir}/spritesheet-metadata.json`);
    console.log(`[Designer] Output: ${outputDir}/prompt.md`);
    console.log(`[Designer] Output: ${outputDir}/scene-description.md`);
  }

  // Generate the spritesheet image
  if (verbose) {
    console.log(`[Designer] Generating spritesheet image...`);
  }

  const imageResult = await generateSpritesheetImage(prompt, outputDir, undefined, {
    metadata: metadataWithScene,
  });

  if (verbose) {
    if (imageResult.cached) {
      console.log(`[Designer] Using cached image: ${imageResult.path}`);
    } else {
      console.log(`[Designer] Generated image: ${imageResult.path}`);
    }
    console.log('[Designer] Complete!');
  }

  return {
    metadata: metadataWithScene,
    prompt,
    imagePath: imageResult.path,
    imageCached: imageResult.cached,
    sceneDescription,
  };
}
