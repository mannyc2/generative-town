/**
 * Ground Phase
 *
 * Fills the entire map with ground tiles before roads or objects.
 * Uses fillGround tool to fill rectangular regions.
 */

import { streamText, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { Effect } from 'effect';
import type { GridState } from '../../lib/grid-state';
import type { SpritesheetMetadata } from '../../types';
import { createFillGroundTool } from '../tools/fill-ground';
import { createViewMapTool } from '../tools';
import { plannerError } from '../errors';

/**
 * Execute the ground filling phase.
 * Fills 100% of the map with ground tiles using quadrant-based approach.
 */
export const executeGroundPhase = Effect.fn('Planner.GroundPhase')(function*(
  grid: GridState,
  metadata: SpritesheetMetadata,
  width: number,
  height: number,
  verbose: boolean,
  sceneDescription?: string
) {
  if (verbose) yield* Effect.sync(() => console.log('[Ground Phase] Starting...'));

  const tools = {
    fillGround: createFillGroundTool(grid, verbose),
    viewMap: createViewMapTool(grid),
  };

  // Get ground tiles dynamically from metadata (exclude roads which have connectivity.connects)
  const groundSprites = metadata.sprites
    .filter((s) => s.category === 'ground' && (!s.connectivity?.connects?.length))
    .map((s) => s.id);

  if (groundSprites.length === 0) {
    return yield* Effect.fail(plannerError('ground', 'No ground sprites found in metadata'));
  }

  const systemPrompt = buildGroundPrompt(width, height, metadata, sceneDescription);

  yield* Effect.tryPromise({
    try: async () => {
      const result = streamText({
        model: google('gemini-2.0-flash'),
        system: systemPrompt,
        tools,
        stopWhen: stepCountIs(10),
        prompt: `Fill the entire ${width}x${height} map with ground tiles.

First, analyze the available ground sprites listed in your context. Consider:
1. Which tiles best match the scene's primary areas (centers, plazas)?
2. Which tiles work for edges/borders (forest edges, corners)?
3. Any hazardous tiles (water, etc.) to use sparingly?

Then create zones using fillGround calls:
- Think in REGIONS, not individual tiles
- Use different sprites for distinct visual zones
- Ensure 100% coverage (no black void)
- Match the atmosphere in the WORLD VISION

Use viewMap("ground") to verify full coverage.`,
      });
      await result.text;
    },
    catch: (cause) =>
      plannerError('ground', 'Ground phase model/tool execution failed', cause),
  });

  if (verbose) {
    const stats = grid.getStats();
    yield* Effect.sync(() =>
      console.log(`[Ground Phase] Complete: ${stats.groundFilled}/${stats.totalTiles} tiles`)
    );
  }
});

/**
 * Build the system prompt for ground phase.
 * Fully dynamic - all sprite info comes from metadata.
 * Includes visual context from scene description for thematic coherence.
 */
function buildGroundPrompt(
  width: number,
  height: number,
  metadata: SpritesheetMetadata,
  sceneDescription?: string
): string {
  // Extract ground tiles (exclude roads which have connectivity.connects)
  const groundSprites = metadata.sprites.filter(
    (s) => s.category === 'ground' && (!s.connectivity?.connects?.length)
  );

  // Categorize ground tiles for clearer guidance
  const walkable = groundSprites.filter((s) => s.placement.walkable).map((s) => s.id);
  const hazardous = groundSprites.filter((s) => !s.placement.walkable).map((s) => s.id);

  // Format ground tiles list with descriptions
  const groundTilesList = groundSprites
    .map((s) => `  - ${s.id}: ${s.description.substring(0, 60)}`)
    .join('\n');

  // Get first tile for example
  const exampleTile = groundSprites[0]?.id;

  // Build visual context section from scene description
  const visualContext = sceneDescription
    ? `## WORLD VISION (Read this carefully!)
${sceneDescription}

Use this vision to guide your ground placement. Create ZONES that match the atmosphere described above.

`
    : '';

  return `${visualContext}You are filling ground tiles for a ${width}x${height} map.

TOOLS AVAILABLE:
- fillGround(x1, y1, x2, y2, tileId) - Fill rectangular region with ground tile
- viewMap(layer) - View current map state

COORDINATE SYSTEM:
- x: 0 to ${width - 1} (left to right)
- y: 0 to ${height - 1} (top to bottom)
- (0,0) is top-left corner

## GROUND TILE CATEGORIES
- Walkable (main areas): ${walkable.join(', ') || 'none'}
- Hazardous (edges/corners): ${hazardous.join(', ') || 'none'}

## ALL GROUND TILES:
${groundTilesList}

## ZONE-BASED PLACEMENT (IMPORTANT!)
Don't scatter tiles randomly. Create distinct areas:
- **Main zone** (center/front): Clean, inviting ground tiles that match the primary theme
- **Back areas** (edges): Gritty, debris-filled tiles for contrast
- **Danger spots** (corners): Hazardous tiles sparingly for visual interest
- **Transition strips**: Leave space for roads (center strips)

## QUADRANT STRATEGY for ${width}x${height}:
- Top-left: Primary zone (matches main visual theme)
- Top-right: Secondary zone (functional/commercial feel)
- Bottom-left: Back alley zone (gritty/worn)
- Bottom-right: Industrial/danger zone
- Center strips: Reserve for roads (fill with neutral ground)

GOAL: Fill 100% of tiles. Create visual ZONES, not random noise.
Empty cells show as '.' in viewMap and render as BLACK VOID - avoid at all costs.

Example: fillGround(0, 0, 4, 4, "${exampleTile}") fills from (0,0) to (4,4) inclusive.`;
}
