/**
 * Objects Phase
 *
 * Places buildings and props on the map after ground and roads.
 * Uses placeAsset tool for the objects layer.
 */

import { streamText, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { Effect } from 'effect';
import type { GridState } from '../../lib/grid-state';
import type { SpritesheetMetadata, Sprite } from '../../types';
import { createPlaceAssetTool } from '../tools/place-asset';
import { createViewMapTool } from '../tools';
import { plannerError } from '../errors';

/**
 * Execute the objects placement phase.
 * Places buildings and props on the objects layer.
 */
export const executeObjectsPhase = Effect.fn('Planner.ObjectsPhase')(function*(
  grid: GridState,
  metadata: SpritesheetMetadata,
  width: number,
  height: number,
  verbose: boolean,
  sceneDescription?: string
) {
  if (verbose) yield* Effect.sync(() => console.log('[Objects Phase] Starting...'));

  const tools = {
    placeAsset: createPlaceAssetTool(grid, verbose),
    viewMap: createViewMapTool(grid),
  };

  const systemPrompt = buildObjectsPrompt(width, height, metadata, sceneDescription);

  yield* Effect.tryPromise({
    try: async () => {
      const result = streamText({
        model: google('gemini-2.0-flash'),
        system: systemPrompt,
        tools,
        stopWhen: stepCountIs(15),
        prompt: `Place buildings and props on the ${width}x${height} map.

Buildings should be placed 1 tile away from roads.
Props should be placed contextually (lamps near roads, benches in plazas, etc).`,
      });
      await result.text;
    },
    catch: (cause) =>
      plannerError('objects', 'Objects phase model/tool execution failed', cause),
  });

  if (verbose) {
    const stats = grid.getStats();
    yield* Effect.sync(() =>
      console.log(`[Objects Phase] Complete: ${stats.objectsFilled} objects placed`)
    );
  }
});

/**
 * Categorize props by their likely placement context.
 * Uses sprite ID patterns to group props into functional categories.
 */
function categorizeProps(props: Sprite[]): Record<string, string[]> {
  return {
    streetInfrastructure: props
      .filter((p) => /lamp|bench|sign|barrier|pole|hydrant/i.test(p.id))
      .map((p) => p.id),
    vendingFood: props
      .filter((p) => /vending|food|kiosk|ramen|container|cart/i.test(p.id))
      .map((p) => p.id),
    debris: props
      .filter((p) => /trash|debris|rubble|broken|cigarette|waste/i.test(p.id))
      .map((p) => p.id),
    nature: props
      .filter((p) => /tree|plant|moss|bonsai|flower|bush|grass/i.test(p.id))
      .map((p) => p.id),
    tech: props
      .filter((p) => /cable|pipe|terminal|camera|drone|ac|vent|antenna/i.test(p.id))
      .map((p) => p.id),
    atmospheric: props
      .filter((p) => /puddle|steam|flyer|graffiti|poster|neon/i.test(p.id))
      .map((p) => p.id),
  };
}

/**
 * Format prop categories into readable prompt section.
 */
function formatPropCategories(cats: Record<string, string[]>): string {
  const lines: string[] = [];
  if (cats.streetInfrastructure?.length) {
    lines.push(`- Street Infrastructure (along roads): ${cats.streetInfrastructure.join(', ')}`);
  }
  if (cats.vendingFood?.length) {
    lines.push(`- Vending/Food (near buildings): ${cats.vendingFood.join(', ')}`);
  }
  if (cats.debris?.length) {
    lines.push(`- Debris/Trash (back alleys): ${cats.debris.join(', ')}`);
  }
  if (cats.nature?.length) {
    lines.push(`- Nature/Plants (plazas, entrances): ${cats.nature.join(', ')}`);
  }
  if (cats.tech?.length) {
    lines.push(`- Tech/Infrastructure (walls, buildings): ${cats.tech.join(', ')}`);
  }
  if (cats.atmospheric?.length) {
    lines.push(`- Atmospheric Details (scattered): ${cats.atmospheric.join(', ')}`);
  }
  return lines.join('\n') || 'No categorized props found';
}

/**
 * Build the system prompt for objects phase.
 * Focused on building and prop placement with thematic guidance.
 * Includes visual context from scene description for coherent placement.
 */
function buildObjectsPrompt(
  width: number,
  height: number,
  metadata: SpritesheetMetadata,
  sceneDescription?: string
): string {
  // Extract and format buildings
  const buildings = metadata.sprites
    .filter((s) => s.category === 'building')
    .map((s) => `  - ${s.id}: ${s.description.substring(0, 50)}`)
    .join('\n');

  // Extract and categorize props
  const props = metadata.sprites.filter((s) => s.category === 'prop');
  const propCategories = categorizeProps(props);

  // Extract markers if any
  const markers = metadata.sprites
    .filter((s) => s.category === 'marker')
    .map((s) => `  - ${s.id}: ${s.description.substring(0, 50)}`)
    .join('\n');

  // Build visual context section from scene description
  const visualContext = sceneDescription
    ? `## WORLD VISION (Read carefully - this defines the MOOD!)
${sceneDescription}

Place objects to REINFORCE this vision. Every placement should feel intentional.

`
    : '';

  return `${visualContext}You are placing buildings and props on a ${width}x${height} map.

TOOLS AVAILABLE:
- placeAsset(x, y, assetId) - Place a building, prop, or marker
- viewMap(layer) - View current map state ('objects' layer shows B=building, P=prop)

COORDINATE SYSTEM:
- x: 0 to ${width - 1} (left to right)
- y: 0 to ${height - 1} (top to bottom)
- (0,0) is top-left corner

## BUILDINGS (place 1 tile AWAY from roads, facing them):
${buildings}

## PROPS BY CATEGORY:
${formatPropCategories(propCategories)}
${markers ? `\n## MARKERS:\n${markers}` : ''}

## THEMATIC PLACEMENT RULES (CRITICAL!)

### 1. ZONE-BASED CHARACTER
Roads divided the map into zones. Give each zone a distinct personality:
- **Commercial zone**: Clean props (benches, lamps, vending machines)
- **Back alley zone**: Gritty props (trash, debris, graffiti)
- **Tech zone**: Infrastructure (terminals, cameras, cables)
- **Plaza zone**: Social props (benches, plants, decorative elements)

### 2. CLUSTERING PRINCIPLE
Group 2-3 related props to create "micro-scenes":
- Food corner: vending machine + bench + trash can
- Surveillance point: camera + terminal + cables
- Decay scene: trash bags + debris + overgrown plants
- Rest area: bench + lamp + planter

### 3. BUILDING CONTEXT
Props near buildings should make sense:
- Food shops → containers, seating nearby
- Tech buildings → terminals, cables outside
- Corporate → cameras, clean surroundings
- Abandoned → trash, graffiti, decay

### 4. DENSITY GRADIENT
- **Dense**: Near roads and building entrances
- **Moderate**: Along walkways
- **Sparse**: In corners and negative space
- **Never**: On roads themselves

### 5. ENVIRONMENTAL STORYTELLING
Create small narratives through placement:
- "Someone ate here": food container near bench
- "Being watched": camera overlooking terminal
- "Nature reclaiming": plants growing through debris

DON'T scatter props randomly. Create INTENTIONAL, THEMED compositions.`;
}
