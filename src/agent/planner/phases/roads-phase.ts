/**
 * Roads Phase
 *
 * Builds the road network on top of existing ground tiles.
 * Uses placeRoad tool with exact sprite IDs based on connectivity.
 */

import { streamText, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { Effect } from 'effect';
import type { GridState } from '../../lib/grid-state';
import type { Direction, SpritesheetMetadata, Sprite } from '../../types';
import { createPlaceRoadTool } from '../tools/place-road';
import { createConnectRoadsTool } from '../tools/connect-roads';
import { createViewMapTool } from '../tools';
import { plannerError } from '../errors';

/**
 * Execute the road building phase.
 * Places roads using exact sprite IDs with connectivity validation.
 */
export const executeRoadsPhase = Effect.fn('Planner.RoadsPhase')(function*(
  grid: GridState,
  metadata: SpritesheetMetadata,
  width: number,
  height: number,
  verbose: boolean,
  sceneDescription?: string
) {
  if (verbose) yield* Effect.sync(() => console.log('[Roads Phase] Starting...'));

  const maxRoadTiles = Math.floor(width * height * 0.25);
  const roadSprites = getRoadSprites(metadata);

  if (roadSprites.length === 0) {
    return yield* Effect.fail(plannerError('roads', 'No road sprites found in metadata'));
  }

  const tools = {
    placeRoad: createPlaceRoadTool(grid, maxRoadTiles, verbose),
    connectRoads: createConnectRoadsTool(grid, verbose),
    viewMap: createViewMapTool(grid),
  };

  const systemPrompt = buildRoadsPrompt(
    width,
    height,
    metadata,
    roadSprites,
    maxRoadTiles,
    sceneDescription
  );

  yield* Effect.tryPromise({
    try: async () => {
      const result = streamText({
        model: google('gemini-2.0-flash'),
        system: systemPrompt,
        tools,
        stopWhen: stepCountIs(25),
        prompt: `Build a connected road network on the ${width}x${height} map.

Create roads that divide the map into distinct zones.
Use connectRoads at the end to auto-fix any connectivity issues.`,
      });
      await result.text;
    },
    catch: (cause) =>
      plannerError('roads', 'Roads phase model/tool execution failed', cause),
  });

  if (verbose) {
    const connectivity = grid.validateRoadConnectivity();
    yield* Effect.sync(() =>
      console.log(
        `[Roads Phase] Complete: ${connectivity.totalRoadTiles} tiles, connected=${connectivity.connected}`
      )
    );
  }
});

/**
 * Infer road layout style from scene description or theme.
 * Returns appropriate layout pattern name and description.
 */
function inferLayoutStyle(
  sceneDesc?: string,
  theme?: string
): { name: string; description: string } {
  const text = (sceneDesc || theme || '').toLowerCase();

  if (/medieval|fantasy|village|organic|winding|rustic|forest|nature/i.test(text)) {
    return {
      name: 'ORGANIC',
      description: 'Winding paths, irregular intersections - rustic, natural feel',
    };
  }
  if (/cyberpunk|industrial|dystopia|neon|tech|noir|futuristic|sci-fi/i.test(text)) {
    return {
      name: 'INDUSTRIAL',
      description: 'Main corridor with service alleys - functional, asymmetric layout',
    };
  }
  if (/modern|corporate|urban|clean|grid|city/i.test(text)) {
    return {
      name: 'GRID',
      description: 'Clean perpendicular intersections - organized, efficient',
    };
  }
  return {
    name: 'GRID',
    description: 'Standard perpendicular layout - works for most themes',
  };
}

function getRoadSprites(metadata: SpritesheetMetadata): Sprite[] {
  return metadata.sprites.filter(
    (s) => s.category === 'ground' && s.connectivity?.connects?.length
  );
}

/**
 * Build the system prompt for roads phase.
 * Fully dynamic - all sprite info comes from metadata.
 * Includes visual context and layout style inference.
 */
function buildRoadsPrompt(
  width: number,
  height: number,
  metadata: SpritesheetMetadata,
  roadSprites: Sprite[],
  maxRoadTiles: number,
  sceneDescription?: string
): string {
  // Infer layout style from scene description
  const layoutStyle = inferLayoutStyle(sceneDescription, metadata.theme);

  // Format road sprites with connectivity info
  const roadSpritesList = roadSprites
    .map((s) => {
      const connects = s.connectivity?.connects ?? [];
      const type = s.connectivity?.type ?? 'unknown';
      return `  - ${s.id} (${type}): connects [${connects.join(', ')}]`;
    })
    .join('\n');

  // Find sprites by connectivity type for examples
  const findByType = (type: string) =>
    roadSprites.find((s) => s.connectivity?.type === type)?.id;
  const findByConnects = (dirs: readonly Direction[]) =>
    roadSprites.find((s) => {
      const connects = s.connectivity?.connects ?? [];
      return (
        dirs.every((d) => connects.includes(d)) &&
        connects.length === dirs.length
      );
    })?.id;

  // Build dynamic examples based on available sprites
  const horizontalSprite = findByConnects(['east', 'west']);
  const verticalSprite = findByConnects(['north', 'south']);
  const intersectionSprite = findByType('intersection');

  // Build visual context section from scene description
  const visualContext = sceneDescription
    ? `## WORLD VISION
${sceneDescription.substring(0, 400)}${sceneDescription.length > 400 ? '...' : ''}

Roads should match this visual theme and divide the map into thematic zones.

`
    : '';

  return `${visualContext}You are building roads on a ${width}x${height} map.

## LAYOUT STYLE: ${layoutStyle.name}
${layoutStyle.description}

## ROAD LAYOUT PATTERNS

**GRID** (modern/corporate): Clean perpendicular intersections, main avenue through center
**ORGANIC** (medieval/village): Winding main road, irregular intersections, dead ends
**INDUSTRIAL** (cyberpunk/dystopian): Main thoroughfare bisecting map, service alleys on edges

TOOLS AVAILABLE:
- placeRoad(x, y, spriteId) - Place a road tile at position
- connectRoads() - Auto-fix disconnected road segments
- viewMap(layer) - View current map state

COORDINATE SYSTEM:
- x: 0 to ${width - 1} (left to right)
- y: 0 to ${height - 1} (top to bottom)
- (0,0) is top-left corner

## SUGGESTED LAYOUT for ${width}x${height}:
- Primary road: Horizontal at y=${Math.floor(height / 2)}
- Secondary road: Vertical at x=${Math.floor(width / 2)}
- Creates 4 zones for building placement in Phase 3

ROAD SPRITES:
${roadSpritesList}

CONNECTIVITY RULES:
- Each sprite connects in specific directions (north, south, east, west)
- Use 'path' type sprites for straight segments
- Use 'corner' type sprites for turns
- Use 'intersection' type sprites where roads cross
- The placeRoad tool validates connectivity and suggests correct sprites if wrong

${horizontalSprite && verticalSprite && intersectionSprite ? `EXAMPLE - Cross intersection:
  0123456789
0 ..........
1 ....R.....  <- ${verticalSprite} at (4,1), (4,2)
2 ....R.....
3 RRRR+RRRRR  <- ${horizontalSprite}, ${intersectionSprite} at (4,3), ${horizontalSprite}
4 ....R.....  <- ${verticalSprite} at (4,4), (4,5)
5 ....R.....` : ''}

RULES:
- Every road MUST connect to another road
- Budget: ~${maxRoadTiles} road tiles max (~${Math.round((maxRoadTiles / (width * height)) * 100)}% of map)
- Roads overwrite existing ground tiles
- Roads DIVIDE the map into themed zones
- Use connectRoads at the end as a safety net`;
}
